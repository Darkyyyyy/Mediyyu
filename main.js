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

function loadDotEnv() {
  const spots = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(app.getPath('exe')), '.env'),
    path.join(app.getAppPath(), '.env'),
  ];
  for (const spot of spots) {
    let text = null;
    try { if (fs.existsSync(spot)) text = fs.readFileSync(spot, 'utf8'); } catch (err) {}
    if (!text) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      const quote = value[0];
      if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) value = value.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
loadDotEnv();
const envPair = (key) => {
  const a = (process.env[key + '_KEY'] || '').trim();
  const b = (process.env[key + '_SECRET'] || '').trim();
  return a && b ? [a, b] : null;
};

const ffmpegPath = app.isPackaged
  ? require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked')
  : require('ffmpeg-static');

const AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|flac|aac|mp4|webm|mov|m4v|mid|midi)$/i;
const AUDIO_MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4', mid: 'audio/midi', midi: 'audio/midi' };
function findAudioArg(argv) {
  return argv.find(a => AUDIO_EXT_RE.test(a) && fs.existsSync(a));
}
const PRESET_EXT_RE = /\.mdyp$/i;
const PRESET_MAX_BYTES = 1024 * 1024;
function findPresetArg(argv) {
  return argv.find(a => PRESET_EXT_RE.test(a) && fs.existsSync(a));
}
function readPresetFile(filePath) {
  try {
    if (fs.statSync(filePath).size > PRESET_MAX_BYTES) return { error: "this file is too big to be a mediyyu preset." };
    return { text: fs.readFileSync(filePath, 'utf8'), path: filePath };
  } catch (err) {
    return { error: "couldn't read the preset file: " + err.message };
  }
}
function sendOpenPreset(win, filePath) {
  const r = readPresetFile(filePath);
  if (r.error) console.error('[open-preset]', r.error);
  else win.webContents.send('preset:open', r);
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

function blockNativeFullscreenKey(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') e.preventDefault();
  });
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

