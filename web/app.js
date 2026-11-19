const $ = (sel) => document.querySelector(sel);
const enc = encodeURIComponent;

const COLS = 4;
const ROWS = 3;
const SLOTS = COLS * ROWS;
const CARD_W = 0.56;
const CARD_H = 0.35;
const GAP_X = 0.62;
const GAP_Y = 0.46;
const GALLERY_Z = -2.2;
const NAV_Y = -0.92;
const NAV_W = 0.52;
const NAV_H = 0.17;
const NAV_X = 0.95;
const EXIT_W = 0.9;
const DELETE_Y = -0.755;
const DELETE_W = 0.9;
const DELETE_H = 0.12;
const DELETE_TIMEOUT = 5000;
const BAR_X = 1.42;
const BAR_TOP = 0.72;
const BAR_HEIGHT = 1.44;
const BAR_WIDTH = 0.035;
const STICK_DEAD = 0.6;
const STICK_REPEAT = 320; // мс между повторами при удержании
const PHOTO_SEGMENTS = 64; // сегменты по горизонтали для изогнутого экрана
const CURVE_STEP = 0.08; // шаг изменения изгиба за один повтор стика
const PAN_STEP = 0.08; // шаг панорамы за один повтор стика
const SHIFT_STEP = 0.005; // шаг стерео-сдвига (0.5% ширины глаза)
const PAN_BASE = 0.35; // смещение при 1×, чтобы слайдер всегда давал эффект
const PAN_GAIN = 1.0; // дополнительное смещение при зуме
// Луч попадает в плашку только по её центральной области: промежутки между
// плашками остаются «пустым местом» и не перехватывают выделение стиком.
const HIT_W = CARD_W * 0.44;
const HIT_H = CARD_H * 0.42;

const state = {
  config: null,
  dict: {},
  lang: 'ru',
  langs: [],
  selected: new Set(), // путь картинки внутри текущего каталога
  zoomByRoot: {},
  zoomSaveTimer: null,
  curveByRoot: {},
  curveSaveTimer: null,
  viewByRoot: {},
  viewSaveTimer: null,
  view: { panX: 0, panY: 0, shift: 0 },
  rootId: '',
  rel: '',
  entries: [],
  images: [],
  current: -1,
  session: null,
  refSpace: null,
  gl: null,
  program: null,
  loc: null,
  vbo: null,
  photoVbo: null,
  photoData: null,
  photoVertexCount: 0,
  texPhoto: null,
  texLabel: null,
  texWhite: null,
  texHeader: null,
  texFirst: null,
  firstCanvas: null,
  texLast: null,
  lastCanvas: null,
  texExit: null,
  exitCanvas: null,
  texDelete: null,
  deleteCanvas: null,
  texMark: null,
  markCanvas: null,
  texCards: [],
  blankCard: null,
  labelCanvas: null,
  headerCanvas: null,
  distance: 2.0,
  height: 1.2,
  aspect: 1.0,
  mode: 'photo', // photo | gallery
  zoom: 1.0,
  curve: 0, // 0 — плоский экран, 1 — максимальный изгиб
  axis: { x: 0, y: 0, last: 0 },
  curveAxis: { y: 0, last: 0 },
  panAxis: { x: 0, y: 0, last: 0 },
  shiftAxis: { x: 0, last: 0 },
  buttons: { stick: false, b: false, a: false, grip: false, trigger: false },
  gallery: {
    rel: '', entries: [], cursor: 0, offset: 0, gen: 0,
    ray: null, hover: -1, navHover: '',
    deleteArmed: false, deleteArmedAt: 0,
  },
};

// ---------------------------------------------------------------------------
// API / UI
// ---------------------------------------------------------------------------

