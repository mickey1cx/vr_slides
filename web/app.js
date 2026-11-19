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
const EXIT_Y = -0.92;
const BAR_X = 1.42;
const BAR_TOP = 0.72;
const BAR_HEIGHT = 1.44;
const BAR_WIDTH = 0.035;
const STICK_DEAD = 0.6;
const STICK_REPEAT = 320; // мс между повторами при удержании

const state = {
  config: null,
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
  texPhoto: null,
  texLabel: null,
  texWhite: null,
  texHeader: null,
  texExit: null,
  texCards: [],
  blankCard: null,
  labelCanvas: null,
  headerCanvas: null,
  distance: 2.0,
  height: 1.2,
  aspect: 1.0,
  mode: 'photo', // photo | gallery
  zoom: 1.0,
  axis: { x: 0, y: 0, last: 0 },
  buttons: { stick: false, b: false },
  gallery: { rel: '', entries: [], cursor: 0, offset: 0, gen: 0, ray: null, hover: -1, exitHover: false },
};

// ---------------------------------------------------------------------------
// API / UI
// ---------------------------------------------------------------------------

async function api(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
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
  const cfg = await api('/api/config');
  state.config = cfg;
  $('#url').textContent = location.origin;
  $('#questUrl').textContent = `https://${cfg.ip}:${cfg.port}`;

  const sel = $('#rootSelect');
  for (const r of cfg.roots) sel.add(new Option(r.name, r.id));
  sel.addEventListener('change', () => {
    state.rootId = sel.value;
    state.rel = '';
    list().catch(showError);
  });

  $('#upBtn').addEventListener('click', () => {
    const parts = state.rel.split('/').filter(Boolean);
    parts.pop();
    state.rel = parts.join('/');
    list().catch(showError);
  });

  $('#vrBtn').addEventListener('click', () => enterVR().catch(showError));
  window.addEventListener('keydown', (e) => onKey(e));

  if (cfg.roots.length) {
    state.rootId = cfg.roots[0].id;
    sel.value = state.rootId;
    await list();
  } else {
    showError('В config.json не указа ни одного каталога.');
  }
}

async function list() {
  const data = await api(`/api/list?root=${enc(state.rootId)}&path=${enc(state.rel)}`);
  applyListing(data);
}

function applyListing(data) {
  state.entries = data.entries;
  state.images = data.entries.filter((e) => e.type === 'image');
  state.current = -1;
  $('#vrBtn').disabled = true;
  $('#error').hidden = true;

  const parts = state.rel.split('/').filter(Boolean);
  $('#crumb').textContent = [rootCfg().name, ...parts].join(' / ');
  renderGrid();
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  for (const entry of state.entries) {
    const card = document.createElement('button');
    card.className = 'card';
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
      const label = document.createElement('span');
      label.textContent = entry.name;
      card.append(thumb, label);
      card.addEventListener('click', () => openImage(entry).catch(showError));
    }
    grid.append(card);
  }
}