function createWindow(opts = {}) {
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

  let rendererGone = false;
  let crashTimes = [];
  let recovering = false;
  win.webContents.on('render-process-gone', (e, details) => {
    rendererGone = true;
    logError('main', `renderer gone: ${details.reason} (exit code ${details.exitCode})`);
    if (closeAnimated || win.isDestroyed() || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimes = crashTimes.filter(t => now - t < 60000).concat(now);
    if (crashTimes.length > 3) {
      logError('main', 'renderer keeps crashing, giving up on reloading it');
      win.close();
      return;
    }
    recovering = true;
    win.webContents.reload();
  });
  win.webContents.on('did-finish-load', () => {
    rendererGone = false;
    if (recovering) { recovering = false; win.webContents.send('app:recovered'); }
  });

  let closeAnimated = false;
  win.on('close', (e) => {
    if (closeAnimated) return;
    closeAnimated = true;
    if (rendererGone || win.webContents.isLoading()) return;
    e.preventDefault();
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
  blockNativeFullscreenKey(win);
  win.webContents.on('preload-error', (e, preloadPath, error) => console.error('[PRELOAD ERROR]', preloadPath, error));
  if (process.env.DEBUG_VIZ) win.webContents.openDevTools({ mode: 'detach' });
  trackNormalBounds(win);

  let coldStartFileHandled = false;
  win.webContents.on('did-finish-load', () => {
    if (coldStartFileHandled) return;
    coldStartFileHandled = true;
    const filePath = findAudioArg(process.argv);
    if (filePath) sendOpenFile(win, filePath);
    if (opts.presetPath) sendOpenPreset(win, opts.presetPath);
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
let lyrHoverTimer = null;
let lyrHoverLast = null;
function stopLyricsHoverWatch() {
  if (lyrHoverTimer) { clearInterval(lyrHoverTimer); lyrHoverTimer = null; }
  lyrHoverLast = null;
}
function startLyricsHoverWatch() {
  stopLyricsHoverWatch();
  lyrHoverTimer = setInterval(() => {
    if (!lyricsWin || lyricsWin.isDestroyed()) return stopLyricsHoverWatch();
    let inside = false;
    try {
      const pt = screen.getCursorScreenPoint();
      const b = lyricsWin.getBounds();
      const edge = 6;
      inside = pt.x >= b.x - edge && pt.x <= b.x + b.width + edge
        && pt.y >= b.y - edge && pt.y <= b.y + b.height + edge;
    } catch (err) {}
    if (inside === lyrHoverLast) return;
    lyrHoverLast = inside;
    try { lyricsWin.webContents.send('lyrwin:hover', inside); } catch (err) {}
  }, 120);
}
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
  startLyricsHoverWatch();
  blockNativeFullscreenKey(lyricsWin);
  lyricsWin.on('closed', () => {
    stopLyricsHoverWatch();
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

function discordLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('discord:log', { ts: Date.now(), msg });
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
    discordLog(`connected to discord (client id ${clientId})`);
  } catch (err) {
    console.error('[discord]', err.message);
    discordLog(`discord login failed: ${err.message}`);
    if (discordClient === client) discordClient = null;
  }
}

app.on('second-instance', (event, argv) => {
  const presetPath = findPresetArg(argv);
  if (!mainWindow) {
    if (!presetWin) return;
    if (!presetPath && !findAudioArg(argv)) { openAppFromPresetWin(); return; }
    if (presetPath) { presetWinPath = presetPath; presetWin.webContents.reload(); }
    presetWin.focus();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  const filePath = findAudioArg(argv);
  if (filePath) sendOpenFile(mainWindow, filePath);
  if (presetPath) sendOpenPreset(mainWindow, presetPath);
});

// ── preset import popup ──────────────────────────────────────────────────────
let presetWin = null;
let presetWinPath = null;
function createPresetWindow(filePath) {
  presetWinPath = filePath;
  presetWin = new BrowserWindow({
    title: 'Mediyyu — import preset',
    width: 460, height: 420, useContentSize: true,
    resizable: false, maximizable: false, fullscreenable: false,
    frame: false, transparent: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
    },
  });
  presetWin.loadFile('preset-import.html');
  blockNativeFullscreenKey(presetWin);
  presetWin.on('closed', () => { presetWin = null; });
}
function openAppFromPresetWin() {
  const pending = presetWinPath;
  if (!mainWindow) createWindow({ presetPath: pending });
  if (presetWin && !presetWin.isDestroyed()) presetWin.close();
}
ipcMain.handle('presetwin:data', () => (presetWinPath ? readPresetFile(presetWinPath) : { error: 'no preset file.' }));
ipcMain.on('presetwin:fit', (e, height) => {
  if (!presetWin || presetWin.isDestroyed()) return;
  const h = Math.max(200, Math.min(Math.round(Number(height) || 420), screen.getPrimaryDisplay().workAreaSize.height - 80));
  presetWin.setContentSize(460, h);
  presetWin.center();
  if (!presetWin.isVisible()) presetWin.show();
});
ipcMain.on('presetwin:openApp', () => { presetWinPath = null; openAppFromPresetWin(); });

ipcMain.handle('preset:export', async (e, { fileName, text }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), String(fileName || 'preset.mdyp')),
      filters: [{ name: 'Mediyyu preset', extensions: ['mdyp'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await fs.promises.writeFile(filePath, String(text), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle('files:exists', (e, p) => {
  try { return typeof p === 'string' && !!p && fs.existsSync(p); } catch { return false; }
});

let pendingMacPreset = null;
app.on('open-file', (event, filePath) => {
  if (!PRESET_EXT_RE.test(filePath)) return;
  event.preventDefault();
  if (!app.isReady()) { pendingMacPreset = filePath; return; }
  if (mainWindow) { mainWindow.focus(); sendOpenPreset(mainWindow, filePath); }
  else if (presetWin) { presetWinPath = filePath; presetWin.webContents.reload(); presetWin.focus(); }
  else createPresetWindow(filePath);
});

app.whenReady().then(() => {
  const presetPath = pendingMacPreset || findPresetArg(process.argv);
  if (presetPath && !findAudioArg(process.argv)) createPresetWindow(presetPath);
  else createWindow({ presetPath });
});

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
function updaterCacheDir() {
  const base = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches')
      : (process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'));
  return path.join(base, 'mediyyu-updater');
}
const versionParts = (v) => String(v).split('.').map(n => parseInt(n, 10) || 0);
function versionAtMost(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return true;
}
function clearInstalledPendingUpdate() {
  const pending = path.join(updaterCacheDir(), 'pending');
  try {
    const info = JSON.parse(fs.readFileSync(path.join(pending, 'update-info.json'), 'utf8'));
    const m = String(info.fileName || '').match(/(\d+\.\d+\.\d+)/);
    if (m && versionAtMost(m[1], app.getVersion())) fs.rmSync(pending, { recursive: true, force: true });
  } catch {}
}
if (app.isPackaged) {
  app.whenReady().then(() => {
    clearInstalledPendingUpdate();
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
ipcMain.on('app:isPackaged', (e) => { e.returnValue = app.isPackaged; });
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
  if (t.key) { meta.push('-metadata', 'TKEY=' + t.key, '-metadata', 'key=' + t.key, '-metadata', 'initialkey=' + t.key); }
  const extra = /\.mp3$/i.test(ext) ? ['-id3v2_version', '3', '-write_id3v1', '1'] : [];
  return { meta, extra };
}
const COVER_EMBED_RE = /[.](mp3|m4a|flac|ogg|oga|aac|wav|mp4|m4v|mov)$/i;
const COVER_VIDEO_RE = /[.](mp4|m4v|mov)$/i;
async function downloadCover(url) {
  if (!/^https?:[/][/]/i.test(String(url || ""))) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": lrclibUA() } });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 512) return null;
    const p = path.join(os.tmpdir(), "mediyyu-cover-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".jpg");
    fs.writeFileSync(p, buf);
    return p;
  } catch (err) { return null; }
}
function stampApicTypes(file, types) {
  try {
    if (!types.some(t => t)) return;
    const b = fs.readFileSync(file);
    if (b.length < 10 || b.slice(0, 3).toString('latin1') !== 'ID3') return;
    const ver = b[3];
    const syncsafe = (i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
    const end = Math.min(b.length, 10 + syncsafe(6));
    let p = 10, n = 0, dirty = false;
    while (p + 10 <= end && n < types.length) {
      const id = b.slice(p, p + 4).toString('latin1');
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = ver >= 4 ? syncsafe(p + 4) : b.readUInt32BE(p + 4);
      if (size <= 0 || p + 10 + size > end) break;
      if (id === 'APIC') {
        let q = p + 11;                       
        while (q < end && b[q] !== 0) q++;    
        q++;
        const want = types[n++] & 0xff;
        if (q < p + 10 + size && b[q] !== want) { b[q] = want; dirty = true; }
      }
      p += 10 + size;
    }
    if (dirty) fs.writeFileSync(file, b);
  } catch (err) {}
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
      let coverTmp = null;
      const artOk = COVER_EMBED_RE.test(ext);
      const artIsVideo = COVER_VIDEO_RE.test(ext);
      const picTmps = [];
      if (artOk && tags && Array.isArray(tags.pictures)) {
        for (const pic of tags.pictures) {
          try {
            const buf = Buffer.from(pic.data);
            if (!buf.length) continue;
            const pext = /png/i.test(pic.mime || '') ? '.png' : '.jpg';
            const tp = path.join(os.tmpdir(), 'mediyyu-art-' + Date.now() + '-' + picTmps.length + pext);
            fs.writeFileSync(tp, buf);
            picTmps.push({ path: tp, desc: String(pic.desc || ''), type: Number(pic.type) || 0 });
          } catch (e2) {}
        }
      } else if (artOk && tags && tags.coverUrl) {
        coverTmp = await downloadCover(tags.coverUrl);
        if (coverTmp) picTmps.push({ path: coverTmp, desc: '' });
      }
      const replacingArt = picTmps.length > 0 || (artOk && tags && Array.isArray(tags.pictures));
      const inputs = ['-i', srcPath];
      for (const pic of picTmps) inputs.push('-i', pic.path);
      const buildMaps = (videoCodec) => {
        if (!replacingArt) return ['-map', '0', '-c', 'copy'];
        const m = artIsVideo
          ? ['-map', '0:V?', '-map', '0:a?', '-map', '0:s?']
          : ['-map', '0:a'];
        const vAt = i => i + (artIsVideo ? 1 : 0);
        picTmps.forEach((pic, i) => m.push('-map', String(i + 1)));
        m.push('-c', 'copy');
        if (picTmps.length) {
          if (artIsVideo) picTmps.forEach((pic, i) => m.push('-c:v:' + vAt(i), videoCodec));
          else m.push('-c:v', videoCodec);
        }
        picTmps.forEach((pic, i) => {
          m.push('-disposition:v:' + vAt(i), 'attached_pic');
          if (pic.desc) m.push('-metadata:s:v:' + vAt(i), 'title=' + pic.desc);
        });
        return m;
      };
      let result = await runFfmpeg(['-y', ...inputs, ...buildMaps('copy'), ...meta, ...extra, tmpOut]);
      if (result.code !== 0 && picTmps.length) {
        try { fs.unlinkSync(tmpOut); } catch (e2) {}
        result = await runFfmpeg(['-y', ...inputs, ...buildMaps('mjpeg'), ...meta, ...extra, tmpOut]);
      }
      for (const pic of picTmps) { try { fs.unlinkSync(pic.path); } catch (e2) {} }
      if (result.code !== 0) {
        try { fs.unlinkSync(tmpOut); } catch (e2) {}
        const raw = result.errOut || '';
        const badArt = /dimensions not set|Could not write header/i.test(raw);
        return { error: badArt
          ? 'the artwork embedded in this file is malformed, so it cannot be rewritten around'
          : raw.slice(-400) };
      }
      if (picTmps.length) stampApicTypes(tmpOut, picTmps.map(p => p.type));
      let replaced = false, lastErr = null;
      for (let i = 0; i < 6 && !replaced; i++) {
        try { fs.rmSync(srcPath); fs.renameSync(tmpOut, srcPath); replaced = true; }
        catch (e2) { lastErr = e2; await new Promise(res => setTimeout(res, 150)); }
      }
      if (!replaced) {
        try { fs.unlinkSync(tmpOut); } catch (e2) {}
        return { error: 'could not replace the original file (it may be locked): ' + (lastErr && lastErr.message) };
      }
      return { ok: true, inPlace: true, cover: picTmps.length };
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
async function neteaseFetchLyric(artist, title, duration) {
  try {
    const query = [artist, title].filter(Boolean).join(' ').trim();
    if (!query) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const headers = { 'User-Agent': lrclibUA(), 'Referer': 'https://music.163.com/' };
    const sr = await fetch('https://music.163.com/api/search/get?s=' + encodeURIComponent(query) + '&type=1&limit=8', { headers, signal: controller.signal });
    if (!sr.ok) { clearTimeout(timeout); return null; }
    const sj = await sr.json();
    const songs = (sj && sj.result && sj.result.songs) || [];
    if (!songs.length) { clearTimeout(timeout); return null; }
    let best = songs[0];
    if (duration) {
      const close = songs.filter(s => s.duration && Math.abs(Math.round(s.duration / 1000) - duration) <= 3);
      if (close.length) best = close[0];
    }
    const lr = await fetch('https://music.163.com/api/song/lyric?id=' + encodeURIComponent(best.id) + '&lv=1&kv=1&tv=-1', { headers, signal: controller.signal });
    clearTimeout(timeout);
    if (!lr.ok) return null;
    const lj = await lr.json();
    const lyric = lj && lj.lrc && lj.lrc.lyric;
    if (!lyric || !lyric.trim()) return null;
    return { synced: lyric };
  } catch { return null; }
}
const NETEASE_HEADERS = () => ({ "User-Agent": lrclibUA(), "Referer": "https://music.163.com/" });
ipcMain.handle('lyrics:searchNetease', async (e, query) => {
  try {
    if (!query || !query.trim()) return { results: [] };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const r = await fetch('https://music.163.com/api/search/get?s=' + encodeURIComponent(query.trim()) + '&type=1&limit=20', { headers: NETEASE_HEADERS(), signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) return { results: [] };
    const j = await r.json();
    const songs = (j && j.result && j.result.songs) || [];
    return {
      results: songs.slice(0, 20).map(sg => ({
        id: sg.id,
        trackName: sg.name || '',
        artistName: (sg.artists || []).map(a => a.name).filter(Boolean).join(', '),
        albumName: (sg.album && sg.album.name) || '',
        duration: sg.duration ? Math.round(sg.duration / 1000) : 0,
        synced: true,
      })),
    };
  } catch (err) { return { results: [] }; }
});
ipcMain.handle('lyrics:fetchNeteaseById', async (e, id) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const grab = async (url) => {
    try {
      const r = await fetch(url, { headers: NETEASE_HEADERS(), signal: controller.signal });
      return r.ok ? await r.json() : null;
    } catch (err) { return null; }
  };
  try {
    const a = await grab('https://music.163.com/api/song/lyric?id=' + encodeURIComponent(id) + '&lv=1&kv=1&tv=-1');
    let lyric = a && a.lrc && a.lrc.lyric;
    if (!lyric || !lyric.trim()) {
      const b = await grab('https://music.163.com/api/song/media?id=' + encodeURIComponent(id));
      lyric = b && b.lyric;
    }
    if ((!lyric || !lyric.trim()) && a && a.tlyric) lyric = a.tlyric.lyric;
    if (!lyric || !lyric.trim()) return null;
    return { synced: lyric, plain: '' };
  } finally {
    clearTimeout(timeout);
  }
});
ipcMain.handle('lyrics:fetch', async (e, { artist, title, album, duration, suggestOnly, sourcePref }) => {
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
    async function fetchFromLrclib() {
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
      return exact;
    }
    let exact = null;
    let source = '';
    async function tryNetease() {
      const ne = await neteaseFetchLyric(artist, title, duration);
      if (ne && ne.synced) { exact = { synced: ne.synced, plain: '' }; source = 'netease'; return true; }
      return false;
    }
    async function tryLrclib() {
      const lr = await fetchFromLrclib();
      if (lr && lr.synced) { exact = lr; source = 'lrclib'; return true; }
      if (lr && !exact) exact = lr;
      return false;
    }
    if (!suggestOnly && sourcePref === 'netease') {
      if (!(await tryNetease())) await tryLrclib();
    } else {
      if (!(await tryLrclib()) && !suggestOnly) await tryNetease();
    }
    clearTimeout(timeout);
    return {
      synced: exact ? exact.synced : '',
      plain: exact ? exact.plain : '',
      suggestions: !suggestOnly && exact && exact.synced ? [] : suggestions.slice(0, 8),
      source,
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
ipcMain.handle('lyrics:search', async (e, query) => {
  try {
    if (!query || !query.trim()) return { results: [] };
    const r = await fetch('https://lrclib.net/api/search?q=' + encodeURIComponent(query.trim()), { headers: { 'User-Agent': lrclibUA() } });
    if (!r.ok) return { results: [] };
    const list = await r.json();
    const results = (Array.isArray(list) ? list : []).slice(0, 30).map(it => ({
      id: it.id,
      trackName: it.trackName || '',
      artistName: it.artistName || '',
      albumName: it.albumName || '',
      duration: it.duration || 0,
      synced: !!it.syncedLyrics,
      wordSynced: /<\d{1,2}:\d{2}(?:\.\d{2,3})?>/.test(it.syncedLyrics || ''),
      hasPlain: !!it.plainLyrics,
    }));
    return { results };
  } catch { return { results: [] }; }
});
ipcMain.on('lyrics:openTrackPage', (e, id) => {
  if (id == null) return;
  shell.openExternal('https://lrclib.net/tracks/' + encodeURIComponent(id));
});
ipcMain.on('shell:openExternal', (e, url) => {
  if (typeof url === 'string' && /^https:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('releases:fetch', async () => {
  try {
    const r = await fetch('https://api.github.com/repos/Darkyyyyy/Mediyyu/releases', { headers: { 'User-Agent': lrclibUA() } });
    if (!r.ok) return [];
    const list = await r.json();
    return (Array.isArray(list) ? list : []).map(rel => ({
      tag_name: rel.tag_name || '', name: rel.name || '', body: rel.body || '', published_at: rel.published_at || '',
    }));
  } catch { return []; }
});

// ── corsair icue per-key lighting ────────────────────────────────────────────
const ICUE_BANDS = 32;
let icueSdk;                 // undefined = not tried, null = unavailable
let icueSession = false;     // a CorsairConnect session is live
let icueConnecting = null;   // in-flight connect promise
let icueTargets = [];        // [{ id, model, leds: [{ id, band, ny }] }]
let icueOn = false;          // the renderer asked for lighting

function icueLoad() {
  if (icueSdk !== undefined) return icueSdk;
  try {
    icueSdk = require('cue-sdk');
  } catch (err) {
    icueSdk = null;
    logError('icue', 'cue-sdk could not be loaded: ' + ((err && err.message) || err));
  }
  return icueSdk;
}

function icueBuildTargets() {
  const sdk = icueSdk;
  icueTargets = [];
  let res;
  try { res = sdk.CorsairGetDevices({ deviceTypeMask: sdk.CorsairDeviceType.CDT_All }); } catch (e) { return; }
  for (const dev of (res && res.data) || []) {
    let lp;
    try { lp = sdk.CorsairGetLedPositions(dev.id); } catch (e) { continue; }
    const leds = (lp && lp.data) || [];
    if (!leds.length) continue;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const l of leds) {
      if (l.cx < minX) minX = l.cx;
      if (l.cx > maxX) maxX = l.cx;
      if (l.cy < minY) minY = l.cy;
      if (l.cy > maxY) maxY = l.cy;
    }
    const spanX = maxX - minX, spanY = maxY - minY;
    const mapped = leds.map(l => {
      const tx = spanX > 0 ? (l.cx - minX) / spanX : 0.5;
      const ny = spanY > 0 ? 1 - (l.cy - minY) / spanY : 0;
      let band = Math.round(tx * (ICUE_BANDS - 1));
      if (band < 0) band = 0;
      if (band > ICUE_BANDS - 1) band = ICUE_BANDS - 1;
      return { id: l.id, band: band, ny: ny };
    });
    icueTargets.push({ id: dev.id, model: dev.model || 'corsair device', leds: mapped });
  }
}

function icueConnect() {
  if (icueSession) return Promise.resolve({ ok: true, devices: icueDeviceSummary() });
  if (icueConnecting) return icueConnecting;
  const sdk = icueLoad();
  if (!sdk) return Promise.resolve({ ok: false, reason: 'module' });
  icueConnecting = new Promise(resolve => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      icueConnecting = null;
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 9000);
    try {
      sdk.CorsairConnect(evt => {
        const state = evt && evt.data && evt.data.state;
        if (state === sdk.CorsairSessionState.CSS_Connected) {
          icueSession = true;
          icueBuildTargets();
          finish(icueTargets.length ? { ok: true, devices: icueDeviceSummary() } : { ok: false, reason: 'no-devices' });
        } else if (state === sdk.CorsairSessionState.CSS_ConnectionRefused) {
          finish({ ok: false, reason: 'refused' });
        } else if (state === sdk.CorsairSessionState.CSS_Timeout) {
          finish({ ok: false, reason: 'timeout' });
        } else if (state === sdk.CorsairSessionState.CSS_Closed || state === sdk.CorsairSessionState.CSS_ConnectionLost) {
          icueSession = false;
          icueTargets = [];
        }
      });
    } catch (err) {
      logError('icue', 'connect failed: ' + ((err && err.message) || err));
      finish({ ok: false, reason: 'error' });
    }
  });
  return icueConnecting;
}

function icueDeviceSummary() {
  return icueTargets.map(d => ({ model: d.model, ledCount: d.leds.length }));
}

function icueRelease() {
  icueOn = false;
  if (!icueSession || !icueSdk) return;
  icueSession = false;
  icueTargets = [];
  // disconnecting hands the lighting back to icue's own profile
  try { icueSdk.CorsairDisconnect(); } catch (e) {}
}

ipcMain.handle('icue:enable', async () => {
  const res = await icueConnect();
  icueOn = !!res.ok;
  return res;
});
ipcMain.handle('icue:disable', () => { icueRelease(); return { ok: true }; });

ipcMain.on('icue:frame', (e, buf) => {
  if (!icueOn || !icueSession || !icueSdk || !icueTargets.length || !buf) return;
  for (const dev of icueTargets) {
    const colors = new Array(dev.leds.length);
    for (let i = 0; i < dev.leds.length; i++) {
      const led = dev.leds[i];
      const k = led.band * 4;
      const level = buf[k] / 255;
      // a key lights up once the bar for its column has risen past its row
      let fill = (level - led.ny) * 3;
      if (fill < 0) fill = 0; else if (fill > 1) fill = 1;
      fill = 0.04 + fill * 0.96;
      colors[i] = {
        id: led.id,
        r: Math.round(buf[k + 1] * fill),
        g: Math.round(buf[k + 2] * fill),
        b: Math.round(buf[k + 3] * fill),
        a: 255,
      };
    }
    try { icueSdk.CorsairSetLedColors(dev.id, colors); } catch (err) { icueOn = false; return; }
  }
});

app.on('before-quit', icueRelease);

ipcMain.handle('library:pickFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return canceled || !filePaths.length ? null : filePaths[0];
});
ipcMain.handle('files:scanDir', async (e, dirPath, recursive, limit) => {
  const out = [];
  // the drag-and-drop callers want a small guard rail; the library browser has to
  // see a whole collection, so the cap is theirs to raise
  const cap = Math.min(Math.max(1, limit || 2000), 60000);
  const maxDepth = recursive === false ? 0 : 8;
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= cap) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= cap) break;
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
// exactly what a ripper usually writes
const COVER_FILE_RE = /^(cover|folder|front|album|artwork|art|thumb|frontcover|front[ _-]?cover|albumart.*)\.[a-z0-9]+$/i;
// anything that merely mentions being cover art, e.g. "01 - front cover.jpg"
const COVER_HINT_RE = /(cover|front|folder|artwork|albumart|jacket)/i;
const ANY_IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|jfif|avif|tiff?)$/i;
// where scans tend to be filed away
const ART_SUBDIR_RE = /^(scans?|artworks?|covers?|booklets?|art|images?|jacket)$/i;
const IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif',
  tif: 'image/tiff', tiff: 'image/tiff',
};
// an album whose files carry no embedded art usually still has a cover.jpg sitting
// next to them, and without this the library grid would be a wall of blank squares
// picks the likeliest cover image out of one directory: the canonical name first,
// then anything that says it is cover art, then any image at all
function pickCoverIn(dir, looseOk) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { return null; }
  const files = entries.filter(ent => ent.isFile() && ANY_IMAGE_RE.test(ent.name));
  let pick = files.find(ent => COVER_FILE_RE.test(ent.name));
  if (!pick) pick = files.find(ent => COVER_HINT_RE.test(ent.name));
  if (!pick && looseOk) pick = files[0];
  return pick ? path.join(dir, pick.name) : null;
}
ipcMain.handle('library:folderImages', async (e, dirs) => {
  const list = Array.isArray(dirs) ? dirs.slice(0, 500) : [];
  const out = [];
  for (const dir of list) {
    try {
      if (!dir || typeof dir !== 'string') continue;
      let found = pickCoverIn(dir, true);
      // a scans folder next to the tracks
      if (!found) {
        let subs = [];
        try {
          subs = fs.readdirSync(dir, { withFileTypes: true })
            .filter(ent => ent.isDirectory() && ART_SUBDIR_RE.test(ent.name));
        } catch (err) {}
        for (const sub of subs) {
          found = pickCoverIn(path.join(dir, sub.name), true);
          if (found) break;
        }
      }
      // one level up, for a disc folder inside an album folder. only a named
      // cover counts there: a stray image could belong to something else.
      if (!found) found = pickCoverIn(path.dirname(dir), false);
      if (!found) continue;
      const stat = await fs.promises.stat(found);
      if (stat.size > 24 * 1024 * 1024) continue;
      const data = await fs.promises.readFile(found);
      out.push({
        dir,
        file: found,
        mime: IMAGE_MIME[path.extname(found).slice(1).toLowerCase()] || 'image/jpeg',
        data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      });
    } catch (err) {}
  }
  return out;
});
// duration straight out of the file headers. the renderer's own probe loads the
// whole file into an <audio> element, which is fine for a playlist and hopeless
// for a library of thousands, so these read a few hundred bytes instead
const MP3_BITRATES = {
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

async function readChunk(fh, pos, len) {
  if (len <= 0 || pos < 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}
function mp3Duration(head, audioStart, fileSize) {
  for (let i = 0; i < head.length - 4; i++) {
    if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (head[i + 1] >> 3) & 3;
    const layer = (head[i + 1] >> 1) & 3;
    if (verBits === 1 || layer !== 1) continue;           // reserved version, or not layer 3
    const rates = MP3_RATES[verBits];
    const rateIdx = (head[i + 2] >> 2) & 3;
    const brIdx = (head[i + 2] >> 4) & 15;
    if (!rates || rateIdx === 3 || brIdx === 0 || brIdx === 15) continue;
    const sampleRate = rates[rateIdx];
    const bitrate = MP3_BITRATES[verBits === 3 ? 1 : 2][brIdx] * 1000;
    if (!sampleRate || !bitrate) continue;
    const mpeg1 = verBits === 3;
    const perFrame = mpeg1 ? 1152 : 576;
    const mono = ((head[i + 3] >> 6) & 3) === 3;
    // a vbr file carries its own frame count; without one, size over bitrate is
    // the best we can do
    const xingAt = i + 4 + (mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    const tag = head.length >= xingAt + 4 ? head.toString('latin1', xingAt, xingAt + 4) : '';
    if (tag === 'Xing' || tag === 'Info') {
      const flags = head.readUInt32BE(xingAt + 4);
      if (flags & 1) {
        const frames = head.readUInt32BE(xingAt + 8);
        if (frames > 0) return (frames * perFrame) / sampleRate;
      }
    }
    const vbriAt = i + 4 + 32;
    if (head.length >= vbriAt + 4 && head.toString('latin1', vbriAt, vbriAt + 4) === 'VBRI') {
      const frames = head.readUInt32BE(vbriAt + 14);
      if (frames > 0) return (frames * perFrame) / sampleRate;
    }
    return ((fileSize - audioStart - i) * 8) / bitrate;
  }
  return 0;
}
function flacDuration(head) {
  let pos = 4;
  while (pos + 4 <= head.length) {
    const last = (head[pos] & 0x80) !== 0;
    const type = head[pos] & 0x7f;
    const len = (head[pos + 1] << 16) | (head[pos + 2] << 8) | head[pos + 3];
    const body = pos + 4;
    if (type === 0 && body + 18 <= head.length) {
      const sr = (head[body + 10] << 12) | (head[body + 11] << 4) | (head[body + 12] >> 4);
      const total = ((head[body + 13] & 0x0f) * 4294967296) + head.readUInt32BE(body + 14);
      return sr > 0 ? total / sr : 0;
    }
    if (last) break;
    pos = body + len;
  }
  return 0;
}
function wavDuration(head) {
  let pos = 12, byteRate = 0;
  while (pos + 8 <= head.length) {
    const id = head.toString('latin1', pos, pos + 4);
    const len = head.readUInt32LE(pos + 4);
    if (id === 'fmt ' && pos + 16 <= head.length) byteRate = head.readUInt32LE(pos + 16);
    if (id === 'data' && byteRate > 0) return len / byteRate;
    pos += 8 + len + (len & 1);
  }
  return 0;
}
// mp4 keeps its moov atom at either end of the file, so the walk follows atom
// sizes and only reads the 8-byte headers it lands on
async function mp4Duration(fh, fileSize) {
  async function walk(start, end, depth) {
    let pos = start;
    while (pos + 8 <= end && depth < 4) {
      const head = await readChunk(fh, pos, 16);
      if (head.length < 8) return 0;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let body = pos + 8;
      if (size === 1) {
        if (head.length < 16) return 0;
        size = Number(head.readBigUInt64BE(8));
        body = pos + 16;
      } else if (size === 0) size = end - pos;
      if (size < 8) return 0;
      if (type === 'moov' || type === 'trak' || type === 'mdia') {
        const found = await walk(body, pos + size, depth + 1);
        if (found) return found;
      } else if (type === 'mvhd' || type === 'mdhd') {
        const box = await readChunk(fh, body, 32);
        if (box.length >= 20) {
          const version = box[0];
          const timescale = version === 1 ? box.readUInt32BE(20) : box.readUInt32BE(12);
          const dur = version === 1 ? Number(box.readBigUInt64BE(24)) : box.readUInt32BE(16);
          if (timescale > 0 && dur > 0 && dur !== 0xffffffff) return dur / timescale;
        }
      }
      pos += size;
    }
    return 0;
  }
  return walk(0, fileSize, 0);
}
// an ogg stream only knows its length from the granule position on its very last
// page, so this one reads the tail
async function oggDuration(fh, head, fileSize) {
  let rate = 0;
  const vorbis = head.indexOf('vorbis', 0, 'latin1');
  const opus = head.indexOf('OpusHead', 0, 'latin1');
  if (opus >= 0) rate = 48000;
  else if (vorbis >= 0 && vorbis + 12 <= head.length) rate = head.readUInt32LE(vorbis + 6 + 5);
  if (!rate) return 0;
  const tailLen = Math.min(fileSize, 65536);
  const tail = await readChunk(fh, fileSize - tailLen, tailLen);
  for (let i = tail.length - 14; i >= 0; i--) {
    if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53) continue;
    const granule = Number(tail.readBigUInt64LE(i + 6));
    if (granule > 0) return granule / rate;
  }
  return 0;
}
async function probeDuration(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  let fh = null;
  try {
    fh = await fs.promises.open(p, 'r');
    const stat = await fh.stat();
    const size = stat.size;
    if (!size) return 0;
    let head = await readChunk(fh, 0, Math.min(size, 65536));
    if (ext === 'mp3' || ext === 'aac') {
      let audioStart = 0;
      if (head.length >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
        audioStart = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
        head = await readChunk(fh, audioStart, Math.min(Math.max(0, size - audioStart), 65536));
      }
      return mp3Duration(head, audioStart, size);
    }
    if (ext === 'flac') return flacDuration(head);
    if (ext === 'wav') return wavDuration(head);
    if (ext === 'm4a' || ext === 'mp4' || ext === 'm4v' || ext === 'mov') return await mp4Duration(fh, size);
    if (ext === 'ogg' || ext === 'opus' || ext === 'oga') return await oggDuration(fh, head, size);
    return 0;
  } catch (err) {
    return 0;
  } finally {
    if (fh) { try { await fh.close(); } catch (e) {} }
  }
}
ipcMain.handle('library:durations', async (e, paths) => {
  const list = Array.isArray(paths) ? paths.slice(0, 2000) : [];
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      let dur = 0;
      try { dur = await probeDuration(list[i]); } catch (err) {}
      out[i] = { path: list[i], dur: isFinite(dur) && dur > 0 ? dur : 0 };
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out.filter(Boolean);
});
// name, type and size without reading a byte: a playlist row needs nothing more
ipcMain.handle('files:describe', async (e, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      const p = list[i];
      try {
        if (!p || typeof p !== 'string') continue;
        const stat = await fs.promises.stat(p);
        if (!stat.isFile()) continue;
        const ext = path.extname(p).slice(1).toLowerCase();
        out[i] = { path: p, name: path.basename(p), mime: AUDIO_MIME[ext] || 'audio/mpeg', size: stat.size };
      } catch (err) {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
  return out.filter(Boolean);
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
ipcMain.handle('files:readPrefixes', async (e, paths, maxBytes) => {
  const list = Array.isArray(paths) ? paths : [];
  const cap = Math.min(Math.max(1, maxBytes || 262144), 4 * 1024 * 1024);
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const idx = next++;
      const p = list[idx];
      let fh = null;
      try {
        if (!p || typeof p !== 'string') continue;
        fh = await fs.promises.open(p, 'r');
        const stat = await fh.stat();
        let len = Math.min(cap, stat.size);
        const head = Buffer.alloc(16);
        const headRead = await fh.read(head, 0, 16, 0);
        if (headRead.bytesRead >= 10 && head.toString('latin1', 0, 3) === 'ID3') {
          const tagLen = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
          // exactly the tag, no more: a single 3000px cover makes a 9 MB tag, and
          // stopping short hands back a truncated png, while reading past it only
          // ships audio nobody is going to parse
          len = Math.min(stat.size, tagLen + 4096, 24 * 1024 * 1024);
        } else if (headRead.bytesRead >= 4 && head.toString('latin1', 0, 4) === 'fLaC') {
          // walk the metadata block chain and stop where the audio starts
          let pos = 4, last = false, guard = 0;
          while (!last && guard++ < 64) {
            const bh = Buffer.alloc(4);
            const got = await fh.read(bh, 0, 4, pos);
            if (got.bytesRead < 4) break;
            last = (bh[0] & 0x80) !== 0;
            pos += 4 + ((bh[1] << 16) | (bh[2] << 8) | bh[3]);
            if (pos > stat.size) { pos = stat.size; break; }
          }
          len = Math.min(stat.size, Math.max(pos + 1024, 8192), 24 * 1024 * 1024);
        }
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, 0);
        out[idx] = { path: p, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
      } catch (err) {
      } finally {
        if (fh) { try { await fh.close(); } catch (e2) {} }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  return out.filter(Boolean);
});
ipcMain.handle('soundfont:read', async (e, p) => {
  try {
    if (!p || typeof p !== 'string' || !fs.existsSync(p)) return null;
    const data = await fs.promises.readFile(p);
    return { name: path.basename(p), data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
  } catch { return null; }
});
ipcMain.on('config:get', (e) => {
  // what the renderer needs to know about how this copy was built
  e.returnValue = { discordClientId: (process.env.MEDIYYU_DISCORD_CLIENT_ID || '').trim() };
});
ipcMain.on('discord:connect', (e, clientId) => { discordConnect(clientId); });
ipcMain.on('discord:disconnect', () => { discordDisconnect(); });
ipcMain.on('discord:setActivity', (e, activity) => {
  if (!discordClient || !discordClient.isConnected) {
    discordLog('activity NOT sent — discord rpc not connected (is discord running?)');
    return;
  }
  const key = activity && activity.largeImageKey;
  if (!key) discordLog('activity sent WITHOUT any image (no cover url, no fallback asset key)');
  else if (/^https?:\/\//i.test(key)) discordLog(`activity sent with image URL → ${key}`);
  else discordLog(`activity sent with discord asset key → "${key}"`);
  discordClient.user?.setActivity(activity)
    .then(() => discordLog('discord accepted the activity payload ✓'))
    .catch(err => discordLog(`discord REJECTED the activity: ${err && err.message ? err.message : err}`));
});
ipcMain.on('discord:clearActivity', () => {
  if (!discordClient || !discordClient.isConnected) return;
  discordClient.user?.clearActivity().catch(() => {});
});
const _dg = envPair('MEDIYYU_DISCOGS');
// strip punctuation, symbols and any "feat. X" credit that only confuse the cover databases.
// letters (every script), digits, spaces, hyphens and apostrophes are kept.
function cleanSearchTerm(s) {
  const raw = String(s || '').trim();
  const B = String.fromCharCode(92);
  const featBracket = new RegExp('[(' + B + '[{][^)' + B + ']}]*?(?:feat|ft|featuring)[.]?[^)' + B + ']}]*[)' + B + ']}]', 'gi');
  const featTail = new RegExp('[ ,;-]+(?:feat|ft|featuring)[.]?[ ].*$', 'i');
  const drop = new RegExp('[^' + B + 'p{L}' + B + 'p{N}' + B + "s'’-]+", 'gu');
  const cleaned = raw.normalize('NFKC')
    .replace(featBracket, ' ')
    .replace(featTail, '')
    .replace(drop, ' ')
    .replace(/  +/g, ' ')
    .trim()
    .replace(/^-+|-+$/g, '')
    .trim();
  return cleaned || raw;
}
async function lookupCoverItunes(artist, album) {
  if (!album) {
    discordLog('itunes: SKIPPED — track has no album tag (itunes search needs one)');
    return null;
  }
  const term = [artist, album].filter(Boolean).join(' ');
  discordLog(`itunes: searching "${term}"…`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=album&limit=1`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await res.json();
    const first = data.results && data.results[0];
    const art = first && first.artworkUrl100;
    if (!art) {
      discordLog(`itunes: NO MATCH for "${term}"`);
      return null;
    }
    const full = art.replace('100x100bb.jpg', '512x512bb.jpg');
    discordLog(`itunes: FOUND "${first.artistName || '?'} — ${first.collectionName || '?'}"`);
    discordLog(`  └ ${full}`);
    return full;
  } catch (err) {
    discordLog(`itunes: ERROR — ${err && err.name === 'AbortError' ? 'timed out after 5s' : (err && err.message) || err}`);
    return null;
  }
}
async function lookupCoverDiscogs(artist, album, title) {
  if (!_dg) {
    discordLog('discogs: SKIPPED — this build has no discogs key (see .env.example)');
    return null;
  }
  const term = [artist, album || title].filter(Boolean).join(' ');
  if (!term) {
    discordLog('discogs: SKIPPED — no artist and no album/title to search with');
    return null;
  }
  discordLog(`discogs: searching "${term}"…`);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const url = `https://api.discogs.com/database/search?q=${encodeURIComponent(term)}&type=release&key=${_dg[0]}&secret=${_dg[1]}`;
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': lrclibUA() } });
    clearTimeout(timeout);
    if (!res.ok) {
      discordLog(`discogs: HTTP ${res.status} ${res.statusText || ''}`.trim() + (res.status === 429 ? ' (rate limited)' : ''));
      return null;
    }
    const data = await res.json();
    const r = data.results && data.results[0];
    const cover = r && (r.cover_image || r.thumb);
    if (!cover) {
      discordLog(`discogs: NO MATCH for "${term}" (${(data.results || []).length} results, none with art)`);
      return null;
    }
    discordLog(`discogs: FOUND "${r.title || '?'}"${r.year ? ` (${r.year})` : ''}`);
    discordLog(`  └ ${cover}`);
    return cover;
  } catch (err) {
    discordLog(`discogs: ERROR — ${err && err.name === 'AbortError' ? 'timed out after 6s' : (err && err.message) || err}`);
    return null;
  }
}
// musicbrainz allows about one request per second, and it is now the first source we hit
let mbGate = Promise.resolve();
let mbLastCall = 0;
function mbThrottle() {
  const next = mbGate.then(async () => {
    const wait = 1500 - (Date.now() - mbLastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    mbLastCall = Date.now();
  });
  mbGate = next.catch(() => {});
  return next;
}
async function lookupCoverMusicBrainz(artist, album, title) {
  if (!album && !title) {
    discordLog('musicbrainz: SKIPPED — no album and no title');
    return null;
  }
  const esc = s => String(s).replace(/(["\\])/g, '\\$1');
  const useRelease = !!album;
  const parts = [`${useRelease ? 'release' : 'recording'}:"${esc(album || title)}"`];
  if (artist) parts.push(`artist:"${esc(artist)}"`);
  const query = parts.join(' AND ');
  const entity = useRelease ? 'release' : 'recording';
  discordLog(`musicbrainz: searching ${entity} ${query}…`);
  try {
    await mbThrottle();
    const headers = { 'User-Agent': lrclibUA() };
    const searchUrl = `https://musicbrainz.org/ws/2/${entity}/?query=${encodeURIComponent(query)}&fmt=json&limit=3`;
    const backoff = [1500, 3000, 5000];
    let res = null;
    for (let attempt = 0; ; attempt++) {
      const c = new AbortController();
      const tt = setTimeout(() => c.abort(), 6000);
      try { res = await fetch(searchUrl, { signal: c.signal, headers }); } finally { clearTimeout(tt); }
      if (res.status !== 503 || attempt >= backoff.length) break;
      discordLog(`musicbrainz: HTTP 503 (rate limited) — retry ${attempt + 1}/${backoff.length} in ${backoff[attempt] / 1000}s`);
      await new Promise(r => setTimeout(r, backoff[attempt]));
      mbLastCall = Date.now();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    if (!res.ok) {
      clearTimeout(timeout);
      discordLog(`musicbrainz: HTTP ${res.status}${res.status === 503 ? ' (rate limited)' : ''}`);
      return null;
    }
    const data = await res.json();
    const candidates = [];
    if (useRelease) {
      for (const r of data.releases || []) if (r.id) candidates.push({ id: r.id, label: `${(r['artist-credit'] || [{}])[0].name || '?'} — ${r.title || '?'}` });
    } else {
      for (const rec of data.recordings || []) {
        for (const rel of rec.releases || []) if (rel.id) candidates.push({ id: rel.id, label: `${(rec['artist-credit'] || [{}])[0].name || '?'} — ${rel.title || rec.title || '?'}` });
      }
    }
    if (!candidates.length) {
      clearTimeout(timeout);
      discordLog(`musicbrainz: NO MATCH for ${query}`);
      return null;
    }
    for (const cand of candidates.slice(0, 3)) {
      const caaRes = await fetch(`https://coverartarchive.org/release/${cand.id}`, { signal: controller.signal, headers });
      if (!caaRes.ok) {
        discordLog(`musicbrainz: "${cand.label}" has no art in cover art archive (HTTP ${caaRes.status})`);
        continue;
      }
      const caa = await caaRes.json();
      const img = (caa.images || []).find(i => i.front) || (caa.images || [])[0];
      const url = img && ((img.thumbnails && (img.thumbnails['500'] || img.thumbnails.large)) || img.image);
      if (!url) {
        discordLog(`musicbrainz: "${cand.label}" art entry has no usable image url`);
        continue;
      }
      clearTimeout(timeout);
      discordLog(`musicbrainz: FOUND "${cand.label}"`);
      discordLog(`  └ ${url}`);
      return url;
    }
    clearTimeout(timeout);
    discordLog(`musicbrainz: matched ${candidates.length} release(s) but none had cover art`);
    return null;
  } catch (err) {
    discordLog(`musicbrainz: ERROR — ${err && err.name === 'AbortError' ? 'timed out after 7s' : (err && err.message) || err}`);
    return null;
  }
}
const COVER_CACHE_FILE = path.join(app.getPath('userData'), 'cover-cache.json');
const COVER_CACHE_NEG_TTL = 1000 * 60 * 60 * 24 * 14;
let coverCache = null;
let coverCacheSaveTimer = null;
function loadCoverCache() {
  if (coverCache) return coverCache;
  try { coverCache = JSON.parse(fs.readFileSync(COVER_CACHE_FILE, 'utf8')); }
  catch { coverCache = {}; }
  return coverCache;
}
function saveCoverCacheDebounced() {
  clearTimeout(coverCacheSaveTimer);
  coverCacheSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(COVER_CACHE_FILE, JSON.stringify(coverCache)); } catch (e) {}
  }, 800);
}
function coverCacheKey(artist, album, title) {
  return [artist, album, title].map(s => (s || '').toLowerCase().trim()).join('|');
}
// ── filling tags from the release databases ─────────────────────────────────
function mbCoverUrl(id) { return id ? `https://coverartarchive.org/release/${id}/front-500` : null; }
// an album is a release, not a recording: asking the recording endpoint for a
// record's name finds a track called that, which almost never exists
// an album is a release, not a recording: asking the recording endpoint for a
// record's name finds a track called that, which almost never exists
async function metaSearchMusicBrainz(query, artist, title, forAlbum) {
  const esc = (v) => String(v).replace(/(["\\])/g, "\\$1");
  const field = forAlbum ? 'release' : 'recording';
  const limit = forAlbum ? 8 : 5;

  async function ask(lucene) {
    await mbThrottle();
    const url = 'https://musicbrainz.org/ws/2/' + field + '/?query=' + encodeURIComponent(lucene)
      + '&fmt=json&limit=' + limit;
    // musicbrainz answers 503 as soon as it considers the burst too fast, and it
    // does that often enough that one refusal must not mean an empty picker
    const backoff = [1200, 2500, 4000];
    let r = null;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 9000);
      try { r = await fetch(url, { headers: { 'User-Agent': lrclibUA() }, signal: controller.signal }); }
      finally { clearTimeout(timer); }
      if (r.status !== 503 || attempt >= backoff.length) break;
      await new Promise(res => setTimeout(res, backoff[attempt]));
      mbLastCall = Date.now();
    }
    if (!r.ok) return [];
    const j = await r.json();
    return (forAlbum ? j.releases : j.recordings) || [];
  }

  const out = [];
  try {
    const strict = artist && title
      ? `${field}:"${esc(title)}" AND artist:"${esc(artist)}"`
      : query;
    let rows = await ask(strict);
    // one artist tag spelled differently from the credit — "Shoji Meguro" against
    // "ATLUS Sound Team" — is enough for the strict clause to find nothing at all,
    // so the name alone gets a second go
    if (!rows.length && artist && title) rows = await ask(`${field}:"${esc(title)}"`);

    if (forAlbum) {
      for (const rel of rows) {
        const who = (rel['artist-credit'] || []).map(a => a.name).filter(Boolean).join(', ');
        out.push({
          source: 'musicbrainz',
          title: '',
          artist: who || '',
          album: rel.title || '',
          year: rel.date ? String(rel.date).slice(0, 4) : '',
          genre: '',
          trackNo: '',
          coverUrl: mbCoverUrl(rel.id),
        });
      }
      return out;
    }
    for (const rec of rows) {
      const who = (rec['artist-credit'] || []).map(a => a.name).filter(Boolean).join(', ');
      const rel = (rec.releases || [])[0];
      out.push({
        source: 'musicbrainz',
        title: rec.title || '',
        artist: who || '',
        album: (rel && rel.title) || '',
        year: rel && rel.date ? String(rel.date).slice(0, 4) : '',
        genre: '',
        trackNo: rel && rel.media && rel.media[0] && rel.media[0].track && rel.media[0].track[0]
          ? String(rel.media[0].track[0].number || '') : '',
        coverUrl: mbCoverUrl(rel && rel.id),
      });
    }
  } catch (err) {}
  return out;
}
async function metaSearchDiscogs(query) {
  const out = [];
  if (!_dg) return out;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const url = 'https://api.discogs.com/database/search?q=' + encodeURIComponent(query)
      + '&type=release&per_page=8&key=' + _dg[0] + '&secret=' + _dg[1];
    const r = await fetch(url, { headers: { 'User-Agent': lrclibUA() }, signal: controller.signal });
    clearTimeout(timer);
    if (!r.ok) return out;
    const j = await r.json();
    for (const it of j.results || []) {
      const whole = String(it.title || '');
      const cut = whole.indexOf(' - ');
      const artist = cut > 0 ? whole.slice(0, cut).trim() : '';
      const album = cut > 0 ? whole.slice(cut + 3).trim() : whole.trim();
      out.push({
        source: 'discogs',
        title: '',
        artist: artist,
        album: album,
        year: it.year ? String(it.year) : '',
        genre: (it.style && it.style[0]) || (it.genre && it.genre[0]) || '',
        trackNo: '',
        coverUrl: it.cover_image || it.thumb || null,
      });
    }
  } catch (err) {}
  return out;
}
ipcMain.handle('meta:search', async (e, payload) => {
  const p = typeof payload === 'string' ? { query: payload } : (payload || {});
  const q = String(p.query || '').trim();
  if (!q) return { results: [] };
  const [mb, dg] = await Promise.all([
    metaSearchMusicBrainz(q, p.artist, p.title, p.kind === 'album'),
    metaSearchDiscogs(q),
  ]);
  // musicbrainz knows track titles, discogs knows genres and years. show both.
  return { results: mb.concat(dg) };
});
ipcMain.handle('meta:image', async (e, url) => {
  const tmp = await downloadCover(url);
  if (!tmp) return null;
  try {
    const buf = fs.readFileSync(tmp);
    return { mime: /[.]png$/i.test(tmp) ? 'image/png' : 'image/jpeg', data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (err) { return null; }
  finally { try { fs.unlinkSync(tmp); } catch (err) {} }
});
ipcMain.handle('discord:lookupCover', async (e, { artist, album, title }) => {
  discordLog(`── cover lookup: artist="${artist || '(none)'}" album="${album || '(none)'}" title="${title || '(none)'}"`);
  if (!album && !title) {
    discordLog('ABORTED — no album and no title tag, nothing to search with');
    return { url: null, source: null };
  }
  const cache = loadCoverCache();
  const key = coverCacheKey(artist, album, title);
  const hit = cache[key];
  if (hit) {
    if (hit.url) {
      discordLog(`cache: HIT (local cache, from ${hit.source || 'an earlier lookup'}) → ${hit.url}`);
      return { url: hit.url, source: hit.source || 'cache' };
    }
    if (Date.now() - hit.ts < COVER_CACHE_NEG_TTL) {
      const days = Math.ceil((COVER_CACHE_NEG_TTL - (Date.now() - hit.ts)) / 86400000);
      discordLog(`cache: HIT but it's a remembered FAILURE (no cover found before, retry in ${days}d) — skipping apis`);
      return { url: null, source: null };
    }
    discordLog('cache: stale failure, retrying the apis');
  } else {
    discordLog('cache: miss, querying apis');
  }
  const qArtist = cleanSearchTerm(artist), qAlbum = cleanSearchTerm(album), qTitle = cleanSearchTerm(title);
  if (qArtist !== (artist || '').trim() || qAlbum !== (album || '').trim() || qTitle !== (title || '').trim()) {
    discordLog(`search terms cleaned → artist="${qArtist || '(none)'}" album="${qAlbum || '(none)'}" title="${qTitle || '(none)'}"`);
  }
  let source = null;
  let url = await lookupCoverMusicBrainz(qArtist, qAlbum, qTitle);
  if (url) source = 'MusicBrainz';
  if (!url) { url = await lookupCoverItunes(qArtist, qAlbum); if (url) source = 'iTunes'; }
  if (!url) { url = await lookupCoverDiscogs(qArtist, qAlbum, qTitle); if (url) source = 'Discogs'; }
  if (url) discordLog(`RESULT: cover from ${source}`);
  else discordLog('RESULT: no cover found in MusicBrainz, iTunes or Discogs for this track');
  cache[key] = { url: url || null, source: source, ts: Date.now() };
  saveCoverCacheDebounced();
  return { url: url || null, source: source };
});

const _sc = envPair('MEDIYYU_LASTFM');
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
const LASTFM_UNCONFIGURED = 'this build has no last.fm key — see .env.example if you built it yourself';
ipcMain.handle('scrobble:getAuthUrl', async () => {
  if (!_sc) return { error: LASTFM_UNCONFIGURED };
  try {
    const data = await scrobbleCall('auth.getToken', {});
    if (!data.token) return { error: (data.message || 'could not get a token') };
    return { token: data.token, url: `https://www.last.fm/api/auth/?api_key=${_sc[0]}&token=${data.token}` };
  } catch (err) { return { error: err.message }; }
});
ipcMain.handle('scrobble:completeAuth', async (e, token) => {
  if (!_sc) return { error: LASTFM_UNCONFIGURED };
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
ipcMain.handle('scrobble:getSimilar', async (e, { artist, track }) => {
  if (!artist || !track) return { error: 'missing fields' };
  try {
    const data = await scrobbleCall('track.getSimilar', { artist, track, limit: 12 }, false);
    if (data.error) return { error: data.message || 'lookup failed' };
    const list = (data.similartracks && data.similartracks.track) || [];
    return { tracks: list.map(t => ({ artist: (t.artist && t.artist.name) || '', name: t.name || '' })) };
  } catch (err) { return { error: err.message }; }
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