async function api(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

function t(key, vars = {}) {
  let text = state.dict[key] || key;
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

async function saveState(payload) {
  try {
    await fetch('/api/state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* офлайн — сохранение пропускаем */ }
}

async function setLanguage(code, persist = true) {
  const res = await fetch(`/i18n/${encodeURIComponent(code)}.json`);
  if (!res.ok) throw new Error(`Language ${code} not found`);
  state.dict = await res.json();
  state.lang = code;
  document.documentElement.lang = code;
  applyTexts();
  const selector = $('#langSelect');
  if (selector) selector.value = code;
  if (state.gl) {
    if (state.current >= 0) updateLabel(state.entries[state.current]);
    updateGalleryHeader();
    uploadNavButtons(state.gl);
  }
  if (persist) await saveState({ lang: code });
}

function applyTexts() {
  document.title = t('title');
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  const preview = $('#preview');
  if (preview && !preview.querySelector('img')) preview.textContent = t('chooseImage');
  if (state.current >= 0) updateInfo(state.entries[state.current]);
  updateSelectionUI();
}

function showError(err) {
  const box = $('#error');
  box.textContent = typeof err === 'string' ? err : err.message || String(err);
  box.hidden = false;
}

function rootCfg() {
  return state.config.roots.find((r) => r.id === state.rootId) || {};
}

function imageUrl(entry) {
  return `/api/image?root=${enc(state.rootId)}&path=${enc(entry.path)}&max=${state.config.maxTextureSize || 0}`;
}

function thumbUrl(entry) {
  return `/api/thumb?root=${enc(state.rootId)}&path=${enc(entry.path)}`;
}

async function loadImage(url) {
  const img = new Image();
  img.src = url;
  if (img.decode) {
    try {
      await img.decode();
      return img;
    } catch { /* fallback ниже */ }
  }
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
  return img;
}

async function init() {
  const [cfg, saved, langs] = await Promise.all([
    api('/api/config'),
    api('/api/state'),
    api('/api/i18n/list'),
  ]);
  state.config = cfg;
  state.langs = langs;
  const qrLink = $('#qrLink');
  if (qrLink) qrLink.hidden = !cfg.qr;
  state.zoomByRoot = saved.zoom || {};
  state.curveByRoot = saved.curve || {};
  state.viewByRoot = saved.view || {};

  const langSelect = $('#langSelect');
  for (const lang of langs) langSelect.add(new Option(lang.name, lang.code));
  langSelect.addEventListener('change', () => setLanguage(langSelect.value).catch(showError));

  const has = (code) => langs.some((l) => l.code === code);
  const initialLang = has(saved.lang) ? saved.lang : (has(cfg.language) ? cfg.language : (langs[0]?.code || 'ru'));
  await setLanguage(initialLang, false);

  $('#url').textContent = location.origin;
  $('#questUrl').textContent = `https://${cfg.ip}:${cfg.port}`;

  const sel = $('#rootSelect');
  for (const r of cfg.roots) sel.add(new Option(r.name, r.id));
  sel.addEventListener('change', () => {
    state.rootId = sel.value;
    state.rel = '';
    state.zoom = state.zoomByRoot[state.rootId] ?? 1.0;
    setCurve(state.curveByRoot[state.rootId] ?? 0, false);
    applyViewFromRoot(state.rootId);
    saveState({ root: state.rootId }).catch(() => {});
    list().catch(showError);
  });

  $('#curveRange').addEventListener('input', (e) => {
    setCurve(Number(e.target.value) / 100);
  });

  for (const [key, factor] of Object.entries({ panX: 100, panY: 100, shift: 100 })) {
    $(`#${key}Range`).addEventListener('input', (e) => {
      setView({ [key]: Number(e.target.value) / factor });
    });
  }
  $('#resetViewBtn').addEventListener('click', resetView);

  $('#upBtn').addEventListener('click', () => {
    const parts = state.rel.split('/').filter(Boolean);
    parts.pop();
    state.rel = parts.join('/');
    list().catch(showError);
  });

  $('#firstBtn').addEventListener('click', () => jumpToEdge(-1));
  $('#lastBtn').addEventListener('click', () => jumpToEdge(1));
  $('#deleteBtn').addEventListener('click', () => deleteSelected().catch(showError));
  $('#markBtn').addEventListener('click', () => markCurrentOrHovered());

  $('#vrBtn').addEventListener('click', () => enterVR().catch(showError));
  window.addEventListener('keydown', (e) => onKey(e));

  if (cfg.roots.length) {
    const hasRoot = (id) => cfg.roots.some((r) => r.id === id);
    state.rootId = hasRoot(saved.root) ? saved.root : cfg.roots[0].id;
    sel.value = state.rootId;
    state.zoom = state.zoomByRoot[state.rootId] ?? 1.0;
    setCurve(state.curveByRoot[state.rootId] ?? 0, false);
    applyViewFromRoot(state.rootId);
    await list();
  } else {
    showError(t('errNoRoots'));
  }
}

async function list(clearSelection = true) {
  const data = await api(`/api/list?root=${enc(state.rootId)}&path=${enc(state.rel)}`);
  applyListing(data, clearSelection);
}

function applyListing(data, clearSelection = true) {
  if (clearSelection) state.selected.clear();
  state.entries = data.entries;
  state.images = data.entries.filter((e) => e.type === 'image');
  state.current = -1;
  $('#vrBtn').disabled = true;
  $('#error').hidden = true;

  const parts = state.rel.split('/').filter(Boolean);
  $('#crumb').textContent = [rootCfg().name, ...parts].join(' / ');
  renderGrid();
  updateSelectionUI();
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  for (const entry of state.entries) {
    const card = document.createElement('button');
    card.className = 'card';
    card.dataset.path = entry.path;
    if (entry.type === 'image' && state.selected.has(entry.path)) card.classList.add('picked');
    if (entry.type === 'dir') {
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = '📁';
      const label = document.createElement('span');
      label.textContent = entry.name;
      card.append(thumb, label);
      card.addEventListener('click', () => {
        state.rel = entry.path;
        list().catch(showError);
      });
    } else {
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.loading = 'lazy';
      thumb.alt = '';
      thumb.src = thumbUrl(entry);
      const badge = document.createElement('span');
      badge.className = 'pick';
      badge.textContent = state.selected.has(entry.path) ? '✓' : '+';
      badge.title = t('markTitle');
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMark(entry);
      });
      const label = document.createElement('span');
      label.textContent = entry.name;
      card.append(thumb, badge, label);
      card.addEventListener('click', () => openImage(entry).catch(showError));
    }
    grid.append(card);
  }
}

function updateSelectionUI() {
  const count = state.selected.size;
  if (!count && state.gallery.deleteArmed) {
    state.gallery.deleteArmed = false;
  }
  const button = $('#deleteBtn');
  if (button) {
    button.textContent = t('deleteSelected', { count });
    button.disabled = count === 0;
  }
  document.querySelectorAll('#grid .card').forEach((card) => {
    const marked = state.selected.has(card.dataset.path);
    card.classList.toggle('picked', marked);
    const badge = card.querySelector('.pick');
    if (badge) badge.textContent = marked ? '✓' : '+';
  });
  const markBtn = $('#markBtn');
  if (markBtn) {
    const entry = state.entries[state.current];
    const marked = !!(entry && state.selected.has(entry.path));
    markBtn.disabled = !entry || entry.type !== 'image';
    markBtn.classList.toggle('picked', marked);
  }
  if (state.gl) {
    uploadDeleteTexture(state.gl);
    updateGalleryHeader();
  }
}

function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  updateSelectionUI();
}

function toggleMark(entry) {
  if (!entry || entry.type !== 'image') return;
  if (state.selected.has(entry.path)) state.selected.delete(entry.path);
  else state.selected.add(entry.path);
  updateSelectionUI();
  if (state.gl && state.mode === 'photo' && state.current >= 0) {
    updateLabel(state.entries[state.current]);
  }
  if (state.mode === 'gallery') loadGalleryPage();
}

function markCurrentOrHovered(useCursorFallback = false) {
  if (state.mode === 'gallery') {
    const g = state.gallery;
    if (g.navHover) return;
    const index = g.hover >= 0 ? g.hover : (useCursorFallback ? g.cursor : -1);
    const entry = g.entries[index];
    if (entry && entry.type === 'image') toggleMark(entry);
  } else {
    const entry = state.entries[state.current];
    if (entry && entry.type === 'image') toggleMark(entry);
  }
}

async function refreshGallery() {
  const g = state.gallery;
  const data = await api(`/api/list?root=${enc(state.rootId)}&path=${enc(g.rel)}`);
  if (g.rel === state.rel) applyListing(data, false);
  g.entries = buildGalleryEntries(data.entries, g.rel);
  g.cursor = 0;
  g.offset = 0;
  g.ray = null;
  g.hover = -1;
  g.navHover = '';
  g.deleteArmed = false;
  loadGalleryPage();
  updateGalleryHeader();
  updateSelectionUI();
}

async function deleteSelected(confirmFirst = true) {
  const paths = [...state.selected];
  if (!paths.length) {
    showError(t('errNoSelection'));
    return;
  }
  const confirmKey = state.config && state.config.trash ? 'deleteConfirmTrash' : 'deleteConfirm';
  if (confirmFirst && !window.confirm(t(confirmKey, { count: paths.length }))) return;
  const rel = state.mode === 'gallery' ? state.gallery.rel : state.rel;
  await apiPost('/api/delete', { root: state.rootId, rel, paths });
  state.selected.clear();
  if (state.mode === 'gallery') {
    await refreshGallery();
  } else {
    state.current = -1;
    await list();
  }
}

function armDelete() {
  const g = state.gallery;
  if (!state.selected.size) {
    showError(t('errNoSelection'));
    return;
  }
  if (!g.deleteArmed) {
    g.deleteArmed = true;
    g.deleteArmedAt = performance.now();
    if (state.gl) uploadDeleteTexture(state.gl);
    return;
  }
  deleteSelected(false).catch(showError);
}

// Кнопки «в начало / в конец»: прокручиваем сетку к нужной карточке,
// подсвечиваем её и открываем — так же, как если бы по ней кликнули.
function jumpToEdge(direction) {
  const candidates = state.images.length ? state.images : state.entries.filter((e) => e.type === 'dir');
  if (!candidates.length) return;
  const entry = direction < 0 ? candidates[0] : candidates[candidates.length - 1];

  const grid = $('#grid');
  grid.querySelectorAll('.card.active').forEach((el) => el.classList.remove('active'));
  const card = Array.from(grid.querySelectorAll('.card')).find((el) => el.dataset.path === entry.path);
  if (card) {
    card.classList.add('active');
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  if (entry.type === 'image') {
    openImage(entry).catch(showError);
  } else {
    state.rel = entry.path;
    list().catch(showError);
  }
}

function updateInfo(entry) {
  const rc = rootCfg();
  $('#info').textContent = t('info', {
    name: entry.name,
    width: entry.width || '?',
    height: entry.height || '?',
    sbs: rc.sbs,
    count: state.images.length,
  });
}

async function openImage(entry) {
  state.current = state.entries.indexOf(entry);
  const preview = $('#preview');
  preview.replaceChildren();
  const img = new Image();
  img.src = imageUrl(entry);
  img.alt = entry.name;
  preview.append(img);
  updateInfo(entry);
  $('#vrBtn').disabled = false;
  updateSelectionUI();
  await loadPhoto(entry);
}

async function loadPhoto(entry) {
  const rc = rootCfg();
  const img = await loadImage(imageUrl(entry));
  const imgAspect = img.width / img.height;
  state.aspect = rc.eyeAspect || (rc.sbs === 'half' ? imgAspect : imgAspect / 2);
  state.distance = rc.distance || 2.0;
  state.height = rc.height || 1.2;
  if (state.gl) {
    uploadImage(state.gl, state.texPhoto, img);
    updateLabel(entry);
  }
}

function step(delta) {
  if (!state.images.length) return;
  let i = state.images.indexOf(state.entries[state.current]);
  if (i < 0) i = 0;
  i = (i + delta + state.images.length) % state.images.length;
  const entry = state.images[i];
  state.current = state.entries.indexOf(entry);
  const previewImg = $('#preview img');
  if (previewImg) previewImg.src = imageUrl(entry);
  updateInfo(entry);
  loadPhoto(entry).catch(showError);
}

// ---------------------------------------------------------------------------
// WebGL
// ---------------------------------------------------------------------------

function makeTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function uploadImage(gl, tex, source) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader));
  }
  return shader;
}

