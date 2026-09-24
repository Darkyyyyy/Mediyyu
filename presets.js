// preset format, shared by the app and the import popup
(() => {
  'use strict';

  const FORMAT = 'mediyyu-preset';
  const VERSION = 1;
  const EXT = 'mdyp';
  const MAX_SLOTS = 9;
  const NAME_MAX = 24;

  const EQ_CURVES = {
    flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
    treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
    vshape: [5, 4, 2, 0, -1, -1, 1, 3, 4, 5],
    vocal: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1],
    warm: [3, 2, 1, 0, 0, -1, -2, -3, -3, -4],
  };
  const EQ_NAMES = { flat: 'flat', bass: 'bass boost', treble: 'treble boost', vshape: 'v-shape', vocal: 'vocal', warm: 'warm' };

  // per settings tab: [key, default, label, unit]
  const GROUPS = [
    { id: 'shape', label: 'shape', keys: [
      ['layout', 'bars', 'layout'],
      ['mirror', false, 'mirror'],
      ['flipH', false, 'flip horizontal'],
      ['kaleidoscope', false, 'kaleidoscope'],
      ['count', 110, 'bars'],
      ['waveStyle', 'line', 'style'],
      ['waveSmooth', 40, 'smoothing'],
      ['fallsSpeed', 50, 'scroll speed'],
      ['psyPetals', 9, 'petals'],
      ['psySpeed', 50, 'swirl speed'],
      ['psyTrail', 50, 'trail length'],
    ] },
    { id: 'color', label: 'color', keys: [
      ['mode', 'solid', 'fill'],
      ['color1', '#575757', 'color'],
      ['color2', '#7b5bff', 'to'],
      ['rainbow', false, 'rainbow cycle'],
    ] },
    { id: 'visualizer', label: 'visualizer', keys: [
      ['legacy', false, 'legacy mode'],
      ['sens', 100, 'sensitivity'],
      ['smooth', 45, 'smoothing'],
      ['fall', 73, 'falloff'],
      ['specFftSize', 4096], ['specWindow', 'blackman'], ['specSineExp', 3],
      ['specLogScale', true], ['specMirror', false], ['specChannel', 'mono'],
      ['specTsmooth', 'ema'], ['specInertia', 0.6], ['specFastPeaks', false], ['specGravity', 0],
      ['specInterp', 'catrom'], ['specFilter', 'gauss'], ['specFilterRadius', 1],
      ['specCutoffLow', 0], ['specCutoffHigh', 14500], ['specFloor', -50], ['specCeiling', -10],
      ['specSlope', 0], ['specRolloffQ', 0], ['specRolloffRate', 0],
    ] },
    { id: 'effects', label: 'effects', keys: [
      ['glow', 20, 'bloom'],
      ['trails', 0, 'trails'],
      ['reflection', false, 'reflection'],
      ['vignette', false, 'vignette'],
      ['peakHold', false, 'peak hold'],
      ['connections', false, 'connections'],
      ['particles', false, 'particles'],
      ['particlesAmt', 50, 'particle amount'],
      ['beatParticles', false, 'beat particles'],
      ['beatParticlesAmt', 50, 'beat particle amount'],
      ['scaleToSound', false, 'scale to sound'],
      ['scaleToSoundAmt', 50, 'scale amount'],
      ['chromaAb', false, 'chromatic aberration'],
      ['chromaAbAmt', 50, 'aberration amount'],
      ['bgPulse', 0, 'background pulse'],
      ['flash', 0, 'flash'],
    ] },
    { id: 'audio', label: 'audio', keys: [
      ['gain', 100, 'volume gain', '%'],
      ['volWheelStep', 5, 'wheel step (volume)'],
      ['seekWheelStep', 5, 'wheel step (seek)', 's'],
      ['eq0', 0], ['eq1', 0], ['eq2', 0], ['eq3', 0], ['eq4', 0],
      ['eq5', 0], ['eq6', 0], ['eq7', 0], ['eq8', 0], ['eq9', 0],
      ['crossfade', false, 'crossfade'],
      ['crossfadeDur', 4, 'crossfade duration', 's'],
    ] },
    { id: 'midi', label: 'midi', keys: [
      ['soundfontPath', ''],
      ['soundfontName', '', 'soundfont'],
      ['midiParticles', false, 'note particles'],
    ] },
    { id: 'background', label: 'background', keys: [
      ['bg', '#0a0b0d', 'color'],
      ['winTransparent', false, 'see-through window'],
      ['bgCoverArt', false, 'ambient cover art'],
      ['bgCoverBlur', 46, 'blur'],
      ['bgCoverDim', 55, 'dim'],
    ] },
    { id: 'window', label: 'interface', keys: [
      ['glassTint', '#ffffff', 'tint'],
      ['glassTintAuto', false, 'tint from cover'],
      ['glassAlpha', 5, 'transparency'],
      ['glassBlur', true, 'backdrop blur'],
    ] },
  ];

  const DEFAULTS = {};
  const LABELS = {};
  const UNITS = {};
  for (const g of GROUPS) {
    for (const [k, def, label, unit] of g.keys) {
      DEFAULTS[k] = def;
      if (label) LABELS[k] = label;
      if (unit) UNITS[k] = unit;
    }
  }
  const KEYS = Object.keys(DEFAULTS);

  const HEX_RE = /^#[0-9a-f]{6}$/i;
  const COLOR_KEYS = new Set(['color1', 'color2', 'bg', 'glassTint']);
  function validValue(k, v) {
    const def = DEFAULTS[k];
    if (typeof v !== typeof def) return false;
    if (typeof v === 'number') return Number.isFinite(v);
    if (COLOR_KEYS.has(k)) return HEX_RE.test(v) || (k === 'bg' && v === 'transparent');
    return typeof v !== 'string' || v.length <= 1024;
  }

  function pick(settings) {
    const out = {};
    for (const k of KEYS) {
      if (settings && k in settings && validValue(k, settings[k])) out[k] = settings[k];
    }
    return out;
  }

  function cleanName(name) {
    return String(name || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, NAME_MAX);
  }

  function serialize(name, settings, appVersion) {
    return JSON.stringify({
      format: FORMAT,
      version: VERSION,
      app: appVersion || '',
      name: cleanName(name),
      settings: pick(settings),
    }, null, 2);
  }

  function parse(text) {
    let data;
    try { data = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch (e) { throw new Error("this file isn't a mediyyu preset."); }
    if (!data || data.format !== FORMAT || typeof data.settings !== 'object' || !data.settings) {
      throw new Error("this file isn't a mediyyu preset.");
    }
    if (typeof data.version === 'number' && data.version > VERSION) {
      throw new Error('this preset was made with a newer mediyyu. update the app to import it.');
    }
    const settings = pick(data.settings);
    if (!Object.keys(settings).length) throw new Error('this preset is empty.');
    return { name: cleanName(data.name) || 'imported preset', settings };
  }

  function fileName(name) {
    const base = cleanName(name).replace(/[<>:"/\\|?*]/g, '').replace(/[. ]+$/, '') || 'preset';
    return base + '.' + EXT;
  }

  // ----- readable summary for the import dialog -----
  const SHAPE_ONLY = {
    mirror: ['bars', 'radial'],
    kaleidoscope: ['radial'],
    count: ['bars', 'radial', 'waterfall'],
    waveStyle: ['wave'], waveSmooth: ['wave'],
    fallsSpeed: ['waterfall'],
    psyPetals: ['psychedelic'], psySpeed: ['psychedelic'], psyTrail: ['psychedelic'],
  };
  const LAYOUT_NAMES = { bars: 'bars', radial: 'radial', wave: 'wave', waterfall: 'falls', psychedelic: 'psychedelic' };
  // amount sliders shown folded into their switch
  const AMOUNT_OF = { particles: 'particlesAmt', beatParticles: 'beatParticlesAmt', scaleToSound: 'scaleToSoundAmt', chromaAb: 'chromaAbAmt', crossfade: 'crossfadeDur' };
  const AMOUNTS = new Set(Object.values(AMOUNT_OF));
  const NEEDS = { bgCoverBlur: 'bgCoverArt', bgCoverDim: 'bgCoverArt' };

  function item(k, v) {
    const label = LABELS[k];
    if (typeof v === 'boolean') return { text: v ? label : label + ' off' };
    if (COLOR_KEYS.has(k)) return v === 'transparent' ? { text: label + ' transparent' } : { text: label, color: v };
    if (k === 'sens') return { text: label + ' ' + (v / 100).toFixed(1) };
    if (k === 'count') return { text: v + ' bars' };
    return { text: label + ' ' + v + (UNITS[k] || '') };
  }

  function summarize(settings, opts = {}) {
    const s = Object.assign({}, DEFAULTS, pick(settings));
    const changed = k => s[k] !== DEFAULTS[k];
    const rows = [];
    for (const g of GROUPS) {
      const items = [];
      if (g.id === 'shape') items.push({ text: LAYOUT_NAMES[s.layout] || s.layout, strong: true });
      if (g.id === 'color') {
        items.push({ text: s.mode, strong: true });
        if (s.mode === 'cover') items.push({ text: 'fallback', color: s.color1 });
        else items.push({ text: s.mode === 'gradient' ? 'from' : 'color', color: s.color1 });
        if (s.mode === 'gradient') items.push({ text: 'to', color: s.color2 });
        if (s.rainbow) items.push({ text: 'rainbow cycle' });
      }
      if (g.id === 'visualizer') {
        items.push({ text: s.legacy ? 'legacy' : 'normal', strong: true });
        if (changed('sens')) items.push(item('sens', s.sens));
        if (s.legacy) { for (const k of ['smooth', 'fall']) if (changed(k)) items.push(item(k, s[k])); }
        else {
          const tweaks = g.keys.filter(([k]) => k.startsWith('spec') && changed(k)).length;
          if (tweaks) items.push({ text: `advanced spectrum (${tweaks} change${tweaks > 1 ? 's' : ''})` });
        }
      }
      if (g.id === 'audio') {
        const curve = Array.from({ length: 10 }, (_, i) => s['eq' + i]);
        const named = Object.keys(EQ_CURVES).find(n => EQ_CURVES[n].every((v, i) => v === curve[i]));
        if (named !== 'flat') items.push({ text: 'eq ' + (named ? EQ_NAMES[named] : 'custom'), eq: curve });
      }
      if (g.id === 'midi' && s.soundfontName) {
        items.push({ text: 'soundfont ' + s.soundfontName, warn: opts.soundfontMissing ? "can't be found" : '' });
      }
      if (g.id === 'background') {
        items.push(s.bg === 'transparent' ? { text: 'transparent', strong: true } : { text: 'color', color: s.bg });
      }
      for (const [k, , label] of g.keys) {
        if (!label || !changed(k)) continue;
        if (g.id === 'color' || k === 'layout' || k === 'bg' || k === 'soundfontName' || k === 'legacy' || k === 'sens' || k === 'smooth' || k === 'fall') continue;
        if (SHAPE_ONLY[k] && !SHAPE_ONLY[k].includes(s.layout)) continue;
        if (NEEDS[k] && !s[NEEDS[k]]) continue;
        if (AMOUNTS.has(k)) continue;
        if (AMOUNT_OF[k] && s[k]) { const a = AMOUNT_OF[k]; items.push({ text: label + ' ' + s[a] + (UNITS[a] || '') }); continue; }
        items.push(item(k, s[k]));
      }
      rows.push({ id: g.id, label: g.label, items });
    }
    return rows;
  }

  // ----- summary rendering -----
  const SUMMARY_CSS = `
  .mps { display: flex; flex-direction: column; gap: 4px; }
  .mps-row { display: flex; gap: 10px; align-items: baseline; padding: 6px 10px; border-radius: 8px; background: rgba(255,255,255,.04); }
  .mps-k { flex: 0 0 86px; color: rgba(255,255,255,.5); font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; }
  .mps-v { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11.5px; color: rgba(255,255,255,.85); }
  .mps-item { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
  .mps-strong { color: #fff; }
  .mps-def { color: rgba(255,255,255,.4); }
  .mps-warn { color: #ff9b9b; }
  .mps-chip { width: 11px; height: 11px; border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.25); flex: 0 0 auto; }
  .mps-eq { display: block; flex: 0 0 auto; }`;
  function ensureSummaryStyle(doc) {
    if (doc.getElementById('mps-style')) return;
    const st = doc.createElement('style');
    st.id = 'mps-style';
    st.textContent = SUMMARY_CSS;
    doc.head.appendChild(st);
  }
  function renderSummary(rows, doc = document) {
    ensureSummaryStyle(doc);
    const el = (cls, text) => {
      const e = doc.createElement('span');
      e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const wrap = doc.createElement('div');
    wrap.className = 'mps';
    for (const r of rows) {
      const row = doc.createElement('div');
      row.className = 'mps-row';
      const vals = doc.createElement('div');
      vals.className = 'mps-v';
      if (!r.items.length) vals.appendChild(el('mps-item mps-def', 'default'));
      for (const it of r.items) {
        const node = el('mps-item' + (it.strong ? ' mps-strong' : '') + (it.warn ? ' mps-warn' : ''));
        node.appendChild(doc.createTextNode(it.text + (it.warn ? ' — ' + it.warn : '')));
        if (it.color) {
          const chip = el('mps-chip');
          chip.style.background = it.color;
          chip.title = it.color;
          node.appendChild(chip);
        }
        if (it.eq) {
          const ns = 'http://www.w3.org/2000/svg';
          const svg = doc.createElementNS(ns, 'svg');
          svg.setAttribute('class', 'mps-eq');
          svg.setAttribute('width', '49'); svg.setAttribute('height', '20');
          const base = doc.createElementNS(ns, 'rect');
          base.setAttribute('x', '0'); base.setAttribute('y', '9.5'); base.setAttribute('width', '49'); base.setAttribute('height', '1');
          base.setAttribute('fill', 'rgba(255,255,255,.18)');
          svg.appendChild(base);
          // scaled to the curve's own peak
          const peak = Math.max(6, ...it.eq.map(Math.abs));
          it.eq.forEach((v, i) => {
            const h = Math.abs(v) / peak * 9;
            if (h < 0.5) return;
            const bar = doc.createElementNS(ns, 'rect');
            bar.setAttribute('x', String(i * 5)); bar.setAttribute('width', '4');
            bar.setAttribute('y', String(v >= 0 ? 10 - h : 10)); bar.setAttribute('height', String(h));
            bar.setAttribute('rx', '1'); bar.setAttribute('fill', 'rgba(255,255,255,.8)');
            svg.appendChild(bar);
          });
          node.appendChild(svg);
        }
        vals.appendChild(node);
      }
      row.append(el('mps-k', r.label), vals);
      wrap.appendChild(row);
    }
    return wrap;
  }

  window.MediyyuPresets = {
    FORMAT, VERSION, EXT, MAX_SLOTS, NAME_MAX, DEFAULTS, KEYS, GROUPS, EQ_CURVES,
    pick, serialize, parse, fileName, cleanName, summarize, renderSummary,
  };
})();