function updateInfo(entry) {
  const rc = rootCfg();
  $('#info').textContent =
    `${entry.name}\n${entry.width || '?'}×${entry.height || '?'} · SBS ${rc.sbs} · ${state.images.length} фото`;
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
    attribute vec2 aPos;
    attribute vec2 aUv;
    uniform mat4 uMVP;
    uniform vec2 uUvOffset;
    uniform vec2 uUvScale;
    varying vec2 vUv;
    void main() {
      vUv = uUvOffset + aUv * uUvScale;
      gl_Position = uMVP * vec4(aPos, 0.0, 1.0);
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
    -0.5, -0.5, 0, 0,
     0.5, -0.5, 1, 0,
    -0.5,  0.5, 0, 1,
     0.5,  0.5, 1, 1,
  ]);
  state.vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(state.loc.aPos);
  gl.vertexAttribPointer(state.loc.aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(state.loc.aUv);
  gl.vertexAttribPointer(state.loc.aUv, 2, gl.FLOAT, false, 16, 8);

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

  const exitCanvas = document.createElement('canvas');
  exitCanvas.width = 512;
  exitCanvas.height = 96;
  const ectx = exitCanvas.getContext('2d');
  ectx.fillStyle = '#4a1d24';
  ectx.fillRect(0, 0, 512, 96);
  ectx.fillStyle = '#ffd7dc';
  ectx.font = 'bold 40px sans-serif';
  ectx.textAlign = 'center';
  ectx.textBaseline = 'middle';
  ectx.fillText('Выйти из VR', 256, 48);
  state.texExit = makeTexture(gl);
  uploadImage(gl, state.texExit, exitCanvas);

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

function draw(gl, tex, mvp, uvOffset, uvScale, tint = [1, 1, 1]) {
  gl.useProgram(state.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniformMatrix4fv(state.loc.uMVP, false, mvp);
  gl.uniform2fv(state.loc.uUvOffset, uvOffset);
  gl.uniform2fv(state.loc.uUvScale, uvScale);
  gl.uniform3fv(state.loc.uTint, tint);
  gl.uniform1i(state.loc.uTex, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function updateLabel(entry) {
  const canvas = state.labelCanvas;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.font = '28px sans-serif';
  ctx.textBaseline = 'middle';
  const index = state.images.indexOf(entry) + 1;
  ctx.fillText(`${index}/${state.images.length}  ${entry.name}`.slice(0, 60), 16, 58);
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '22px sans-serif';
  ctx.fillText(
    `стик ← → листать · ↑ ↓ зум ${state.zoom.toFixed(1)}× · нажать стик/B — галерея`,
    16, 142,
  );
  uploadImage(state.gl, state.texLabel, canvas);
}

function zoomBy(direction) {
  const factor = direction < 0 ? 1.12 : 1 / 1.12; // вверх — приблизить
  state.zoom = Math.min(2.5, Math.max(0.6, state.zoom * factor));
  const entry = state.entries[state.current];
  if (entry && state.gl) updateLabel(entry);
}

// ---------------------------------------------------------------------------
// 3D-галерея
// ---------------------------------------------------------------------------

function buildGalleryEntries(entries, rel) {
  const hasParent = rel.split('/').filter(Boolean).length > 0;
  const up = hasParent ? [{ type: 'up', name: '↑ Назад', path: '' }] : [];
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
    state.gallery.exitHover = false;
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
  g.exitHover = false;
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
  ctx.fillText(`Галерея · ${where}`.slice(0, 44), 16, 44);
  ctx.fillStyle = '#9aa3b5';
  ctx.font = '26px sans-serif';
  ctx.fillText(
    `${g.entries.length ? g.cursor + 1 : 0}/${g.entries.length} · стик: выбор · триггер: открыть · B/стик: фото`,
    16, 96,
  );
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
    await list();
    const target = state.entries.find((e) => e.path === entry.path && e.type === 'image');
    state.mode = 'photo';
    if (target) await openImage(target);
    return;
  }
  const data = await api(`/api/list?root=${enc(state.rootId)}&path=${enc(g.rel)}`);
  g.entries = buildGalleryEntries(data.entries, g.rel);
  g.cursor = 0;
  g.offset = 0;
  g.ray = null;
  g.hover = -1;
  g.exitHover = false;
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
      const hm = multiply(
        translate(x, y, GALLERY_Z - 0.02),
        scale(CARD_W + 0.055, CARD_H + 0.055, 1),
      );
      draw(
        gl, state.texWhite, multiply(proj, multiply(viewM, hm)), [0, 0], [1, 1],
        hovered ? [0.5, 0.9, 1.0] : [0.2, 0.55, 1.0],
      );
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

  const exitModel = multiply(translate(0, EXIT_Y, GALLERY_Z), scale(0.9, 0.17, 1));
  draw(
    gl, state.texExit, multiply(proj, multiply(viewM, exitModel)), [0, 0], [1, 1],
    g.exitHover ? [1.4, 1.1, 1.1] : [1, 1, 1],
  );

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
  const ray = { origin, dir, point: null, index: -1, exit: false };

  if (Math.abs(dir.z) > 1e-4) {
    const t = (GALLERY_Z - origin.z) / dir.z;
    if (t > 0) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      ray.point = { x, y, z: GALLERY_Z };

      if (Math.abs(x) <= 0.45 && Math.abs(y - EXIT_Y) <= 0.085) {
        ray.exit = true;
      } else {
        const g = state.gallery;
        for (let slot = 0; slot < SLOTS; slot++) {
          const col = slot % COLS;
          const row = Math.floor(slot / COLS);
          const cx = (col - (COLS - 1) / 2) * GAP_X;
          const cy = ((ROWS - 1) / 2 - row) * GAP_Y;
          if (Math.abs(x - cx) <= CARD_W / 2 && Math.abs(y - cy) <= CARD_H / 2) {
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

  if (pad) {
    const axes = pad.axes || [];
    const rx = axes.length >= 3 ? axes[2] : (axes[0] || 0);
    const ry = axes.length >= 4 ? axes[3] : (axes[1] || 0);
    if (Math.abs(rx) > STICK_DEAD) dx = Math.sign(rx);
    if (Math.abs(ry) > STICK_DEAD) dy = Math.sign(ry);
    const buttons = pad.buttons || [];
    stickPressed = !!(buttons[3] && buttons[3].pressed);
    bPressed = !!(buttons[5] && buttons[5].pressed);
  }

  const toggle = (stickPressed && !state.buttons.stick) || (bPressed && !state.buttons.b);
  state.buttons.stick = stickPressed;
  state.buttons.b = bPressed;
  if (toggle) {
    toggleGallery();
    return;
  }

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
  if (state.mode === 'gallery') {
    if (e.key === 'ArrowLeft') moveCursor(-1);
    if (e.key === 'ArrowRight') moveCursor(1);
    if (e.key === 'ArrowUp') moveCursor(-COLS);
    if (e.key === 'ArrowDown') moveCursor(COLS);
    if (e.key === 'Enter') openGallerySelection().catch(showError);
  } else {
    if (e.key === 'ArrowRight') step(1);
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowUp') zoomBy(-1);
    if (e.key === 'ArrowDown') zoomBy(1);
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
  g.exitHover = !!(ray && ray.exit);

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

    const w = state.height * state.aspect;
    const z = state.distance / state.zoom;
    const model = multiply(
      translate(0, 0, -z),
      scale(w, state.height, 1),
    );
    const mvp = multiply(proj, multiply(viewM, model));
    const right = view.eye === 'right';
    draw(gl, state.texPhoto, mvp, right ? [0.5, 0] : [0, 0], [0.5, 1]);

    const labelModel = multiply(
      translate(0, -state.height / 2 - 0.2, -z),
      scale(1.2, 0.225, 1),
    );
    draw(gl, state.texLabel, multiply(proj, multiply(viewM, labelModel)), [0, 0], [1, 1]);
  }

  session.requestAnimationFrame(onFrame, refSpace);
}

async function enterVR() {
  if (!navigator.xr) {
    throw new Error('WebXR недоступен. Откройте страницу в Quest Browser по HTTPS.');
  }
  if (!(await navigator.xr.isSessionSupported('immersive-vr'))) {
    throw new Error('Этот браузер не поддерживает immersive-vr.');
  }

  const session = await navigator.xr.requestSession('immersive-vr');
  state.session = session;
  state.zoom = 1.0;

  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: false, antialias: true });
  if (!gl) {
    await session.end();
    throw new Error('WebGL недоступен.');
  }
  await gl.makeXRCompatible();
  state.gl = gl;
  initGL(gl);
  session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
  state.refSpace = await session.requestReferenceSpace('local');

  session.addEventListener('select', () => {
    if (state.mode !== 'gallery') {
      step(1);
      return;
    }
    if (state.gallery.exitHover && state.session) {
      state.session.end();
      return;
    }
    const target = state.gallery.hover >= 0 ? state.gallery.hover : state.gallery.cursor;
    openGallerySelection(target).catch(showError);
  });
  session.addEventListener('squeeze', () => {
    if (state.mode === 'gallery') toggleGallery();
    else step(-1);
  });
  session.addEventListener('end', () => {
    state.session = null;
    state.gl = null;
    state.refSpace = null;
    state.mode = 'photo';
    state.gallery.ray = null;
    state.gallery.hover = -1;
    state.gallery.exitHover = false;
    $('#vrBtn').disabled = state.current < 0;
  });

  if (state.current < 0) {
    await session.end();
    throw new Error('Сначала выберите изображение.');
  }
  await loadPhoto(state.entries[state.current]);
  session.requestAnimationFrame(onFrame, state.refSpace);
}

init().catch(showError);