function initGL(gl) {
  const vs = `
    attribute vec3 aPos;
    attribute vec2 aUv;
    uniform mat4 uMVP;
    uniform vec2 uUvOffset;
    uniform vec2 uUvScale;
    varying vec2 vUv;
    void main() {
      vUv = uUvOffset + aUv * uUvScale;
      gl_Position = uMVP * vec4(aPos, 1.0);
    }`;
  const fs = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uTint, 1.0);
    }`;

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program));
  }
  state.program = program;
  state.loc = {
    aPos: gl.getAttribLocation(program, 'aPos'),
    aUv: gl.getAttribLocation(program, 'aUv'),
    uMVP: gl.getUniformLocation(program, 'uMVP'),
    uUvOffset: gl.getUniformLocation(program, 'uUvOffset'),
    uUvScale: gl.getUniformLocation(program, 'uUvScale'),
    uTint: gl.getUniformLocation(program, 'uTint'),
    uTex: gl.getUniformLocation(program, 'uTex'),
  };

  const quad = new Float32Array([
    -0.5, -0.5, 0, 0, 0,
     0.5, -0.5, 0, 1, 0,
    -0.5,  0.5, 0, 0, 1,
     0.5,  0.5, 0, 1, 1,
  ]);
  state.vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(state.loc.aPos);
  gl.vertexAttribPointer(state.loc.aPos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(state.loc.aUv);
  gl.vertexAttribPointer(state.loc.aUv, 2, gl.FLOAT, false, 20, 12);

  // Сетка для изогнутого экрана: две вершины (верх/низ) на каждый сегмент.
  state.photoVertexCount = (PHOTO_SEGMENTS + 1) * 2;
  state.photoData = new Float32Array(state.photoVertexCount * 5);
  state.photoVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.photoVbo);
  gl.bufferData(gl.ARRAY_BUFFER, state.photoData.byteLength, gl.DYNAMIC_DRAW);

  state.texPhoto = makeTexture(gl);
  state.texLabel = makeTexture(gl);
  state.texHeader = makeTexture(gl);

  state.labelCanvas = document.createElement('canvas');
  state.labelCanvas.width = 1024;
  state.labelCanvas.height = 192;
  const lctx = state.labelCanvas.getContext('2d');
  lctx.fillStyle = '#10131a';
  lctx.fillRect(0, 0, 1024, 192);
  uploadImage(gl, state.texLabel, state.labelCanvas);

  state.headerCanvas = document.createElement('canvas');
  state.headerCanvas.width = 1024;
  state.headerCanvas.height = 128;
  const hctx = state.headerCanvas.getContext('2d');
  hctx.fillStyle = '#10131a';
  hctx.fillRect(0, 0, 1024, 128);
  uploadImage(gl, state.texHeader, state.headerCanvas);

  for (const name of ['first', 'last', 'exit', 'delete']) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    state[`${name}Canvas`] = canvas;
    state[`tex${name[0].toUpperCase()}${name.slice(1)}`] = makeTexture(gl);
  }
  uploadNavButtons(gl);

  state.markCanvas = document.createElement('canvas');
  state.markCanvas.width = state.markCanvas.height = 96;
  state.texMark = makeTexture(gl);
  uploadMarkTexture(gl);

  const white = document.createElement('canvas');
  white.width = white.height = 2;
  const wctx = white.getContext('2d');
  wctx.fillStyle = '#ffffff';
  wctx.fillRect(0, 0, 2, 2);
  state.texWhite = makeTexture(gl);
  uploadImage(gl, state.texWhite, white);

  state.blankCard = document.createElement('canvas');
  state.blankCard.width = 512;
  state.blankCard.height = 320;
  const bctx = state.blankCard.getContext('2d');
  bctx.fillStyle = '#161b27';
  bctx.fillRect(0, 0, 512, 320);
  state.texCards = [];
  for (let i = 0; i < SLOTS; i++) {
    const tex = makeTexture(gl);
    uploadImage(gl, tex, state.blankCard);
    state.texCards.push(tex);
  }

  gl.disable(gl.DEPTH_TEST);
}

function uploadNavButtons(gl) {
  const specs = [
    ['first', 'first', '#1d3550', '#cfe6ff'],
    ['last', 'last', '#1d3550', '#cfe6ff'],
    ['exit', 'exitVR', '#4a1d24', '#ffd7dc'],
  ];
  for (const [name, key, bg, fg] of specs) {
    const canvas = state[`${name}Canvas`];
    const tex = state[`tex${name[0].toUpperCase()}${name.slice(1)}`];
    if (!canvas || !tex) continue;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 512, 96);
    ctx.fillStyle = fg;
    ctx.font = 'bold 40px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t(key), 256, 48);
    uploadImage(gl, tex, canvas);
  }
  uploadDeleteTexture(gl);
}

function uploadDeleteTexture(gl) {
  const canvas = state.deleteCanvas;
  const tex = state.texDelete;
  if (!canvas || !tex) return;
  const count = state.selected.size;
  const armed = state.gallery.deleteArmed;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = !count ? '#242833' : (armed ? '#6a1f24' : '#3a2329');
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = !count ? '#7b8290' : (armed ? '#ffe1e1' : '#ffb9c2');
  ctx.font = 'bold 38px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(t(armed ? 'deleteVRConfirm' : 'deleteVR', { count }), 256, 48);
  uploadImage(gl, tex, canvas);
}

function uploadMarkTexture(gl) {
  const canvas = state.markCanvas;
  const tex = state.texMark;
  if (!canvas || !tex) return;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffd34d';
  ctx.beginPath();
  ctx.arc(48, 48, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#201a00';
  ctx.font = 'bold 60px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('✓', 48, 51);
  uploadImage(gl, tex, canvas);
}

function draw(gl, tex, mvp, uvOffset, uvScale, tint = [1, 1, 1], buffer = null, count = 4) {
  gl.useProgram(state.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer || state.vbo);
  gl.enableVertexAttribArray(state.loc.aPos);
  gl.vertexAttribPointer(state.loc.aPos, 3, gl.FLOAT, false, 20, 0);
  gl.enableVertexAttribArray(state.loc.aUv);
  gl.vertexAttribPointer(state.loc.aUv, 2, gl.FLOAT, false, 20, 12);
  gl.uniformMatrix4fv(state.loc.uMVP, false, mvp);
  gl.uniform2fv(state.loc.uUvOffset, uvOffset);
  gl.uniform2fv(state.loc.uUvScale, uvScale);
  gl.uniform3fv(state.loc.uTint, tint);
  gl.uniform1i(state.loc.uTex, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, count);
}

function drawPhotoMark(gl, proj, viewM) {
  const entry = state.entries[state.current];
  if (!entry || !state.selected.has(entry.path)) return;
  const halfW = (state.height * state.aspect) / 2;
  const z = state.distance / state.zoom;
  const halfH = state.height / 2;
  const s = 0.945; // чуть левее правого края, чтобы не срезалось при изгибе
  const xFlat = (s - 0.5) * 2 * halfW;
  const angle = Math.atan2(xFlat, z);
  const xCurved = z * Math.sin(angle);
  const zCurved = -z * Math.cos(angle);
  const x = xFlat + (xCurved - xFlat) * state.curve;
  const depth = -z + (zCurved + z) * state.curve - 0.01;
  const model = multiply(photoPanModel(), multiply(translate(x, halfH - 0.11, depth), scale(0.11, 0.11, 1)));
  draw(gl, state.texMark, multiply(proj, multiply(viewM, model)), [0, 0], [1, 1]);
}

function drawCurvedPhoto(gl, proj, viewM, uvOffset, uvScale, model) {
  const halfW = (state.height * state.aspect) / 2;
  const z = state.distance / state.zoom;
  const curve = state.curve;
  const halfH = state.height / 2;
  const data = state.photoData;

  let p = 0;
  for (let i = 0; i <= PHOTO_SEGMENTS; i++) {
    const s = i / PHOTO_SEGMENTS;
    const xFlat = (s - 0.5) * 2 * halfW;
    // Плоская точка и точка на цилиндре радиуса z с тем же углом обзора.
    const angle = Math.atan2(xFlat, z);
    const xCurved = z * Math.sin(angle);
    const zCurved = -z * Math.cos(angle);
    const x = xFlat + (xCurved - xFlat) * curve;
    const depth = -z + (zCurved + z) * curve;
    data[p++] = x; data[p++] = halfH; data[p++] = depth; data[p++] = s; data[p++] = 1;
    data[p++] = x; data[p++] = -halfH; data[p++] = depth; data[p++] = s; data[p++] = 0;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, state.photoVbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);

  draw(
    gl, state.texPhoto, multiply(proj, multiply(viewM, model)), uvOffset, uvScale,
    [1, 1, 1], state.photoVbo, state.photoVertexCount,
  );
}

function updateLabel(entry) {
  const canvas = state.labelCanvas;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const marked = !!(entry && state.selected.has(entry.path));
  ctx.fillStyle = marked ? '#ffd34d' : '#ffffff';
  ctx.font = '28px sans-serif';
  ctx.textBaseline = 'middle';
  const index = state.images.indexOf(entry) + 1;
  ctx.fillText(`${marked ? '✓ ' : ''}${index}/${state.images.length}  ${entry.name}`.slice(0, 60), 16, 58);
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '22px sans-serif';
  ctx.fillText(t('vrLabelHint', {
    zoom: state.zoom.toFixed(1),
    curve: Math.round(state.curve * 100),
    panX: signedPercent(state.view.panX),
    panY: signedPercent(state.view.panY),
    shift: signedPercent(state.view.shift, 1).replace('%', ''),
  }), 16, 142);
  uploadImage(state.gl, state.texLabel, canvas);
}

function zoomBy(direction) {
  const factor = direction < 0 ? 1.12 : 1 / 1.12; // вверх — приблизить
  state.zoom = Math.round(Math.min(2.5, Math.max(0.6, state.zoom * factor)) * 1000) / 1000;
  state.zoomByRoot[state.rootId] = state.zoom;
  const entry = state.entries[state.current];
  if (entry && state.gl) updateLabel(entry);

  // Сохраняем на сервер не чаще одного раза в 500 мс, чтобы не дёргать диск при удержании стика.
  clearTimeout(state.zoomSaveTimer);
  state.zoomSaveTimer = setTimeout(() => {
    saveState({ zoom: state.zoom, root: state.rootId }).catch(() => {});
  }, 500);
}

function updateCurveUI() {
  const percent = Math.round(state.curve * 100);
  const range = $('#curveRange');
  if (range) range.value = String(percent);
  const output = $('#curveValue');
  if (output) output.textContent = `${percent}%`;
}

function setCurve(value, persist = true) {
  const next = Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100) / 100;
  if (next !== state.curve) {
    state.curve = next;
    state.curveByRoot[state.rootId] = next;
    const entry = state.entries[state.current];
    if (entry && state.gl) updateLabel(entry);
    if (persist) {
      clearTimeout(state.curveSaveTimer);
      state.curveSaveTimer = setTimeout(() => {
        saveState({ curve: state.curve, root: state.rootId }).catch(() => {});
      }, 500);
    }
  }
  updateCurveUI();
}

function curveBy(direction) {
  // Вверх — больше изгиб, вниз — меньше (как зумом).
  setCurve(state.curve + (direction < 0 ? CURVE_STEP : -CURVE_STEP));
}

// ---------------------------------------------------------------------------
// Панорама и стерео-сдвиг (один блок настроек вида, сохраняется на каталог)
// ---------------------------------------------------------------------------

function normaliseView(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const number = (key, low, high, digits) => {
    const value = Number(src[key]);
    return Number.isFinite(value)
      ? Math.round(Math.min(high, Math.max(low, value)) * 10 ** digits) / 10 ** digits
      : 0;
  };
  return {
    panX: number('panX', -1, 1, 3),
    panY: number('panY', -1, 1, 3),
    shift: number('shift', -0.1, 0.1, 3),
  };
}

function applyViewFromRoot(rootId) {
  state.view = normaliseView(state.viewByRoot[rootId]);
  state.viewByRoot[rootId] = { ...state.view };
  updateViewUI();
  const entry = state.entries[state.current];
  if (entry && state.gl) updateLabel(entry);
}

function viewChanged(next) {
  return Object.keys(next).some((key) => next[key] !== state.view[key]);
}

function setView(values, persist = true) {
  const next = normaliseView({ ...state.view, ...values });
  if (!viewChanged(next)) return;
  state.view = next;
  state.viewByRoot[state.rootId] = { ...next };
  updateViewUI();
  const entry = state.entries[state.current];
  if (entry && state.gl) updateLabel(entry);
  if (persist) {
    clearTimeout(state.viewSaveTimer);
    state.viewSaveTimer = setTimeout(() => {
      saveState({ view: state.view, root: state.rootId }).catch(() => {});
    }, 500);
  }
}

function panBy(dx, dy) {
  if (!dx && !dy) return;
  setView({
    panX: state.view.panX - dx * PAN_STEP, // стик вправо — смотрим правее, кадр уходит влево
    panY: state.view.panY + dy * PAN_STEP, // стик вверх — смотрим выше, кадр уходит вниз
  });
}

function shiftBy(dx) {
  if (!dx) return;
  setView({ shift: state.view.shift + dx * SHIFT_STEP });
}

function resetView() {
  setView({ panX: 0, panY: 0, shift: 0 });
}

function signedPercent(value, digits = 0) {
  const factor = 10 ** digits;
  const percent = Math.round(value * 100 * factor) / factor;
  return `${percent > 0 ? '+' : ''}${percent}%`;
}

function updateViewUI() {
  for (const key of ['panX', 'panY', 'shift']) {
    const range = $(`#${key}Range`);
    const output = $(`#${key}Value`);
    const digits = key === 'shift' ? 1 : 0;
    const percent = Math.round(state.view[key] * 100 * 10 ** digits) / 10 ** digits;
    if (range) range.value = String(percent);
    if (output) output.textContent = signedPercent(state.view[key], digits);
  }
  const reset = $('#resetViewBtn');
  if (reset) {
    reset.disabled = !state.view.panX && !state.view.panY && !state.view.shift;
  }
}

