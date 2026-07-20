const { app, BrowserWindow, ipcMain, screen, dialog, nativeImage, shell, Notification } = require('electron');
const { Client: DiscordRPCClient } = require('@xhayper/discord-rpc');
app.setName('Mediyyu');
app.setAppUserModelId('Mediyyu');
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ffmpegPath = app.isPackaged
  ? require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  : require('ffmpeg-static');

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac|mp4|webm|mov|m4v)$/i;
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4' };
function findAudioArg(argv) {
  return argv.find(a => AUDIO_EXT_RE.test(a) && fs.existsSync(a));
}
function sendOpenFile(win, filePath) {
  try {
    const data = fs.readFileSync(filePath);
    const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    win.webContents.send('open-file', { name: path.basename(filePath), mime: AUDIO_MIME[ext] || 'audio/mpeg', data: arrayBuffer, path: filePath });
  } catch (err) {
    console.error('[open-file]', err.message);
  }
}

if (process.env.MEDIYYU_TEST_PROFILE) {
  app.setPath('userData', path.join(os.tmpdir(), 'mediyyu-test-profile'));
}

const LOG_MAX = 512 * 1024;
function logError(source, msg) {
  try {
    const file = path.join(app.getPath('userData'), 'error.log');
    try { if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + '.old'); } catch {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] [${source}] ${msg}\n`);
  } catch {}
}
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  logError('main', (err && err.stack) || String(err));
});
process.on('unhandledRejection', (reason) => {
  logError('main', 'unhandled rejection: ' + ((reason && reason.stack) || String(reason)));
});
ipcMain.on('log:error', (e, msg) => logError('renderer', String(msg).slice(0, 4000)));

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

function animateBounds(win, from, to, duration, ease, onProgress) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (win.isDestroyed()) return resolve();
      const t = Math.min(1, (Date.now() - start) / duration);
      const e = ease(t);
      win.setBounds({
        x: Math.round(from.x + (to.x - from.x) * e),
        y: Math.round(from.y + (to.y - from.y) * e),
        width: Math.round(from.width + (to.width - from.width) * e),
        height: Math.round(from.height + (to.height - from.height) * e),
      });
      if (onProgress) onProgress(e);
      if (t < 1) setTimeout(tick, 1000 / 60);
      else resolve();
    };
    tick();
  });
}
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInQuad = (t) => t * t;

const normalBoundsMap = new WeakMap();
const edgeToEdge = new WeakSet();
const animating = new WeakSet();
function trackNormalBounds(win) {
  const maybeTrack = () => {
    if (!animating.has(win) && !edgeToEdge.has(win) && !win.isMaximized() && !win.isMinimized()) normalBoundsMap.set(win, win.getBounds());
  };
  win.on('resize', maybeTrack);
  win.on('move', maybeTrack);
  normalBoundsMap.set(win, win.getBounds());
}

function applyDisplayMode(win, mode) {
  if (win.isMaximized()) win.unmaximize();
  if (mode === 'fullscreen') {
    edgeToEdge.add(win);
    if (win.isFullScreen()) return;
    win.setFullScreen(true);
  } else if (mode === 'borderless') {
    if (win.isFullScreen()) win.setFullScreen(false);
    edgeToEdge.add(win);
    const { bounds } = screen.getDisplayMatching(win.getBounds());
    win.setResizable(false);
    win.setBounds(bounds);
  } else {
    if (win.isFullScreen()) win.setFullScreen(false);
    edgeToEdge.delete(win);
    const normal = normalBoundsMap.get(win) || win.getNormalBounds();
    win.setResizable(true);
    win.setBounds(normal);
  }
}

async function animateMaximize(win) {
  const from = win.getBounds();
  normalBoundsMap.set(win, from);
  animating.add(win);
  const { workArea } = screen.getDisplayMatching(from);
  await animateBounds(win, from, workArea, 220, easeOutCubic);
  if (!win.isDestroyed()) win.maximize();
  animating.delete(win);
}

async function animateRestore(win) {
  const full = win.getBounds();
  const normal = normalBoundsMap.get(win) || win.getNormalBounds();
  animating.add(win);
  win.unmaximize();
  await animateBounds(win, full, normal, 220, easeOutCubic);
  animating.delete(win);
}

async function animateMinimize(win) {
  const from = win.getBounds();
  const w = 60, h = 8;
  const to = { x: Math.round(from.x + from.width / 2 - w / 2), y: from.y + from.height - h, width: w, height: h };
  animating.add(win);
  await animateBounds(win, from, to, 200, easeInQuad, (e) => win.setOpacity(Math.max(0.05, 1 - e)));
  animating.delete(win);
  if (win.isDestroyed()) return;
  win.once('restore', () => {
    win.setOpacity(1);
    win.setBounds(from);
  });
  win.minimize();
}

function defaultWindowSize() {
  const { width, height } = screen.getPrimaryDisplay().size;
  return {
    width: Math.round(width * (1514 / 1920)),
    height: Math.round(height * (790 / 1080)),
  };
}

let mainWindow = null;

function createWindow() {
  const win = new BrowserWindow({
    title: 'Mediyyu',
    ...defaultWindowSize(),
    minWidth: 480,
    minHeight: 320,
    frame: false,
    transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.close();
  });

  let closeAnimated = false;
  win.on('close', (e) => {
    if (closeAnimated) return;
    e.preventDefault();
    closeAnimated = true;
    win.webContents.send('app:fadeout');
    const start = Date.now();
    const dur = 320;
    const tick = () => {
      if (win.isDestroyed()) return;
      const t = Math.min(1, (Date.now() - start) / dur);
      win.setOpacity(1 - t);
      if (t < 1) setTimeout(tick, 16);
      else win.close();
    };
    tick();
  });

  win.loadFile('Visualizer.html');
  win.webContents.on('preload-error', (e, preloadPath, error) => console.error('[PRELOAD ERROR]', preloadPath, error));
  if (process.env.DEBUG_VIZ) win.webContents.openDevTools({ mode: 'detach' });
  trackNormalBounds(win);

  let coldStartFileHandled = false;
  win.webContents.on('did-finish-load', () => {
    if (coldStartFileHandled) return;
    coldStartFileHandled = true;
    const filePath = findAudioArg(process.argv);
    if (filePath) sendOpenFile(win, filePath);
  });

  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));

  win.on('will-move', (event, newBounds) => {
    if (animating.has(win) || !win.isMaximized()) return;
    event.preventDefault();
    const cursor = screen.getCursorScreenPoint();
    const maximizedBounds = win.getBounds();
    const normal = normalBoundsMap.get(win) || win.getNormalBounds();
    const ratioX = (cursor.x - maximizedBounds.x) / maximizedBounds.width;
    win.unmaximize();
    win.setBounds({
      x: Math.round(cursor.x - ratioX * normal.width),
      y: Math.round(cursor.y - 10),
      width: normal.width,
      height: normal.height,
    });
  });
}

let lyricsWin = null;
function createLyricsWindow() {
  if (lyricsWin && !lyricsWin.isDestroyed()) { lyricsWin.focus(); return; }
  lyricsWin = new BrowserWindow({
    width: 400, height: 560, minWidth: 260, minHeight: 220,
    frame: false, transparent: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  lyricsWin.loadFile('lyrics.html');
  lyricsWin.on('closed', () => {
    lyricsWin = null;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyrwin:state', false);
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyrwin:state', true);
}
ipcMain.on('lyrwin:toggle', () => {
  if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.close();
  else createLyricsWindow();
});
ipcMain.on('lyrwin:set', (e, open) => {
  if (open) createLyricsWindow();
  else if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.close();
});
ipcMain.on('lyrwin:sync', (e, payload) => {
  if (lyricsWin && !lyricsWin.isDestroyed()) lyricsWin.webContents.send('lyrwin:sync', payload);
});
ipcMain.on('lyrwin:seek', (e, t) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('lyrwin:seek', t);
});
ipcMain.on('lyrwin:setTop', (e, flag) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.setAlwaysOnTop(!!flag);
});
ipcMain.on('lyrwin:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w) w.close();
});

let discordClient = null;
let discordClientId = null;

async function discordDisconnect() {
  discordClientId = null;
  const client = discordClient;
  discordClient = null;
  if (client) { try { await client.destroy(); } catch {} }
}

async function discordConnect(clientId) {
  if (!clientId) { await discordDisconnect(); return; }
  if (discordClient && discordClientId === clientId && discordClient.isConnected) return;
  await discordDisconnect();
  discordClientId = clientId;
  const client = new DiscordRPCClient({ clientId });
  discordClient = client;
  try {
    await client.login();
  } catch (err) {
    console.error('[discord]', err.message);
    if (discordClient === client) discordClient = null;
  }
}

app.on('second-instance', (event, argv) => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const filePath = findAudioArg(argv);
  if (filePath) sendOpenFile(mainWindow, filePath);
});

app.whenReady().then(createWindow);

const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
const sendUpdate = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
autoUpdater.on('update-available', (info) => sendUpdate('update:available', { version: info.version, portable: isPortable }));
autoUpdater.on('download-progress', (p) => sendUpdate('update:progress', Math.round(p.percent)));
autoUpdater.on('update-downloaded', () => sendUpdate('update:downloaded'));
autoUpdater.on('error', (err) => {
  console.error('[updater]', err.message);
  sendUpdate('update:error', err.message);
});
if (app.isPackaged) {
  app.whenReady().then(() => {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  });
}
ipcMain.on('update:download', () => { autoUpdater.downloadUpdate().catch(() => {}); });
ipcMain.on('update:install', () => { autoUpdater.quitAndInstall(); });
ipcMain.on('update:openReleases', () => { shell.openExternal('https://github.com/Darkyyyyy/Mediyyu/releases/latest'); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  discordDisconnect();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.on('app:getVersion', (e) => { e.returnValue = app.getVersion(); });
ipcMain.on('win:minimize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !animating.has(win)) animateMinimize(win);
});
ipcMain.on('win:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win && !animating.has(win)) (win.isMaximized() ? animateRestore(win) : animateMaximize(win));
});
ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('win:setAlwaysOnTop', (e, flag) => BrowserWindow.fromWebContents(e.sender)?.setAlwaysOnTop(!!flag));
ipcMain.on('win:setResizable', (e, flag) => BrowserWindow.fromWebContents(e.sender)?.setResizable(!!flag));
ipcMain.on('win:setDisplayMode', (e, mode) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) applyDisplayMode(win, mode);
});
const thumbarIcons = new WeakMap();
function applyThumbar(win, playing) {
  if (process.platform !== 'win32') return false;
  const ic = thumbarIcons.get(win);
  if (!ic) return false;
  return win.setThumbarButtons([
    { tooltip: 'previous track', icon: ic.prev, click: () => win.webContents.send('media:prev') },
    { tooltip: playing ? 'pause' : 'play', icon: playing ? ic.pause : ic.play, click: () => win.webContents.send('media:playpause') },
    { tooltip: 'next track', icon: ic.next, click: () => win.webContents.send('media:next') },
  ]);
}
ipcMain.handle('thumbar:init', (e, icons) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return false;
  thumbarIcons.set(win, {
    prev: nativeImage.createFromDataURL(icons.prev),
    play: nativeImage.createFromDataURL(icons.play),
    pause: nativeImage.createFromDataURL(icons.pause),
    next: nativeImage.createFromDataURL(icons.next),
  });
  return applyThumbar(win, false);
});
ipcMain.handle('thumbar:playing', (e, playing) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? applyThumbar(win, !!playing) : false;
});

let notifIcon = null;
function getNotifIcon() {
  if (notifIcon === null) {
    try { notifIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'logo.png')); }
    catch (e) { notifIcon = undefined; }
  }
  return notifIcon || undefined;
}
ipcMain.on('notify:show', (e, { title, body }) => {
  if (!Notification.isSupported()) return;
  try { new Notification({ title: title || 'Mediyyu', body: body || '', icon: getNotifIcon(), silent: true }).show(); } catch (err) {}
});

const shaking = new WeakSet();
ipcMain.on('win:shake', (e, intensity) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isFullScreen() || shaking.has(win)) return;
  shaking.add(win);
  animating.add(win);
  const base = win.getBounds();
  let amp = Math.max(2, Math.min(30, +intensity || 10));
  const tick = () => {
    if (win.isDestroyed()) return;
    amp *= 0.82;
    if (amp < 1) {
      win.setPosition(base.x, base.y);
      animating.delete(win);
      shaking.delete(win);
      return;
    }
    win.setPosition(
      base.x + Math.round((Math.random() - 0.5) * 2 * amp),
      base.y + Math.round((Math.random() - 0.5) * 2 * amp)
    );
    setTimeout(tick, 16);
  };
  tick();
});
const miniPrevBounds = new WeakMap();
ipcMain.on('win:setMiniMode', (e, flag) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  if (flag) {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    miniPrevBounds.set(win, normalBoundsMap.get(win) || win.getNormalBounds());
    edgeToEdge.add(win);
    win.setMinimumSize(300, 88);
    win.setResizable(false);
    win.setAlwaysOnTop(true);
    const { workArea } = screen.getDisplayMatching(win.getBounds());
    win.setBounds({ x: workArea.x + workArea.width - 376, y: workArea.y + workArea.height - 112, width: 360, height: 96 });
  } else {
    win.setMinimumSize(480, 320);
    win.setResizable(true);
    win.setAlwaysOnTop(false);
    const prev = miniPrevBounds.get(win);
    miniPrevBounds.delete(win);
    if (prev) win.setBounds(prev);
    edgeToEdge.delete(win);
  }
});
ipcMain.on('file:showInFolder', (e, p) => {
  if (p && typeof p === 'string' && fs.existsSync(p)) shell.showItemInFolder(p);
});
function buildTagArgs(tags, ext) {
  const t = tags || {};
  const meta = [];
  const put = (k, v) => { if (v != null) meta.push('-metadata', k + '=' + v); };
  put('title', t.title); put('artist', t.artist); put('album', t.album);
  put('album_artist', t.albumArtist); put('composer', t.composer);
  put('track', t.track); put('disc', t.disc); put('date', t.year);
  put('genre', t.genre); put('comment', t.comment);
  if (t.bpm) { meta.push('-metadata', 'TBPM=' + t.bpm, '-metadata', 'bpm=' + t.bpm); }
  const extra = /\.mp3$/i.test(ext) ? ['-id3v2_version', '3', '-write_id3v1', '1'] : [];
  return { meta, extra };
}
function runFfmpeg(args) {
  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, args);
    let errOut = '';
    ff.stderr.on('data', d => { errOut += d.toString(); });
    ff.on('close', code => resolve({ code, errOut }));
    ff.on('error', err => resolve({ code: -1, errOut: err.message }));
  });
}
ipcMain.handle('file:writeTags', async (e, { path: srcPath, buffer, name, tags }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    if (srcPath && fs.existsSync(srcPath)) {
      const ext = path.extname(srcPath) || '.mp3';
      const { meta, extra } = buildTagArgs(tags, ext);
      const tmpOut = srcPath + '.tagtmp' + ext;
      const result = await runFfmpeg(['-y', '-i', srcPath, '-map', '0', '-c', 'copy', ...meta, ...extra, tmpOut]);
      if (result.code !== 0) { try { fs.unlinkSync(tmpOut); } catch (e2) {} return { error: result.errOut.slice(-400) }; }
      let replaced = false, lastErr = null;
      for (let i = 0; i < 6 && !replaced; i++) {
        try { fs.rmSync(srcPath); fs.renameSync(tmpOut, srcPath); replaced = true; }
        catch (e2) { lastErr = e2; await new Promise(res => setTimeout(res, 150)); }
      }
      if (!replaced) {
        try { fs.unlinkSync(tmpOut); } catch (e2) {}
        return { error: 'could not replace the original file (it may be locked): ' + (lastErr && lastErr.message) };
      }
      return { ok: true, inPlace: true };
    }
    if (!buffer) return { error: 'no input file' };
    const ext = path.extname(name || '.mp3') || '.mp3';
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: name || ('tagged' + ext),
      filters: [{ name: 'audio', extensions: [ext.replace('.', '') || 'mp3'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const tmpInput = path.join(os.tmpdir(), 'mediyyu-tagsrc-' + Date.now() + ext);
    fs.writeFileSync(tmpInput, Buffer.from(buffer));
    const { meta, extra } = buildTagArgs(tags, ext);
    const tmpOut = filePath + '.tagtmp' + ext;
    const result = await runFfmpeg(['-y', '-i', tmpInput, '-map', '0', '-c', 'copy', ...meta, ...extra, tmpOut]);
    try { fs.unlinkSync(tmpInput); } catch (e2) {}
    if (result.code !== 0) { try { fs.unlinkSync(tmpOut); } catch (e2) {} return { error: result.errOut.slice(-400) }; }
    if (fs.existsSync(filePath)) fs.rmSync(filePath);
    fs.renameSync(tmpOut, filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('audio:transcode', async (e, { path: srcPath, buffer, name }) => {
  let tempInput = null;
  let tempOutput = null;
  try {
    let inputPath = srcPath && fs.existsSync(srcPath) ? srcPath : null;
    if (!inputPath) {
      if (!buffer) return { error: 'no input file' };
      const ext = path.extname(name || '') || '.m4a';
      tempInput = path.join(os.tmpdir(), 'mediyyu-transcode-src-' + Date.now() + ext);
      fs.writeFileSync(tempInput, Buffer.from(buffer));
      inputPath = tempInput;
    }
    tempOutput = path.join(os.tmpdir(), 'mediyyu-transcode-out-' + Date.now() + '.wav');
    const result = await runFfmpeg(['-y', '-i', inputPath, '-vn', '-f', 'wav', tempOutput]);
    if (result.code !== 0) return { error: result.errOut.slice(-400) || 'conversion failed' };
    const data = fs.readFileSync(tempOutput);
    return { ok: true, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch (err) {
    return { error: err.message };
  } finally {
    if (tempInput) { try { fs.unlinkSync(tempInput); } catch (e2) {} }
    if (tempOutput) { try { fs.unlinkSync(tempOutput); } catch (e2) {} }
  }
});
ipcMain.handle('url:fetchAudio', async (e, url) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': '*/*',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return { error: 'http ' + res.status };
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (mime === 'text/html') return { error: 'that url returns a web page, not an audio file - use a direct file link' };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 300 * 1024 * 1024) return { error: 'file too large (300mb max)' };
    let name = '';
    const disp = res.headers.get('content-disposition') || '';
    const dm = disp.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
    if (dm) { try { name = decodeURIComponent(dm[1].trim()); } catch (err) { name = dm[1].trim(); } }
    if (!name) { try { name = decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || ''); } catch (err) {} }
    if (!name) name = 'remote audio';
    return {
      name,
      mime,
      data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timed out' : (err.cause && err.cause.message) || err.message };
  }
});
ipcMain.handle('lyrics:findLocal', async (e, audioPath) => {
  try {
    if (!audioPath || typeof audioPath !== 'string') return null;
    const base = audioPath.replace(/\.[^.\\/]+$/, '');
    for (const ext of ['lrc', 'vtt']) {
      const p = base + '.' + ext;
      if (fs.existsSync(p)) return { kind: ext, text: fs.readFileSync(p, 'utf8') };
    }
    return null;
  } catch { return null; }
});
const lrclibUA = () => `Mediyyu v${app.getVersion()} (https://github.com/Darkyyyyy/Mediyyu)`;
ipcMain.handle('lyrics:fetch', async (e, { artist, title, album, duration, suggestOnly }) => {
  try {
    const q = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const opts = { headers: { 'User-Agent': lrclibUA() }, signal: controller.signal };
    const seen = new Set();
    const suggestions = [];
    const collect = (list) => {
      for (const it of Array.isArray(list) ? list : []) {
        if (it && it.syncedLyrics && !seen.has(it.id)) {
          seen.add(it.id);
          suggestions.push({ id: it.id, trackName: it.trackName || '', artistName: it.artistName || '', albumName: it.albumName || '', duration: it.duration || 0, synced: it.syncedLyrics });
        }
      }
    };
    const fetchList = async (params) => {
      try {
        const s = await fetch('https://lrclib.net/api/search?' + q(params), opts);
        if (s.ok) return await s.json();
      } catch {}
      return [];
    };
    let exact = null;
    if (!suggestOnly) {
      const r = await fetch('https://lrclib.net/api/get?' + q({ artist_name: artist, track_name: title, album_name: album, duration: duration ? Math.round(duration) : null }), opts);
      if (r.ok) {
        const j = await r.json();
        if (j.syncedLyrics || j.plainLyrics) exact = { synced: j.syncedLyrics || '', plain: j.plainLyrics || '' };
      }
    }
    if (suggestOnly || !exact || !exact.synced) {
      const [byMeta, byQuery, byTitle] = await Promise.all([
        fetchList({ artist_name: artist, track_name: title }),
        artist && title ? fetchList({ q: artist + ' ' + title }) : [],
        title ? fetchList({ q: title }) : [],
      ]);
      collect(byMeta);
      if (!suggestOnly) {
        const close = duration ? suggestions.filter(x => x.duration && Math.abs(x.duration - duration) <= 7) : [];
        if (close.length) {
          close.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
          exact = { synced: close[0].synced, plain: '' };
        }
      }
      if (suggestOnly || !exact) {
        collect(byQuery);
        if (suggestions.length < 8) collect(byTitle);
      }
    }
    clearTimeout(timeout);
    return {
      synced: exact ? exact.synced : '',
      plain: exact ? exact.plain : '',
      suggestions: !suggestOnly && exact && exact.synced ? [] : suggestions.slice(0, 8),
    };
  } catch { return null; }
});
ipcMain.handle('lyrics:fetchById', async (e, id) => {
  try {
    const r = await fetch('https://lrclib.net/api/get/' + encodeURIComponent(id), { headers: { 'User-Agent': lrclibUA() } });
    if (!r.ok) return null;
    const j = await r.json();
    return { synced: j.syncedLyrics || '', plain: j.plainLyrics || '' };
  } catch { return null; }
});

ipcMain.handle('files:scanDir', async (e, dirPath) => {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8 || out.length >= 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= 2000) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (AUDIO_EXT_RE.test(ent.name)) out.push(p);
    }
  };
  try {
    if (dirPath && typeof dirPath === 'string' && fs.statSync(dirPath).isDirectory()) walk(dirPath, 0);
  } catch {}
  return out;
});
ipcMain.handle('session:readFiles', async (e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const idx = next++;
      const p = list[idx];
      try {
        if (!p || typeof p !== 'string' || !fs.existsSync(p)) continue;
        const data = await fs.promises.readFile(p);
        const ext = path.extname(p).slice(1).toLowerCase();
        out[idx] = {
          name: path.basename(p),
          mime: AUDIO_MIME[ext] || 'audio/mpeg',
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          path: p,
        };
      } catch (err) {}
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return out.filter(Boolean);
});
ipcMain.on('discord:connect', (e, clientId) => { discordConnect(clientId); });
ipcMain.on('discord:disconnect', () => { discordDisconnect(); });
ipcMain.on('discord:setActivity', (e, activity) => {
  if (!discordClient || !discordClient.isConnected) return;
  discordClient.user?.setActivity(activity).catch(() => {});
});
ipcMain.on('discord:clearActivity', () => {
  if (!discordClient || !discordClient.isConnected) return;
  discordClient.user?.clearActivity().catch(() => {});
});
ipcMain.handle('discord:lookupCover', async (e, { artist, album }) => {
  if (!album) return null;
  const term = [artist, album].filter(Boolean).join(' ');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    const art = data.results && data.results[0] && data.results[0].artworkUrl100;
    return art ? art.replace('100x100bb.jpg', '512x512bb.jpg') : null;
  } catch (err) {
    return null;
  }
});