function photoPanModel() {
  const halfW = (state.height * state.aspect) / 2;
  const halfH = state.height / 2;
  const gain = PAN_BASE + Math.max(0, 1 - 1 / state.zoom) * PAN_GAIN;
  return translate(state.view.panX * halfW * gain, state.view.panY * halfH * gain, 0);
}

function photoEyeModel(right) {
  const pan = photoPanModel();
  if (!right || !state.view.shift) return pan;
  const halfW = (state.height * state.aspect) / 2;
  return multiply(pan, translate(state.view.shift * halfW, 0, 0));
}

// ---------------------------------------------------------------------------
// 3D-галерея
// ---------------------------------------------------------------------------

function buildGalleryEntries(entries, rel) {
  const hasParent = rel.split('/').filter(Boolean).length > 0;
  const up = hasParent ? [{ type: 'up', name: t('up'), path: '' }] : [];
  return [...up, ...entries];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setCursor(index) {
  const g = state.gallery;
  if (!g.entries.length) return;
  const next = clamp(index, 0, g.entries.length - 1);
  const changed = next !== g.cursor;
  g.cursor = next;

  const maxOffset = Math.max(0, g.entries.length - SLOTS);
  let offset = g.offset;
  if (g.cursor < offset) offset = g.cursor;
  if (g.cursor >= offset + SLOTS) offset = g.cursor - SLOTS + 1;
  offset = clamp(offset, 0, maxOffset);
  if (offset !== g.offset) {
    g.offset = offset;
    loadGalleryPage();
  }
  if (changed) updateGalleryHeader();
}

function toggleGallery() {
  if (state.mode === 'gallery') {
    state.mode = 'photo';
    state.gallery.ray = null;
    state.gallery.hover = -1;
    state.gallery.navHover = '';
    state.gallery.deleteArmed = false;
    if (state.current >= 0) updateLabel(state.entries[state.current]);
    return;
  }
  const g = state.gallery;
  g.rel = state.rel;
  g.entries = buildGalleryEntries(state.entries, state.rel);
  const currentEntry = state.entries[state.current];
  const idx = g.entries.findIndex((e) => e.type === 'image' && e === currentEntry);
  g.cursor = idx >= 0 ? idx : 0;
  g.offset = clamp(g.cursor - Math.floor(SLOTS / 2), 0, Math.max(0, g.entries.length - SLOTS));
  g.ray = null;
  g.hover = -1;
  g.navHover = '';
  g.deleteArmed = false;
  state.mode = 'gallery';
  loadGalleryPage();
  updateGalleryHeader();
}

function moveCursor(delta) {
  setCursor(state.gallery.cursor + delta);
}

async function makeCardCanvas(entry) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 320;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#161b27';
  ctx.fillRect(0, 0, 512, 320);
  if (entry.type === 'image') {
    const img = await loadImage(thumbUrl(entry));
    ctx.drawImage(img, 0, 0, 512, 256);
  } else {
    ctx.font = '96px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(entry.type === 'dir' ? '📁' : '↩', 256, 128);
  }
  ctx.fillStyle = '#e7eaf0';
  ctx.font = '26px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(entry.name.slice(0, 34), 10, 300);
  if (entry.type === 'image' && state.selected.has(entry.path)) {
    ctx.fillStyle = '#ffd34d';
    ctx.fillRect(452, 12, 48, 48);
    ctx.fillStyle = '#201a00';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✓', 476, 37);
  }
  return c;
}

async function loadGalleryPage() {
  if (!state.gl) return;
  const g = state.gallery;
  const gen = ++g.gen;
  const start = g.offset;
  for (let slot = 0; slot < SLOTS; slot++) {
    const entry = g.entries[start + slot];
    if (!entry) {
      uploadImage(state.gl, state.texCards[slot], state.blankCard);
      continue;
    }
    try {
      const canvas = await makeCardCanvas(entry);
      if (gen !== g.gen || !state.gl) continue;
      uploadImage(state.gl, state.texCards[slot], canvas);
    } catch { /* оставляем заглушку */ }
  }
}

function updateGalleryHeader() {
  if (!state.gl) return;
  const g = state.gallery;
  const ctx = state.headerCanvas.getContext('2d');
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#ffffff';
  ctx.font = '36px sans-serif';
  ctx.textBaseline = 'middle';
  const where = `${rootCfg().name || ''}/${g.rel || ''}`;
  ctx.fillText(t('galleryTitle', { where }).slice(0, 44), 16, 44);
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '26px sans-serif';
  ctx.fillText(t('galleryHint', {
    index: g.entries.length ? g.cursor + 1 : 0,
    total: g.entries.length,
  }), 16, 96);
  uploadImage(state.gl, state.texHeader, state.headerCanvas);
}