const _sc = Buffer.from('OTllNjhiNjhlNjNmYzBkN2E1MDZlNWY1ZDQ3YjJlYjM6MWE5MzdiYjBlYzQwNTQyNjQ5M2UwNzBmMDE3YzlhOGE=', 'base64').toString('utf8').split(':');
const SCROBBLE_API = 'https://ws.audioscrobbler.com/2.0/';
function scrobbleSign(params) {
  const keys = Object.keys(params).filter(k => k !== 'format').sort();
  let str = '';
  for (const k of keys) str += k + params[k];
  str += _sc[1];
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}
async function scrobbleCall(method, params, usePost) {
  const full = { method, api_key: _sc[0], ...params };
  const api_sig = scrobbleSign(full);
  const allParams = { ...full, api_sig, format: 'json' };
  const qs = Object.entries(allParams).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const r = usePost
    ? await fetch(SCROBBLE_API, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: qs })
    : await fetch(SCROBBLE_API + '?' + qs);
  return r.json();
}
ipcMain.handle('scrobble:getAuthUrl', async () => {
  try {
    const data = await scrobbleCall('auth.getToken', {});
    if (!data.token) return { error: (data.message || 'could not get a token') };
    return { token: data.token, url: `https://www.last.fm/api/auth/?api_key=${_sc[0]}&token=${data.token}` };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('scrobble:completeAuth', async (e, token) => {
  try {
    const data = await scrobbleCall('auth.getSession', { token });
    if (data.session && data.session.key) return { key: data.session.key, username: data.session.name };
    return { error: (data.message || "not authorized yet — click allow access in the browser first.") };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('scrobble:updateNowPlaying', async (e, { sessionKey, artist, track, album, duration }) => {
  if (!sessionKey || !artist || !track) return { error: 'missing fields' };
  try {
    const params = { artist, track, sk: sessionKey };
    if (album) params.album = album;
    if (duration) params.duration = Math.round(duration);
    return await scrobbleCall('track.updateNowPlaying', params, true);
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('scrobble:track', async (e, { sessionKey, artist, track, album, timestamp }) => {
  if (!sessionKey || !artist || !track || !timestamp) return { error: 'missing fields' };
  try {
    const params = { artist, track, timestamp, sk: sessionKey };
    if (album) params.album = album;
    return await scrobbleCall('track.scrobble', params, true);
  } catch (err) { return { error: err.message }; }
});
ipcMain.on('scrobble:openAuth', (e, url) => {
  if (typeof url === 'string' && url.startsWith('https://www.last.fm/api/auth/')) shell.openExternal(url);
});

const QUALITY_PRESETS = {
  fast: { preset: 'ultrafast', crf: 23 },
  balanced: { preset: 'veryfast', crf: 20 },
  high: { preset: 'slow', crf: 16 },
};

ipcMain.handle('rec:export', async (e, { buffer, suggestedName, duration, fps, quality }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: 'mp4 video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return { canceled: true };

  const tempWebm = path.join(os.tmpdir(), `bbv-rec-${Date.now()}.webm`);
  fs.writeFileSync(tempWebm, Buffer.from(buffer));

  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.balanced;
  const outFps = [30, 60].includes(fps) ? fps : 60;

  return new Promise((resolve) => {
    const ff = spawn(ffmpegPath, [
      '-y', '-i', tempWebm,
      '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf), '-pix_fmt', 'yuv420p',
      '-fps_mode', 'cfr', '-r', String(outFps),
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-progress', 'pipe:1', '-nostats',
      filePath,
    ]);
    let progressBuf = '';
    ff.stdout.on('data', (d) => {
      if (!(duration > 0)) return;
      progressBuf += d.toString();
      const match = progressBuf.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
      if (match && match.length) {
        const last = match[match.length - 1];
        const [, h, m, s] = last.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        const sec = (+h) * 3600 + (+m) * 60 + parseFloat(s);
        const percent = Math.min(100, Math.round((sec / duration) * 100));
        win.webContents.send('rec:progress', percent);
      }
      if (progressBuf.length > 4000) progressBuf = progressBuf.slice(-2000);
    });
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });
    ff.on('close', (code) => {
      try { fs.unlinkSync(tempWebm); } catch (err) {}
      if (code === 0) { win.webContents.send('rec:progress', 100); resolve({ canceled: false, filePath }); }
      else resolve({ canceled: false, error: stderr.slice(-2000) });
    });
    ff.on('error', (err) => {
      try { fs.unlinkSync(tempWebm); } catch (e2) {}
      resolve({ canceled: false, error: err.message });
    });
  });
});