async function openGallerySelection(index = state.gallery.cursor) {
  const g = state.gallery;
  const entry = g.entries[index];
  if (!entry) return;
  if (entry.type === 'up') {
    const parts = g.rel.split('/').filter(Boolean);
    parts.pop();
    g.rel = parts.join('/');
  } else if (entry.type === 'dir') {
    g.rel = entry.path;
  } else {
    state.rel = g.rel;
    await list(false); // открытие фото не покидает каталог — пометки сохраняем
    const target = state.entries.find((e) => e.path === entry.path && e.type === 'image');
    state.mode = 'photo';
    if (target) await openImage(target);
    return;
  }
  const data = await api(`/api/list?root=${enc(state.rootId)}&path=${enc(g.rel)}`);
  clearSelection(); // перешли в другой каталог — пометки сбрасываются
  g.entries = buildGalleryEntries(data.entries, g.rel);
  g.cursor = 0;
  g.offset = 0;
  g.ray = null;
  g.hover = -1;
  g.navHover = '';
  g.deleteArmed = false;
  loadGalleryPage();
  updateGalleryHeader();
}

function renderGallery(gl, proj, viewM) {
  const g = state.gallery;
  for (let slot = 0; slot < SLOTS; slot++) {
    const idx = g.offset + slot;
    const entry = g.entries[idx];
    if (!entry) break;
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const x = (col - (COLS - 1) / 2) * GAP_X;
    const y = ((ROWS - 1) / 2 - row) * GAP_Y;

    if (idx === g.cursor || idx === g.hover) {
      const hovered = idx === g.hover && idx !== g.cursor;
      // Луч в пустом месте: подсвечиваем курсор ярче — триггер откроет именно его.
      const armed = idx === g.cursor && g.ray && g.hover < 0 && !g.navHover;
      const hm = multiply(
        translate(x, y, GALLERY_Z - 0.02),
        scale(CARD_W + (armed ? 0.085 : 0.055), CARD_H + (armed ? 0.085 : 0.055), 1),
      );
      const tint = hovered ? [0.5, 0.9, 1.0] : (armed ? [0.45, 1.0, 0.75] : [0.2, 0.55, 1.0]);
      draw(gl, state.texWhite, multiply(proj, multiply(viewM, hm)), [0, 0], [1, 1], tint);
    }

    const model = multiply(translate(x, y, GALLERY_Z), scale(CARD_W, CARD_H, 1));
    draw(gl, state.texCards[slot], multiply(proj, multiply(viewM, model)), [0, 0], [1, 1]);
  }

  const count = g.entries.length;
  const track = multiply(translate(BAR_X, 0, GALLERY_Z), scale(BAR_WIDTH, BAR_HEIGHT, 1));
  draw(gl, state.texWhite, multiply(proj, multiply(viewM, track)), [0, 0], [1, 1], [0.12, 0.14, 0.2]);

  const thumbH = Math.max(0.16, count > SLOTS ? BAR_HEIGHT * SLOTS / count : BAR_HEIGHT);
  const travel = BAR_HEIGHT - thumbH;
  const frac = count > SLOTS ? g.offset / (count - SLOTS) : 0;
  const thumbY = BAR_TOP - thumbH / 2 - frac * travel;
  const thumb = multiply(
    translate(BAR_X, thumbY, GALLERY_Z - 0.01),
    scale(BAR_WIDTH * 1.8, thumbH, 1),
  );
  draw(gl, state.texWhite, multiply(proj, multiply(viewM, thumb)), [0, 0], [1, 1], [0.25, 0.6, 1.0]);

  const deleteModel = multiply(
    translate(0, DELETE_Y, GALLERY_Z - 0.015),
    scale(DELETE_W, DELETE_H, 1),
  );
  const deleteTint = g.navHover === 'delete'
    ? [1.5, 1.2, 1.2]
    : (g.deleteArmed ? [1.3, 1.1, 1.1] : [1, 1, 1]);
  draw(gl, state.texDelete, multiply(proj, multiply(viewM, deleteModel)), [0, 0], [1, 1], deleteTint);

  const navButtons = [
    [state.texFirst, -NAV_X, NAV_W, 'first'],
    [state.texExit, 0, EXIT_W, 'exit'],
    [state.texLast, NAV_X, NAV_W, 'last'],
  ];
  for (const [tex, x, width, name] of navButtons) {
    const model = multiply(translate(x, NAV_Y, GALLERY_Z - 0.01), scale(width, NAV_H, 1));
    const tint = g.navHover === name ? [1.4, 1.2, 1.2] : [1, 1, 1];
    draw(gl, tex, multiply(proj, multiply(viewM, model)), [0, 0], [1, 1], tint);
  }

  const headerModel = multiply(translate(0, 0.92, GALLERY_Z), scale(1.8, 0.225, 1));
  draw(gl, state.texHeader, multiply(proj, multiply(viewM, headerModel)), [0, 0], [1, 1]);

  if (g.ray) {
    const beam = beamModel(g.ray.origin, g.ray.point);
    draw(gl, state.texWhite, multiply(proj, multiply(viewM, beam)), [0, 0], [1, 1], [0.25, 0.7, 1.0]);
  }
}

// ---------------------------------------------------------------------------
// Матрицы (column-major)
// ---------------------------------------------------------------------------

function multiply(a, b) {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function translate(x, y, z) {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

function scale(x, y, z) {
  const m = new Float32Array(16);
  m[0] = x; m[5] = y; m[10] = z; m[15] = 1;
  return m;
}

// ---------------------------------------------------------------------------
// Луч правого контроллера (только для галереи)
// ---------------------------------------------------------------------------

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function rotateByQuat(v, q) {
  const qv = { x: q.x, y: q.y, z: q.z };
  const uv = cross(qv, v);
  const uuv = cross(qv, uv);
  return {
    x: v.x + 2 * (q.w * uv.x + uuv.x),
    y: v.y + 2 * (q.w * uv.y + uuv.y),
    z: v.z + 2 * (q.w * uv.z + uuv.z),
  };
}

function beamModel(origin, end) {
  const dx = end.x - origin.x;
  const dy = end.y - origin.y;
  const dz = end.z - origin.z;
  const len = Math.hypot(dx, dy, dz) || 0.001;
  const forward = { x: dx / len, y: dy / len, z: dz / len };
  const hint = Math.abs(forward.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const right = cross(forward, hint);
  const rLen = Math.hypot(right.x, right.y, right.z) || 1;
  right.x /= rLen; right.y /= rLen; right.z /= rLen;
  const up = cross(right, forward);
  const width = 0.006;

  const m = new Float32Array(16);
  m[0] = right.x * width; m[1] = right.y * width; m[2] = right.z * width;
  m[4] = forward.x * len; m[5] = forward.y * len; m[6] = forward.z * len;
  m[8] = up.x * width; m[9] = up.y * width; m[10] = up.z * width;
  m[12] = (origin.x + end.x) / 2;
  m[13] = (origin.y + end.y) / 2;
  m[14] = (origin.z + end.z) / 2;
  m[15] = 1;
  return m;
}

function computeRay(frame, refSpace, source) {
  if (state.mode !== 'gallery' || !source || !source.targetRaySpace) return null;
  const pose = frame.getPose(source.targetRaySpace, refSpace);
  if (!pose) return null;

  const origin = pose.transform.position;
  const dir = rotateByQuat({ x: 0, y: 0, z: -1 }, pose.transform.orientation);
  const ray = { origin, dir, point: null, index: -1, nav: '' };

  if (Math.abs(dir.z) > 1e-4) {
    const t = (GALLERY_Z - origin.z) / dir.z;
    if (t > 0) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      ray.point = { x, y, z: GALLERY_Z };

      if (Math.abs(x) <= DELETE_W / 2 && Math.abs(y - DELETE_Y) <= DELETE_H / 2) {
        ray.nav = 'delete';
      } else if (Math.abs(y - NAV_Y) <= NAV_H / 2) {
        if (Math.abs(x) <= EXIT_W / 2) ray.nav = 'exit';
        else if (Math.abs(x + NAV_X) <= NAV_W / 2) ray.nav = 'first';
        else if (Math.abs(x - NAV_X) <= NAV_W / 2) ray.nav = 'last';
      }
      if (!ray.nav) {
        const g = state.gallery;
        for (let slot = 0; slot < SLOTS; slot++) {
          const col = slot % COLS;
          const row = Math.floor(slot / COLS);
          const cx = (col - (COLS - 1) / 2) * GAP_X;
          const cy = ((ROWS - 1) / 2 - row) * GAP_Y;
          if (Math.abs(x - cx) <= HIT_W && Math.abs(y - cy) <= HIT_H) {
            ray.index = g.offset + slot;
            break;
          }
        }
      }
    }
  }

  if (!ray.point) {
    ray.point = {
      x: origin.x + dir.x * 2.5,
      y: origin.y + dir.y * 2.5,
      z: origin.z + dir.z * 2.5,
    };
  }
  return ray;
}

// ---------------------------------------------------------------------------
// Ввод
// ---------------------------------------------------------------------------

function rightInputSource(session) {
  for (const src of Array.from(session.inputSources || [])) {
    if (src.handedness === 'right') return src;
  }
  return null;
}

function handleInput(pad, time) {
  let dx = 0;
  let dy = 0;
  let stickPressed = false;
  let bPressed = false;
  let aPressed = false;
  let gripPressed = false;
  let triggerPressed = false;

  if (pad) {
    const axes = pad.axes || [];
    const rx = axes.length >= 3 ? axes[2] : (axes[0] || 0);
    const ry = axes.length >= 4 ? axes[3] : (axes[1] || 0);
    if (Math.abs(rx) > STICK_DEAD) dx = Math.sign(rx);
    if (Math.abs(ry) > STICK_DEAD) dy = Math.sign(ry);
    const buttons = pad.buttons || [];
    triggerPressed = !!(buttons[0] && buttons[0].pressed);
    stickPressed = !!(buttons[3] && buttons[3].pressed);
    bPressed = !!(buttons[5] && buttons[5].pressed);
    aPressed = !!(buttons[4] && buttons[4].pressed);
    gripPressed = !!(buttons[1] && buttons[1].pressed);
  }

  const markToggle = aPressed && !state.buttons.a;
  state.buttons.a = aPressed;
  state.buttons.grip = gripPressed;
  state.buttons.trigger = triggerPressed;

  const toggle = (stickPressed && !state.buttons.stick) || (bPressed && !state.buttons.b);
  state.buttons.stick = stickPressed;
  state.buttons.b = bPressed;
  if (toggle) {
    toggleGallery();
    return;
  }
  if (markToggle) markCurrentOrHovered();

  // Триггер + стик в режиме фото — панорама по кадру.
  if (triggerPressed && state.mode === 'photo') {
    const pa = state.panAxis;
    if (dx || dy) {
      if (pa.x !== dx || pa.y !== dy || time - pa.last > STICK_REPEAT) {
        panBy(dx, dy);
        pa.x = dx;
        pa.y = dy;
        pa.last = time;
      }
    } else {
      pa.x = 0;
      pa.y = 0;
    }
    state.axis.x = 0;
    state.axis.y = 0;
    state.curveAxis.y = 0;
    state.shiftAxis.x = 0;
    return;
  }
  state.panAxis.x = 0;
  state.panAxis.y = 0;

  // Grip + стик: влево/вправо — стерео-сдвиг, вверх/вниз — изгиб экрана.
  if (gripPressed && state.mode === 'photo') {
    if (dx) {
      const sa = state.shiftAxis;
      if (sa.x !== dx || time - sa.last > STICK_REPEAT) {
        shiftBy(dx);
        sa.x = dx;
        sa.last = time;
      }
    } else {
      state.shiftAxis.x = 0;
    }
    if (dy) {
      const ca = state.curveAxis;
      if (ca.y !== dy || time - ca.last > STICK_REPEAT) {
        curveBy(dy);
        ca.y = dy;
        ca.last = time;
      }
    } else {
      state.curveAxis.y = 0;
    }
    state.axis.x = 0;
    state.axis.y = 0;
    return;
  }
  state.curveAxis.y = 0;
  state.shiftAxis.x = 0;

  if (!dx && !dy) {
    state.axis.x = 0;
    state.axis.y = 0;
    return;
  }
  const axis = state.axis;
  if (axis.x !== dx || axis.y !== dy || time - axis.last > STICK_REPEAT) {
    if (state.mode === 'photo') {
      if (dx) step(dx);
      if (dy) zoomBy(dy);
    } else if (dx) {
      moveCursor(dx);
    } else if (dy) {
      moveCursor(dy * COLS);
    }
    axis.x = dx;
    axis.y = dy;
    axis.last = time;
  }
}

function onKey(e) {
  if (e.key === 'Escape' && state.session) {
    state.session.end();
    return;
  }
  if (e.key === 'g' || e.key === 'G') {
    toggleGallery();
    return;
  }
  if (e.key === 'm' || e.key === 'M' || e.key === 'a' || e.key === 'A') {
    markCurrentOrHovered(true);
    return;
  }
  if (e.key === 'Delete') {
    deleteSelected().catch(showError);
    return;
  }
  if (e.shiftKey && state.mode === 'photo') {
    if (e.key === 'ArrowLeft') { panBy(-1, 0); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { panBy(1, 0); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { panBy(0, -1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { panBy(0, 1); e.preventDefault(); return; }
    if (e.key === '[' || e.key === '{') { shiftBy(-1); e.preventDefault(); return; }
    if (e.key === ']' || e.key === '}') { shiftBy(1); e.preventDefault(); return; }
  }
  if (state.mode === 'gallery') {
    if (e.key === 'ArrowLeft') moveCursor(-1);
    if (e.key === 'ArrowRight') moveCursor(1);
    if (e.key === 'ArrowUp') moveCursor(-COLS);
    if (e.key === 'ArrowDown') moveCursor(COLS);
    if (e.key === 'Home') setCursor(0);
    if (e.key === 'End') setCursor(state.gallery.entries.length - 1);
    if (e.key === 'Enter') openGallerySelection().catch(showError);
  } else {
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowUp') zoomBy(-1);
    if (e.key === 'ArrowDown') zoomBy(1);
    if (e.key === '[') setCurve(state.curve - CURVE_STEP);
    if (e.key === ']') setCurve(state.curve + CURVE_STEP);
  }
}

// ---------------------------------------------------------------------------
// VR
// ---------------------------------------------------------------------------

function onFrame(time, frame) {
  const session = frame.session;
  const refSpace = state.refSpace;
  const pose = frame.getViewerPose(refSpace);
  const source = rightInputSource(session);
  handleInput(source && source.gamepad, time);

  const ray = computeRay(frame, refSpace, source);
  const g = state.gallery;
  g.ray = ray;
  g.hover = ray && ray.index >= 0 && ray.index < g.entries.length ? ray.index : -1;
  g.navHover = ray ? ray.nav : '';
  if (g.deleteArmed && time - g.deleteArmedAt > DELETE_TIMEOUT) {
    g.deleteArmed = false;
    if (state.gl) uploadDeleteTexture(state.gl);
  }

  if (!pose) {
    session.requestAnimationFrame(onFrame, refSpace);
    return;
  }

  const gl = state.gl;
  const layer = session.renderState.baseLayer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
  gl.viewport(0, 0, layer.framebufferWidth, layer.framebufferHeight);
  gl.clearColor(0.02, 0.02, 0.04, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);

  for (const view of pose.views) {
    const vp = layer.getViewport(view);
    gl.viewport(vp.x, vp.y, vp.width, vp.height);
    const proj = view.projectionMatrix;
    const viewM = view.transform.inverse.matrix;

    if (state.mode === 'gallery') {
      renderGallery(gl, proj, viewM);
      continue;
    }

    const z = state.distance / state.zoom;
    const right = view.eye === 'right';
    drawCurvedPhoto(gl, proj, viewM, right ? [0.5, 0] : [0, 0], [0.5, 1], photoEyeModel(right));
    drawPhotoMark(gl, proj, viewM);

    const labelModel = multiply(
      photoPanModel(),
      multiply(translate(0, -state.height / 2 - 0.2, -z), scale(1.2, 0.225, 1)),
    );
    draw(gl, state.texLabel, multiply(proj, multiply(viewM, labelModel)), [0, 0], [1, 1]);
  }

  session.requestAnimationFrame(onFrame, refSpace);
}

async function enterVR() {
  if (!navigator.xr) {
    throw new Error(t('errNoWebXR'));
  }
  if (!(await navigator.xr.isSessionSupported('immersive-vr'))) {
    throw new Error(t('errNoImmersive'));
  }

  const session = await navigator.xr.requestSession('immersive-vr');
  state.session = session;
  state.zoom = state.zoomByRoot[state.rootId] ?? 1.0;
  setCurve(state.curveByRoot[state.rootId] ?? 0, false);
  applyViewFromRoot(state.rootId);
  state.gallery.deleteArmed = false;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: false, antialias: true });
  if (!gl) {
    await session.end();
    throw new Error(t('errNoWebGL'));
  }
  await gl.makeXRCompatible();
  state.gl = gl;
  initGL(gl);
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  state.refSpace = await session.requestReferenceSpace('local');

  session.addEventListener('select', () => {
    // Триггер в режиме фото больше не листает — пометки ставит кнопка A.
    if (state.mode !== 'gallery') return;
    const g = state.gallery;
    if (g.navHover === 'exit' && state.session) {
      state.session.end();
      return;
    }
    if (g.navHover === 'delete') {
      armDelete();
      return;
    }
    if (g.navHover === 'first' || g.navHover === 'last') {
      setCursor(g.navHover === 'first' ? 0 : g.entries.length - 1);
      return;
    }
    // Луч попал в пустое место (или не попал ни во что) — открываем то,
    // что выбрано стиком. Луч поверх плашки открывает плашку под лучом.
    const target = g.hover >= 0 ? g.hover : g.cursor;
    openGallerySelection(target).catch(showError);
  });
  session.addEventListener('squeeze', () => {
    if (state.mode === 'gallery') toggleGallery();
    // В режиме фото grip — только модификатор изгиба в сочетании со стиком.
  });
  session.addEventListener('end', () => {
    state.session = null;
    state.gl = null;
    state.refSpace = null;
    state.mode = 'photo';
    state.gallery.ray = null;
    state.gallery.hover = -1;
    state.gallery.navHover = '';
    state.gallery.deleteArmed = false;
    state.buttons = { stick: false, b: false, a: false, grip: false, trigger: false };
    state.curveAxis.y = 0;
    state.panAxis = { x: 0, y: 0, last: 0 };
    state.shiftAxis = { x: 0, last: 0 };
    updateSelectionUI();
    $('#vrBtn').disabled = state.current < 0;
  });

  if (state.current < 0) {
    await session.end();
    throw new Error(t('errNoImage'));
  }
  await loadPhoto(state.entries[state.current]);
  session.requestAnimationFrame(onFrame, state.refSpace);
}

init().catch(showError);
