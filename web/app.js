const $ = (sel) => document.querySelector(sel);
const enc = encodeURIComponent;

// Клиентские ошибки буферизуются сразу, даже до загрузки конфигурации: если
// сервер запущен с --log, они попадут в общий файл logs/server_<время>.log.
const CLIENT_LOGS = [];
let CLIENT_LOG_ENABLED = false;

function logClient(level, message, err) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: String(message),
    stack: err && err.stack ? String(err.stack) : '',
    source: 'web',
  };
  CLIENT_LOGS.push(entry);
  if (CLIENT_LOGS.length > 200) CLIENT_LOGS.shift();
  if (CLIENT_LOG_ENABLED) {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => { /* логирование не должно ломать интерфейс */ });
  }
}

function flushClientLogs() {
  if (!CLIENT_LOG_ENABLED || !CLIENT_LOGS.length) return;
  const pending = CLIENT_LOGS.splice(0);
  for (const entry of pending) {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    }).catch(() => {});
  }
}

window.addEventListener('error', (event) => {
  logClient('ERROR', `${event.message} @ ${event.filename || '?'}:${event.lineno || 0}`, event.error);
});
window.addEventListener('unhandledrejection', (event) => {
  logClient('ERROR', 'Unhandled rejection', event.reason);
});

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
const PANO_RADIUS = 4; // радиус сферы: наблюдатель в центре
const PANO_LON = 48; // сегменты по долготе
const PANO_LAT = 24; // сегменты по широте
// В режиме «плоская стена» вся высота стены занимает вертикальный угол глаза.
// Источник — эквайреугольная 360-панорама: ее верх/низ содержат полюса сферы.
// Для стены берем только центральную полосу кадра, иначе полюса снова дают
// ощущение сферы. Над/под стеной остается пустота — это ожидаемо.
const PANO_CYL_VFILL = 1.0;
const PANO_CYL_VCROP = 0.5;
const IDENTITY_MATRIX = new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);
const CURVE_STEP = 0.08; // шаг изменения изгиба за один повтор стика
// Значения по умолчанию; сервер может переопределить их блоком "controls" в config.json.
const DEFAULT_CONTROLS = {
  panInvertX: true,   // стик вправо → кадр вправо (было: кадр влево)
  panInvertY: true,   // стик вверх → кадр вверх (было: кадр вниз)
  shiftInvert: false,
  panStep: 0.08,
  shiftStep: 0.005,
  panBase: 0.35,      // смещение при 1×, чтобы слайдер всегда давал эффект
  panGain: 1.0,       // дополнительное смещение при зуме
};
// Поддерживаемые раскладки стереопары. auto — определить формат по файлу.
const LAYOUT_TYPES = ['mono', 'sbs', 'half', 'ou', 'hou', 'pano', 'auto'];
const LAYOUT_ALIASES = {
  '2d': 'mono', flat: 'mono',
  '360': 'pano', panorama: 'pano', equirect: 'pano', equirectangular: 'pano', sphere: 'pano',
  full: 'sbs', lr: 'sbs', rl: 'sbs', stereo: 'sbs', '3d': 'sbs',
  'side-by-side': 'sbs', sidebyside: 'sbs', 'full-sbs': 'sbs', fullsbs: 'sbs',
  hsbs: 'half', 'half-sbs': 'half', 'sbs-half': 'half', halfsbs: 'half', sbshalf: 'half', 'half-side': 'half',
  tab: 'ou', tb: 'ou', bt: 'ou', 'top-bottom': 'ou', topbottom: 'ou',
  'over-under': 'ou', overunder: 'ou', 'full-ou': 'ou', fullou: 'ou', fou: 'ou',
  hou: 'hou', 'half-ou': 'hou', halfou: 'hou', 'half-tab': 'hou', halftab: 'hou',
};
const LAYOUT_LABEL_KEYS = {
  mono: 'layoutMono', sbs: 'layoutSbs', half: 'layoutHalf',
  ou: 'layoutOu', hou: 'layoutHou', pano: 'layoutPano', auto: 'layoutAuto',
};

function normaliseLayout(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return null;
  if (LAYOUT_TYPES.includes(key)) return key;
  return LAYOUT_ALIASES[key] || null;
}

function layoutEyeAspect(type, imgAspect) {
  if (type === 'sbs') return imgAspect / 2;
  if (type === 'ou') return imgAspect * 2;
  return imgAspect;
}

// UV-прямоугольник глаза. UNPACK_FLIP_Y_WEBGL включен, поэтому v=1 — верх картинки.
function layoutUv(type, right, swap) {
  const other = swap ? !right : right;
  if (type === 'ou' || type === 'hou') {
    return { offset: [0, other ? 0 : 0.5], scale: [1, 0.5] };
  }
  if (type === 'sbs' || type === 'half') {
    return { offset: [other ? 0.5 : 0, 0], scale: [0.5, 1] };
  }
  return { offset: [0, 0], scale: [1, 1] };
}

// Рисует один глаз стереопары в прямоугольник эскиза: формат и swap учитываются
// теми же правилами, что и в VR. Лишнее обрезается по центру (аналог object-fit: cover).
function layoutKey(entry) {
  return `${state.rootId}|${state.rel}|${entry.path}`;
}

function drawEyeThumb(ctx, img, entry, dx, dy, dw, dh, known = null) {
  const layout = known || state.confirmedLayout[layoutKey(entry)] || effectiveLayout(entry, img);
  const uv = layoutUv(layout.type, false, layout.swap);
  const sx = img.width * uv.offset[0];
  const sy = img.height * (1 - uv.offset[1] - uv.scale[1]);
  const sw = img.width * uv.scale[0];
  const sh = img.height * uv.scale[1];
  const scale = Math.max(dw / sw, dh / sh);
  const outW = sw * scale;
  const outH = sh * scale;
  ctx.drawImage(img, sx, sy, sw, sh,
    dx + (dw - outW) / 2, dy + (dh - outH) / 2, outW, outH);
  return layout;
}

async function drawCardThumb(canvas, entry, known = null) {
  const img = await loadImage(thumbUrl(entry));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222838';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const layout = drawEyeThumb(ctx, img, entry, 0, 0, canvas.width, canvas.height, known);
  canvas.dataset.layout = layout.type;
}

// Луч попадает в плашку только по ее центральной области: промежутки между
// плашками остаются «пустым местом» и не перехватывают выделение стиком.
const HIT_W = CARD_W * 0.44;
const HIT_H = CARD_H * 0.42;

const state = {
  config: null,
  controls: { ...DEFAULT_CONTROLS },
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
  layoutByRoot: {}, // ручные переопределения формата: root -> rel -> {type, swap}
  layoutDefaultByRoot: {}, // формат всего каталога: root -> тип (по умолчанию авто)
  panoModeByRoot: {}, // 360-проекция каталога: root -> sphere | cylinder
  layoutCache: {}, // кэш автоопределения: root|rel|ширина -> результат
  confirmedLayout: {}, // формат, уже определенный по полному изображению
  thumbObserver: null, // ленивая отрисовка эскизов 2D-галереи
  photoLayout: { type: 'sbs', swap: false, detected: null, rootType: 'sbs', override: null },
  photoLayoutEntry: '',
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
  sphereVbo: null,
  sphereVertexCount: 0,
  panoQuadVbo: null, // fullscreen quad для лучевой цилиндрической проекции
  projParams: [1, 1, 0, 0], // 1/P[0], 1/P[5], P[8], P[9] текущего глаза
  camRot: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), // поворот камеры без смещения
  cylScale: 1 / (2 * Math.PI), // R/H: сколько текстуры приходится на тангенс высоты
  cylVcrop: PANO_CYL_VCROP, // доля высоты источника, натянутая на стену
  lastPanoDebug: 0,
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
  viewport: [0, 0, 1, 1], // текущий глаз: x, y, w, h для восстановления луча из gl_FragCoord
  hudVisible: true,      // панель подсказок в VR; переключается коротким grip
  gripModified: false,   // grip + стик менял вид: короткий grip не должен прятать панель
  gripConsumed: false,   // grip использован для выхода из галереи: не считаем его коротким
  gallery: {
    rel: '', entries: [], cursor: 0, offset: 0, gen: 0,
    ray: null, hover: -1, navHover: '',
    deleteArmed: false, deleteArmedAt: 0,
  },
};

// Частично созданные ресурсы нельзя оставлять в state: после неудачного входа
// в VR из 2D-панели они приводят к ошибкам наподобие null.getContext.
function clearGLState() {
  state.gl = null;
  state.program = null;
  state.panoQuadVbo = null;
  state.labelCanvas = null;
  state.headerCanvas = null;
  state.refSpace = null;
}

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
  const message = typeof err === 'string' ? err : err.message || String(err);
  logClient('ERROR', message, err);
  const box = $('#error');
  box.textContent = message;
  box.hidden = false;
}

// Кнопка B правого контроллера в 2D-режиме Quest Browser работает как назад.
// Держим один маркер в истории: когда B вызывает popstate и мы не в корне
// коллекции, отменяем уход со страницы и поднимаемся на каталог выше.
const HISTORY_MARKER = 'vrslidesDir';

function dirParts(rel) {
  return String(rel || '').split('/').filter(Boolean);
}

function hasParentDir(rel) {
  return dirParts(rel).length > 0;
}

function parentDirRel(rel) {
  const parts = dirParts(rel);
  parts.pop();
  return parts.join('/');
}

function activeDirRel() {
  return state.mode === 'gallery' ? state.gallery.rel : state.rel;
}

function historyMarker(rel = activeDirRel()) {
  return { [HISTORY_MARKER]: true, root: state.rootId, rel };
}

function syncHistoryMarker() {
  try {
    history.replaceState(historyMarker(), '');
  } catch { /* история может быть недоступна */ }
}

// Дополнительный маркер нужен, чтобы Back оставался внутри документа: иначе
// браузер уйдет на предыдущую страницу до вызова popstate. Quest Browser может
// проигнорировать pushState без жеста пользователя, поэтому повторяем его
// на первом же клике/клавише.
function initHistoryMarker() {
  try {
    history.pushState(historyMarker(), '');
  } catch { /* история может быть недоступна */ }
}

let historyArmed = false;
function armHistory() {
  if (historyArmed) return;
  historyArmed = true;
  initHistoryMarker();
  syncHistoryMarker();
}

function pushHistoryForDir(rel) {
  try {
    history.pushState(historyMarker(rel), '');
  } catch { /* история может быть недоступна */ }
}

const FORWARD_ECHO_MS = 5000;
let historyForwarding = false;
let historyForwardUntil = 0;

// WebXR приостанавливает JS вкладки: эхо от history.forward() может прийти
// только после выхода из VR. Продлеваем окно ожидания на границах сессии —
// иначе запоздалое эхо считается новым нажатием B и съедает следующее.
function extendForwardEcho(where) {
  if (!historyForwarding) return;
  historyForwardUntil = Date.now() + FORWARD_ECHO_MS;
  logClient('INFO', `history: extend forward (${where})`);
}

function onPopState(event) {
  if (historyForwarding && Date.now() < historyForwardUntil) {
    historyForwarding = false;
    historyForwardUntil = 0;
    syncHistoryMarker();
    logClient('INFO', 'B/back: forward echo');
    return;
  }
  historyForwarding = false; // просроченный флаг от приостановленной вкладки
  const rel = activeDirRel();
  logClient('INFO', `B/back: pop rel=${rel || '/'}`);
  // Возвращаемся на свою запись: так Back не выведет со страницы. Делаем это
  // forward, а не pushState — внутри popstate Quest Browser его игнорирует.
  historyForwarding = true;
  historyForwardUntil = Date.now() + FORWARD_ECHO_MS;
  try { history.forward(); } catch { /* история может быть недоступна */ }
  if (!hasParentDir(rel)) {
    logClient('INFO', 'B/back: root, stay');
    return;
  }
  const parent = parentDirRel(rel);
  logClient('INFO', `B/back: ${rel || '/'} -> ${parent || '/'}`);
  goUpActiveDir().catch(showError);
}

function goUpActiveDir() {
  if (state.mode === 'gallery') return openGallerySelection(0);
  if (!hasParentDir(state.rel)) return Promise.resolve();
  state.rel = parentDirRel(state.rel);
  return list();
}

function refreshDebugLog() {
  const pre = $('#debugLog');
  const meta = $('#debugMeta');
  if (!pre) return Promise.resolve();
  return api('/api/log?tail=300').then((data) => {
    if (data.enabled) {
      pre.textContent = (data.lines || []).join('\n') || t('debugEmpty');
      meta.textContent = data.file || '';
    } else {
      const local = CLIENT_LOGS.map((e) =>
        `[${e.ts}] [JS-${e.level}] ${e.message}${e.stack ? `\n${e.stack}` : ''}`);
      pre.textContent = local.join('\n') || t('debugEmpty');
      meta.textContent = t('debugDisabled');
    }
    pre.scrollTop = pre.scrollHeight;
  }).catch((err) => {
    pre.textContent = t('debugError', { error: err.message });
  });
}

function rootCfg() {
  return state.config.roots.find((r) => r.id === state.rootId) || {};
}

// Формат каталога: сохраненная настройка интерфейса перекрывает config.json.
function directoryLayoutType() {
  const saved = normaliseLayout(state.layoutDefaultByRoot[state.rootId]);
  if (saved && saved !== 'auto') return saved;
  return normaliseLayout(rootCfg().sbs) || 'auto';
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

// ---------------------------------------------------------------------------
// Определение формата стереопары
// ---------------------------------------------------------------------------

function nameLayout(name) {
  const n = String(name || '').toLowerCase().replace(/[_.\s]+/g, '-').replace(/[^a-z0-9-]/g, '-');
  const rules = [
    [/(^|-)(pano|panorama|equirect|equirectangular|360)(-|$)/, 'pano'],
    [/(^|-)half-?ou(-|$)|(^|-)hou(-|$)|(^|-)half-?tab(-|$)|(^|-)htab(-|$)/, 'hou'],
    [/(^|-)full-?ou(-|$)|(^|-)fou(-|$)|(^|-)top-?bottom(-|$)|(^|-)tab(-|$)|(^|-)tb(-|$)|(^|-)ou(-|$)/, 'ou'],
    [/(^|-)half-?sbs(-|$)|(^|-)sbs-?half(-|$)|(^|-)hsbs(-|$)|(^|-)half-?side(-|$)/, 'half'],
    [/(^|-)sbs(-|$)|(^|-)lr(-|$)|(^|-)stereo(-|$)|(^|-)3d(-|$)|side-?by-?side/, 'sbs'],
    [/(^|-)mono(-|$)|(^|-)2d(-|$)|(^|-)flat(-|$)/, 'mono'],
  ];
  for (const [pattern, type] of rules) {
    if (pattern.test(n)) return type;
  }
  return null;
}

function nameSwap(name) {
  const n = String(name || '').toLowerCase().replace(/[_.\s]+/g, '-').replace(/[^a-z0-9-]/g, '-');
  if (/(^|-)(rl|bt)(-|$)/.test(n)) return true;
  if (/(^|-)(lr|tb)(-|$)/.test(n)) return false;
  return null;
}

function luminance(data, x, y, width) {
  const i = (y * width + x) * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

function pearson(a, b) {
  const n = a.length;
  if (n < 4) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da < 1e-6 || db < 1e-6) return 0;
  return num / Math.sqrt(da * db);
}

// Сходство половин картинки: по ширине (SBS) или по высоте (OU).
// Сравниваем не яркость, а горизонтальные границы: у обычного фото с
// повторяющейся текстурой яркость совпадает случайно, а у стереопары совпадают
// именно контуры. Диспаратность компенсируется перебором небольшого сдвига.
function halfCorrelation(img, vertical) {
  const w = 96;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return 0;
  }
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) lum[y * w + x] = luminance(data, x, y, w);
  }
  const edge = (x, y) => Math.abs(
    lum[y * w + Math.min(x + 1, w - 1)] - lum[y * w + Math.max(x - 1, 0)]
  );
  const halfW = vertical ? w : w / 2;
  const halfH = vertical ? h / 2 : h;
  let best = 0;
  for (let dx = -20; dx <= 20; dx++) {
    const a = [];
    const b = [];
    const x0 = Math.max(0, -dx);
    const x1 = Math.min(halfW, halfW - dx);
    for (let y = 0; y < halfH; y += 2) {
      const y2 = vertical ? y + halfH : y;
      for (let x = x0; x < x1; x += 2) {
        const x2 = vertical ? x + dx : halfW + x + dx;
        a.push(edge(x, y));
        b.push(edge(x2, y2));
      }
    }
    // Штраф за сдвиг: настоящая диспаратность обычно невелика, а случайное
    // совпадение текстур на большом сдвиге не должно давать ложный SBS.
    best = Math.max(best, pearson(a, b) - Math.abs(dx) * 0.01);
  }
  return best;
}

// Панорама 360 безшовна: левый и правый края должны стыковаться. Сравниваем
// перепад на шве со средним горизонтальным градиентом — у обычного фото шов
// в несколько раз резче, у SBS по шву еще и проходит граница половин.
function panoSeamRatio(img) {
  const w = 96;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return Infinity;
  ctx.drawImage(img, 0, 0, w, h);
  let data;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return Infinity;
  }
  const lum = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) lum[y * w + x] = luminance(data, x, y, w);
  }
  let seam = 0;
  let grad = 0;
  for (let y = 0; y < h; y++) {
    seam += Math.abs(lum[y * w] - lum[y * w + w - 1]);
    for (let x = 1; x < w; x++) grad += Math.abs(lum[y * w + x] - lum[y * w + x - 1]);
  }
  return (seam * (w - 1)) / (grad + 1e-6);
}

function corrScore(value) {
  return Math.max(0, Math.min(1, (value - 0.25) / 0.35));
}

function detectLayout(img, name, filePano = false) {
  const aspect = img.width / img.height;
  const hint = nameLayout(name);
  const swap = nameSwap(name);
  // Стандартные метаданные GPano и имя файла — сильные подсказки. Узлы ComfyUI
  // не учитываем: это лишь способ генерации, а не признак формата.
  if (filePano || hint === 'pano') {
    return {
      type: 'pano', swap: false, confidence: 100,
      source: filePano ? 'metadata' : 'name', sbsCorr: 0, ouCorr: 0,
    };
  }
  const sbsCorr = halfCorrelation(img, false);
  const ouCorr = halfCorrelation(img, true);
  const wide = aspect >= 2.4;
  const tall = aspect <= 1.05; // Full-OU обычно ~8:9; 1.2 — уже не OU-признак
  const normal = !wide && !tall;
  // Портретный full-SBS (например 1920×1280 = 1.5) неотличим от half-SBS по
  // пикселям, но занимает отдельный диапазон: 1.35..1.6. Полу-half с
  // портретными глазами обычно дает 1.0..1.2, а 16:9 — 1.6..2.4.
  const portraitSbs = aspect >= 1.35 && aspect <= 1.6;
  const cs = corrScore(sbsCorr);
  const co = corrScore(ouCorr);
  // Метаданных может не быть: 2:1 + безшовные края + отсутствие сходства
  // половин надежно отделяет equirectangular от full-SBS и обычного фото.
  if (!hint && Math.abs(aspect - 2) <= 0.2 && cs < 0.2 && panoSeamRatio(img) < 1.8) {
    return { type: 'pano', swap: false, confidence: 85, source: 'content', sbsCorr, ouCorr };
  }
  const sbsAspect = wide || portraitSbs ? 0.35 : (aspect > 1.6 ? 0.2 : 0);
  const halfAspect = normal && !portraitSbs ? 0.35 : 0;
  const ouAspect = tall ? 0.35 : 0;
  const candidates = [
    { type: 'sbs', score: (hint === 'sbs' ? 0.45 : 0) + sbsAspect + cs * 0.5 },
    { type: 'half', score: (hint === 'half' ? 0.45 : 0) + halfAspect + cs * 0.5 },
    { type: 'ou', score: (hint === 'ou' ? 0.45 : 0) + ouAspect + co * 0.5 },
    { type: 'hou', score: (hint === 'hou' ? 0.45 : 0) + (normal ? 0.35 : 0) + co * 0.5 },
    { type: 'mono', score: (hint === 'mono' ? 0.45 : 0) + (normal ? 0.35 : 0) + (1 - Math.max(cs, co)) * 0.5 },
  ].sort((a, b) => b.score - a.score);
  let best = candidates[0];
  if (hint && hint !== best.type) {
    const byName = candidates.find((item) => item.type === hint);
    if (byName && byName.score >= best.score - 0.2) best = byName;
  }
  const source = hint === best.type ? 'name' : (best.score >= 0.55 ? 'pixels' : 'fallback');
  return {
    type: best.type,
    swap,
    confidence: Math.round(Math.min(1, best.score) * 100),
    source,
    sbsCorr,
    ouCorr,
  };
}

function effectiveLayout(entry, img) {
  const rc = rootCfg();
  const rootType = directoryLayoutType();
  const override = state.layoutByRoot[state.rootId]?.[entry?.path] || null;
  let type = override?.type || rootType;
  let swap = typeof override?.swap === 'boolean' ? override.swap : !!rc.swap;
  let detected = null;
  if (type === 'auto') {
    // Миниатюра и полное изображение могут дать разные результаты — держим их отдельно.
    const key = `${state.rootId}|${entry.path}|${img.width}`;
    detected = state.layoutCache[key] || detectLayout(img, entry.name, !!entry?.pano);
    state.layoutCache[key] = detected;
    type = detected.type;
    if (detected.swap !== null && typeof override?.swap !== 'boolean') swap = detected.swap;
  }
  return { type, swap, detected, rootType, override };
}

async function init() {
  const [cfg, saved, langs] = await Promise.all([
    api('/api/config'),
    api('/api/state'),
    api('/api/i18n/list'),
  ]);
  state.config = cfg;
  CLIENT_LOG_ENABLED = !!cfg.log;
  flushClientLogs();
  logClient('INFO', `browser: ${navigator.userAgent || 'empty'}`);
  state.controls = { ...DEFAULT_CONTROLS, ...(cfg.controls || {}) };
  state.langs = langs;
  const qrLink = $('#qrLink');
  if (qrLink) qrLink.hidden = !cfg.qr;
  state.zoomByRoot = saved.zoom || {};
  state.curveByRoot = saved.curve || {};
  state.viewByRoot = saved.view || {};
  state.layoutByRoot = saved.layout || {};
  state.layoutDefaultByRoot = saved.layoutDefault || {};
  state.panoModeByRoot = saved.panoMode || {};

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

  $('#debugBtn').addEventListener('click', () => {
    $('#debugPanel').hidden = false;
    refreshDebugLog().catch(showError);
  });
  $('#debugClose').addEventListener('click', () => { $('#debugPanel').hidden = true; });
  $('#debugRefresh').addEventListener('click', () => refreshDebugLog().catch(showError));
  $('#debugClear').addEventListener('click', () => {
    CLIENT_LOGS.length = 0;
    apiPost('/api/log', { clear: true })
      .catch(() => {})
      .then(() => refreshDebugLog().catch(showError));
  });

  $('#layoutDirSelect').addEventListener('change', () => saveLayoutDefault().catch(showError));
  $('#layoutSelect').addEventListener('change', () => saveLayoutOverride().catch(showError));
  $('#panoModeSelect').addEventListener('change', () => savePanoMode().catch(showError));
  $('#layoutSwap').addEventListener('change', () => saveLayoutOverride().catch(showError));

  $('#upBtn').addEventListener('click', () => goUpActiveDir().catch(showError));

  $('#firstBtn').addEventListener('click', () => jumpToEdge(-1));
  $('#lastBtn').addEventListener('click', () => jumpToEdge(1));
  $('#deleteBtn').addEventListener('click', () => deleteSelected().catch(showError));
  $('#markBtn')?.addEventListener('click', () => markCurrentOrHovered());

  $('#vrBtn').addEventListener('click', () => enterVR().catch(showError));
  window.addEventListener('keydown', (e) => onKey(e));
  window.addEventListener('pointerdown', armHistory, { capture: true });
  window.addEventListener('keydown', armHistory, { capture: true });
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pageshow', () => extendForwardEcho('pageshow'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) extendForwardEcho('visible');
  });

  if (cfg.roots.length) {
    const hasRoot = (id) => cfg.roots.some((r) => r.id === id);
    state.rootId = hasRoot(saved.root) ? saved.root : cfg.roots[0].id;
    sel.value = state.rootId;
    state.zoom = state.zoomByRoot[state.rootId] ?? 1.0;
    setCurve(state.curveByRoot[state.rootId] ?? 0, false);
    applyViewFromRoot(state.rootId);
    initHistoryMarker();
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
  updateLayoutUI(null, null);
  syncHistoryMarker();
}

function renderGrid() {
  const grid = $('#grid');
  grid.replaceChildren();
  state.thumbObserver?.disconnect();
  state.thumbObserver = null;
  const observer = ('IntersectionObserver' in window)
    ? new IntersectionObserver((records) => {
        for (const rec of records) {
          if (!rec.isIntersecting) continue;
          observer.unobserve(rec.target);
          drawCardThumb(rec.target, rec.target._entry).catch(() => {});
        }
      }, { root: grid, rootMargin: '400px' })
    : null;
  state.thumbObserver = observer;
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
        pushHistoryForDir(entry.path);
        state.rel = entry.path;
        list().catch(showError);
      });
    } else {
      const thumb = document.createElement('canvas');
      thumb.className = 'thumb';
      thumb.width = 640;
      thumb.height = 320;
      thumb._entry = entry; // для ленивой отрисовки по появлению в сетке
      if (observer) observer.observe(thumb);
      else drawCardThumb(thumb, entry).catch(() => {});
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

// Формат каталога/фото изменился — перерисовать эскизы в обеих галереях.
function refreshThumbs() {
  renderGrid();
  loadGalleryPage();
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
  syncHistoryMarker();
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
// подсвечиваем ее и открываем — так же, как если бы по ней кликнули.
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
  if (!entry) return;
  const layout = state.photoLayoutEntry === entry.path ? state.photoLayout : null;
  const type = layout?.type || directoryLayoutType();
  $('#info').textContent = t('info', {
    name: entry.name,
    width: entry.width || '?',
    height: entry.height || '?',
    layout: t(LAYOUT_LABEL_KEYS[type] || 'layoutSbs'),
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
  $('#vrBtn').disabled = false;
  updateSelectionUI();
  await loadPhoto(entry);
}

async function loadPhoto(entry) {
  const rc = rootCfg();
  const img = await loadImage(imageUrl(entry));
  const imgAspect = img.width / img.height;
  const layout = effectiveLayout(entry, img);
  state.confirmedLayout[layoutKey(entry)] = layout; // уточняем формат по полному изображению
  for (const canvas of document.querySelectorAll('.card canvas.thumb')) {
    if (canvas._entry === entry) drawCardThumb(canvas, entry, layout).catch(() => {});
  }
  state.photoLayout = layout;
  state.photoLayoutEntry = entry?.path || '';
  state.aspect = rc.eyeAspect || layoutEyeAspect(layout.type, imgAspect);
  state.distance = rc.distance || 2.0;
  state.height = rc.height || 1.2;
  updateInfo(entry);
  updateLayoutUI(entry, layout);
  if (state.gl) {
    uploadImage(state.gl, state.texPhoto, img);
    updateLabel(entry);
  }
}

function updateLayoutUI(entry, layout) {
  const dirSelect = $('#layoutDirSelect');
  const select = $('#layoutSelect');
  const swap = $('#layoutSwap');
  const panoSelect = $('#panoModeSelect');
  const info = $('#layoutInfo');
  const active = !!entry && !!layout;
  if (dirSelect) dirSelect.value = state.layoutDefaultByRoot[state.rootId] || 'auto';
  if (panoSelect) {
    panoSelect.value = panoMode();
    panoSelect.disabled = !active || layout.type !== 'pano';
  }
  if (select) {
    select.disabled = !active;
    select.value = active ? (layout.override?.type || 'root') : 'root';
  }
  if (swap) {
    swap.disabled = !active || layout.type === 'mono' || layout.type === 'pano';
    swap.checked = active ? layout.swap : false;
  }
  if (info) {
    if (!active) {
      info.textContent = t('chooseImage');
      return;
    }
    const parts = [t(LAYOUT_LABEL_KEYS[layout.type] || 'layoutSbs')];
    if (layout.detected) {
      const source = t(`layoutSource${layout.detected.source[0].toUpperCase()}${layout.detected.source.slice(1)}`);
      parts.push(t('layoutDetected', { source, confidence: layout.detected.confidence }));
    } else if (layout.override?.type) {
      parts.push(t('layoutPinned'));
    } else {
      parts.push(t('layoutDirPinned'));
    }
    info.textContent = parts.join(' · ');
  }
}

async function saveLayoutDefault() {
  const value = $('#layoutDirSelect')?.value || 'auto';
  state.confirmedLayout = {}; // старые решения по полным изображениям больше не действуют
  if (value === 'auto') delete state.layoutDefaultByRoot[state.rootId];
  else state.layoutDefaultByRoot[state.rootId] = value;
  await saveState({ root: state.rootId, layoutDefault: value === 'auto' ? null : value });
  // Пересчитать aspect и UV текущей картинки с новым форматом каталога.
  const entry = state.entries[state.current];
  if (entry && entry.type === 'image') await loadPhoto(entry);
  refreshThumbs();
}

async function savePanoMode() {
  const value = $('#panoModeSelect')?.value || 'sphere';
  state.panoModeByRoot[state.rootId] = value;
  state.lastPanoDebug = 0;
  logClient('INFO', `pano projection: ${value} (${state.rootId})`);
  await saveState({ root: state.rootId, panoMode: value });
  refreshThumbs();
  const entry = state.entries[state.current];
  if (state.gl && entry) updateLabel(entry);
}

async function saveLayoutOverride() {
  const entry = state.entries[state.current];
  if (!entry || entry.type !== 'image') return;
  const value = $('#layoutSelect')?.value || 'root';
  const swap = !!$('#layoutSwap')?.checked;
  let payload = null;
  if (value !== 'root') {
    payload = { type: value, swap };
  } else if (swap !== !!state.photoLayout?.swap) {
    // Чтобы сохранить только swap, фиксируем текущий (возможно, определенный) тип.
    payload = { type: state.photoLayout?.type || 'sbs', swap };
  }
  delete state.confirmedLayout[layoutKey(entry)];
  const map = state.layoutByRoot[state.rootId] || (state.layoutByRoot[state.rootId] = {});
  if (payload) map[entry.path] = { ...payload };
  else delete map[entry.path];
  await saveState({ root: state.rootId, path: entry.path, layout: payload });
  if (state.photoLayoutEntry === entry.path) {
    // Пересчитать aspect и UV с новым форматом.
    await loadPhoto(entry);
  }
  refreshThumbs();
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

// Сетки для 360 строятся один раз: вершины несут позицию и UV, поэтому
// используются те же атрибуты и тот же шейдер, что и у обычного фото.
function buildPanoMeshes(gl) {
  const spherePoint = (j, i) => {
    const theta = Math.PI / 2 - (j / PANO_LAT) * Math.PI;
    const u = i / PANO_LON;
    const phi = (u - 0.5) * Math.PI * 2;
    return [
      PANO_RADIUS * Math.cos(theta) * Math.sin(phi),
      PANO_RADIUS * Math.sin(theta),
      -PANO_RADIUS * Math.cos(theta) * Math.cos(phi),
      u, 1 - j / PANO_LAT,
    ];
  };
  // TRIANGLE_STRIP должен чередовать вершины двух соседних широт: если вывести
  // всю строку целиком, валидным будет только один треугольник на стыке строк.
  const sphere = [];
  for (let j = 0; j < PANO_LAT; j++) {
    for (let k = 0; k <= PANO_LON; k++) {
      const i = (j % 2 === 0) ? k : (PANO_LON - k);
      sphere.push(...spherePoint(j, i), ...spherePoint(j + 1, i));
    }
  }
  state.sphereVertexCount = sphere.length / 5;
  state.sphereVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.sphereVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(sphere), gl.STATIC_DRAW);
}

function initGL(gl) {
  const vs = `
    attribute vec3 aPos;
    attribute vec2 aUv;
    uniform mat4 uMVP;
    varying vec2 vUv;
    void main() {
      // Сдвиг/масштаб применяются один раз во фрагментном шейдере: цилиндр
      // пересчитывает uv из луча, и если делать это еще здесь, стереопары
      // получают двойное преобразование и неверные области глаза.
      vUv = aUv;
      gl_Position = uMVP * vec4(aPos, 1.0);
    }`;
  const fs = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec3 uTint;
    uniform mediump vec2 uUvOffset;
    uniform mediump vec2 uUvScale;
    uniform float uWrap;
    uniform float uCylMode;
    uniform vec4 uViewport;
    uniform vec4 uProjParams; // 1/P[0], 1/P[5], P[8], P[9]
    uniform mat3 uCamRot;     // поворот камеры в мир без смещения
    uniform float uCylScale;  // R/H: тангенс высоты → текстурная v
    uniform float uCylVcrop;  // доля высоты источника, натянутая на стену
    varying vec2 vUv;
    const float PI = 3.141592653589793;
    void main() {
      vec2 uv = vUv;
      if (uCylMode > 0.5) {
        // Восстанавливаем луч в координатах глаза. gl_FragCoord нужен только
        // для направления; смещение камеры намеренно не участвует.
        vec2 ndc = (gl_FragCoord.xy - uViewport.xy) / uViewport.zw * 2.0 - 1.0;
        vec3 dirView = normalize(vec3(
          (ndc.x + uProjParams.z) * uProjParams.x,
          (ndc.y + uProjParams.w) * uProjParams.y,
          -1.0));
        vec3 dir = normalize(uCamRot * dirView);
        float horiz = max(length(dir.xz), 0.0001);
        // Замкнутая вертикальная стена: долгота из направления, а v из
        // тангенса возвышения. Картинка привязана к миру, не к экрану.
        float lon = atan(dir.x, -dir.z);
        float vWall = 0.5 + (dir.y / horiz) * uCylScale;
        // Стена имеет конечную высоту: над/под ней остается пустота (фон).
        if (vWall < 0.0 || vWall > 1.0) {
          gl_FragColor = vec4(0.02, 0.02, 0.04, 1.0);
          return;
        }
        // Эквайреугольный источник содержит полюса в верхней/нижней строке.
        // Для стены берем центральную полосу: так кадр не выглядит сферой.
        float vSrc = 0.5 + (vWall - 0.5) * uCylVcrop;
        uv = vec2(0.5 + lon / (2.0 * PI), vSrc);
      }
      uv = uUvOffset + uv * uUvScale;
      if (uWrap > 0.5) uv.x = fract(uv.x);
      uv.y = clamp(uv.y, 0.0, 1.0);
      gl_FragColor = vec4(texture2D(uTex, uv).rgb * uTint, 1.0);
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
    uWrap: gl.getUniformLocation(program, 'uWrap'),
    uCylMode: gl.getUniformLocation(program, 'uCylMode'),
    uViewport: gl.getUniformLocation(program, 'uViewport'),
    uProjParams: gl.getUniformLocation(program, 'uProjParams'),
    uCamRot: gl.getUniformLocation(program, 'uCamRot'),
    uCylScale: gl.getUniformLocation(program, 'uCylScale'),
    uCylVcrop: gl.getUniformLocation(program, 'uCylVcrop'),
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
  buildPanoMeshes(gl);

  // Полноэкранный quad в clip space. Для цилиндра фрагментный шейдер сам
  // восстанавливает направление луча, поэтому геометрия сферы не нужна.
  const panoQuad = new Float32Array([
    -1, -1, 0, 0, 0,
     1, -1, 0, 1, 0,
    -1,  1, 0, 0, 1,
     1,  1, 0, 1, 1,
  ]);
  state.panoQuadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, state.panoQuadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, panoQuad, gl.STATIC_DRAW);

  state.texPhoto = makeTexture(gl);
  state.texLabel = makeTexture(gl);
  state.texHeader = makeTexture(gl);

  state.labelCanvas = document.createElement('canvas');
  state.labelCanvas.width = 1024;
  state.labelCanvas.height = 256;
  const lctx = state.labelCanvas.getContext('2d');
  lctx.fillStyle = '#10131a';
  lctx.fillRect(0, 0, 1024, 256);
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

function draw(gl, tex, mvp, uvOffset, uvScale, tint = [1, 1, 1], buffer = null, count = 4, wrap = 0, cylMode = 0) {
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
  gl.uniform1f(state.loc.uWrap, wrap);
  gl.uniform1f(state.loc.uCylMode, cylMode);
  gl.uniform4fv(state.loc.uViewport, state.viewport);
  gl.uniform4fv(state.loc.uProjParams, state.projParams);
  gl.uniformMatrix3fv(state.loc.uCamRot, false, state.camRot);
  gl.uniform1f(state.loc.uCylScale, state.cylScale);
  gl.uniform1f(state.loc.uCylVcrop, state.cylVcrop);
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

function normalisePanoMode(value) {
  const key = String(value || '').toLowerCase().replace(/[\s_]+/g, '-');
  if (key === 'sphere' || key === 'spherical' || key === '360') return 'sphere';
  if (key === 'cylinder' || key === 'cylindrical' || key === 'cyl' || key === 'wrap') return 'cylinder';
  return null;
}

function panoMode() {
  const saved = normalisePanoMode(state.panoModeByRoot[state.rootId]);
  if (saved) return saved;
  return normalisePanoMode(rootCfg().pano_mode) || 'sphere';
}

// Панорама привязана к ориентации головы, но не к положению: смещение камеры
// убрано, иначе картинка «плывет» при малейшем движении в шлеме.
function panoViewMatrix(viewM) {
  const m = new Float32Array(16);
  m.set(viewM);
  m[12] = 0;
  m[13] = 0;
  m[14] = 0;
  return m;
}

// Логи для режима «стена»: раз в 2 с пишем параметры луча и выбранную v.
// По ним видно, что картинка зависит только от поворота головы, а не от экрана.
function logPanoDebug(eye, proj, camM, info) {
  const now = performance.now();
  if (now - state.lastPanoDebug < 2000) return;
  state.lastPanoDebug = now;
  const f = (arr) => Array.from(arr).map((n) => Number(n).toFixed(3)).join(',');
  // Камера смотрит в -Z; третий столбец camM — это ось +Z камеры.
  const fx = -camM[8];
  const fy = -camM[9];
  const fz = -camM[10];
  const horiz = Math.max(Math.hypot(fx, fz), 0.0001);
  const lon = Math.atan2(fx, -fz);
  const lat = Math.atan2(fy, horiz);
  const vWall = 0.5 + Math.tan(lat) * state.cylScale;
  const inside = vWall >= 0 && vWall <= 1;
  const vSrc = 0.5 + (vWall - 0.5) * state.cylVcrop;
  const halfFov = (Math.atan(0.5 / state.cylScale) * 180) / Math.PI;
  logClient(
    'DEBUG',
    `pano cylinder ${eye}: viewport=[${Array.from(state.viewport).map((n) => n.toFixed(0)).join(',')}] ` +
    `proj=[${f(proj.slice(0, 10))}] forward=[${f([fx, fy, fz])}] ` +
    `lon=${lon.toFixed(3)} lat=${lat.toFixed(3)} vWall=${vWall.toFixed(3)} inside=${inside ? 1 : 0} ` +
    `vSrc=${vSrc.toFixed(3)} ` +
    `aspect=${info.aspect.toFixed(3)} scale=${state.cylScale.toFixed(3)} vcrop=${state.cylVcrop.toFixed(3)} ` +
    `halfFov=${halfFov.toFixed(1)} ` +
    `zoom=${state.zoom.toFixed(2)} uv=[${info.uOffset.toFixed(3)},${info.vOffset.toFixed(3)}] ` +
    `uvScale=${info.s.toFixed(3)}`,
  );
}

// Сфера — обычная геометрия изнутри. Цилиндр — полноэкранный quad: для каждого
// фрагмента восстанавливаем луч, долготу по atan из направления и вертикаль
// по tan(возвышения). Так картинка статична в мире, без полюсов.
function drawPano(gl, proj, viewM, camM, eye) {
  const cylinder = panoMode() === 'cylinder';
  const s = clamp(1 / state.zoom, 0.1, 1);
  const uOffset = (1 - s) / 2 + state.view.panX * 0.5 * s;
  const vOffset = clamp((1 - s) / 2 + state.view.panY * 0.5 * s, 0, 1 - s);
  if (cylinder) {
    const aspect = state.aspect || 2;
    state.projParams = new Float32Array([1 / proj[0], 1 / proj[5], proj[8], proj[9]]);
    state.camRot = new Float32Array([
      camM[0], camM[1], camM[2],
      camM[4], camM[5], camM[6],
      camM[8], camM[9], camM[10],
    ]);
    // Отдельный принцип для «стены»: P[5] = 1/tan(половины вертикального FOV),
    // поэтому 0.5*P[5] разворачивает высоту стены ровно на угол глаза.
    const vfill = clamp(Number(rootCfg().panoCylVfill) || PANO_CYL_VFILL, 0.5, 1);
    state.cylScale = 0.5 * vfill * proj[5];
    // Центральная полоса эквайреугольного кадра: без полюсов сферы.
    state.cylVcrop = clamp(Number(rootCfg().panoCylVcrop) || PANO_CYL_VCROP, 0.2, 1);
    logPanoDebug(eye, proj, camM, { s, uOffset, vOffset, aspect });
    draw(
      gl, state.texPhoto, IDENTITY_MATRIX, [uOffset, vOffset], [s, s], [1, 1, 1],
      state.panoQuadVbo, 4, 1, 1,
    );
    return;
  }
  draw(
    gl, state.texPhoto, multiply(proj, panoViewMatrix(viewM)), [uOffset, vOffset], [s, s], [1, 1, 1],
    state.sphereVbo, state.sphereVertexCount, 1, 0,
  );
}

// В панораме нет угла кадра, поэтому метка и подпись висят в поле зрения.
function drawPanoOverlay(gl, proj) {
  const entry = state.entries[state.current];
  if (entry && state.selected.has(entry.path)) {
    const mark = multiply(proj, multiply(translate(0.42, 0.24, -1), scale(0.08, 0.08, 1)));
    draw(gl, state.texMark, mark, [0, 0], [1, 1]);
  }
  if (state.hudVisible) {
    const label = multiply(proj, multiply(translate(0, -0.42, -1), scale(1.1, 0.27, 1)));
    draw(gl, state.texLabel, label, [0, 0], [1, 1]);
  }
}

// Строка подсказки: серый заголовок блока и яркое значение.
function drawHintRow(ctx, x, y, labelKey, value) {
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#7d889e';
  const label = t(labelKey);
  ctx.fillText(label, x, y);
  ctx.fillStyle = '#e7eaf0';
  ctx.fillText(value, x + ctx.measureText(label).width + 12, y);
}

// Fallback для кастомных языков, где есть только старый vrLabelHint.
function drawWrappedHint(ctx, text, x, y, maxWidth, lineHeight) {
  ctx.font = '20px sans-serif';
  ctx.fillStyle = '#9aa3b5';
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      ctx.fillText(line, x, y);
      y += lineHeight;
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

function updateLabel(entry) {
  const canvas = state.labelCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, width, canvas.height);
  const marked = !!(entry && state.selected.has(entry.path));
  ctx.fillStyle = marked ? '#ffd34d' : '#ffffff';
  ctx.font = '28px sans-serif';
  ctx.textBaseline = 'middle';
  const index = state.images.indexOf(entry) + 1;
  ctx.fillText(`${marked ? '✓ ' : ''}${index}/${state.images.length}  ${entry.name}`.slice(0, 60), 20, 40);

  ctx.strokeStyle = '#2a3040';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(20, 72);
  ctx.lineTo(width - 20, 72);
  ctx.stroke();

  const vars = {
    zoom: state.zoom.toFixed(1),
    curve: Math.round(state.curve * 100),
    panX: signedPercent(state.view.panX),
    panY: signedPercent(state.view.panY),
    shift: signedPercent(state.view.shift, 1).replace('%', ''),
  };

  if (!state.dict.vrHintPhoto && state.dict.vrLabelHint) {
    drawWrappedHint(ctx, t('vrLabelHint', vars), 20, 104, width - 40, 32);
  } else {
    ctx.beginPath();
    ctx.moveTo(width / 2, 90);
    ctx.lineTo(width / 2, 200);
    ctx.stroke();
    const left = 20;
    const right = width / 2 + 20;
    drawHintRow(ctx, left, 106, 'vrHintPhoto', t('vrHintNavKeys'));
    drawHintRow(ctx, left, 142, 'vrHintZoom', `${t('vrHintZoomKeys')} ${vars.zoom}×`);
    drawHintRow(ctx, left, 178, 'vrHintMark', t('vrHintMarkKeys'));
    drawHintRow(ctx, right, 106, 'vrHintPan', `${t('vrHintPanKeys')} ${vars.panX}/${vars.panY}`);
    if (state.photoLayout?.type === 'pano') {
      drawHintRow(ctx, right, 142, 'vrHintLook', t('vrHintLookKeys'));
      drawHintRow(ctx, right, 178, 'panoProjection', t(panoMode() === 'cylinder' ? 'panoCylinder' : 'panoSphere'));
    } else {
      drawHintRow(ctx, right, 142, 'vrHintShift', `${t('vrHintShiftKeys')} ${vars.shift}%`);
      drawHintRow(ctx, right, 178, 'vrHintCurve', `${t('vrHintCurveKeys')} ${vars.curve}%`);
    }
    drawHintRow(ctx, left, 222, 'vrHintGallery', t('vrHintGalleryKeys'));
    drawHintRow(ctx, right, 214, 'vrHintPanel', t('vrHintPanelKeys'));
  }
  uploadImage(state.gl, state.texLabel, canvas);
}

function zoomBy(direction) {
  const factor = direction < 0 ? 1.12 : 1 / 1.12; // вверх — приблизить
  state.zoom = Math.round(Math.min(2.5, Math.max(0.6, state.zoom * factor)) * 1000) / 1000;
  state.zoomByRoot[state.rootId] = state.zoom;
  const entry = state.entries[state.current];
  if (entry && state.gl) updateLabel(entry);

  // Сохраняем на сервер не чаще одного раза в 500 мс, чтобы не дергать диск при удержании стика.
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
  const c = state.controls;
  const sx = c.panInvertX ? 1 : -1;
  const sy = c.panInvertY ? -1 : 1;
  setView({
    panX: state.view.panX + dx * sx * c.panStep,
    panY: state.view.panY + dy * sy * c.panStep,
  });
}

function shiftBy(dx) {
  if (!dx) return;
  const c = state.controls;
  const sign = c.shiftInvert ? -1 : 1;
  setView({ shift: state.view.shift + dx * sign * c.shiftStep });
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
  const c = state.controls;
  const gain = c.panBase + Math.max(0, 1 - 1 / state.zoom) * c.panGain;
  return translate(state.view.panX * halfW * gain, state.view.panY * halfH * gain, 0);
}

function photoEyeModel(right) {
  const pan = photoPanModel();
  if (!right || !state.view.shift ||
      state.photoLayout.type === 'mono' || state.photoLayout.type === 'pano') return pan;
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

function toggleHud() {
  state.hudVisible = !state.hudVisible;
  logClient('INFO', `VR panel: ${state.hudVisible ? 'shown' : 'hidden'}`);
  const entry = state.entries[state.current];
  if (state.gl && entry) updateLabel(entry);
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
    drawEyeThumb(ctx, img, entry, 0, 0, 512, 256);
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
  if (!state.gl || !state.headerCanvas) return;
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
  pushHistoryForDir(g.rel);
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
  syncHistoryMarker();
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
  const gripRising = gripPressed && !state.buttons.grip;
  const gripFalling = !gripPressed && state.buttons.grip;
  state.buttons.a = aPressed;
  if (gripRising) state.gripModified = false;
  if (gripFalling) {
    if (state.mode === 'photo' && !state.gripModified && !state.gripConsumed) toggleHud();
    state.gripConsumed = false;
  }
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
        state.gripModified = true;
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
        state.gripModified = true;
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
  if (!state.session && (e.key === 'b' || e.key === 'B') && hasParentDir(activeDirRel())) {
    logClient('INFO', `B key: ${activeDirRel() || '/'} -> ${parentDirRel(activeDirRel()) || '/'}`);
    goUpActiveDir().catch(showError);
    e.preventDefault();
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
  // После принудительного выхода из VR в очереди может остаться один кадр.
  if (!state.gl || !refSpace || state.session !== session) return;
  try {
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
      state.viewport = [vp.x, vp.y, vp.width, vp.height];
      const proj = view.projectionMatrix;
      const viewM = view.transform.inverse.matrix;

      if (state.mode === 'gallery') {
        renderGallery(gl, proj, viewM);
        continue;
      }

      if (state.photoLayout.type === 'pano') {
        drawPano(gl, proj, viewM, view.transform.matrix, view.eye);
        drawPanoOverlay(gl, proj);
        continue;
      }

      const z = state.distance / state.zoom;
      const right = view.eye === 'right';
      const uv = layoutUv(state.photoLayout.type, right, state.photoLayout.swap);
      drawCurvedPhoto(gl, proj, viewM, uv.offset, uv.scale, photoEyeModel(right));
      drawPhotoMark(gl, proj, viewM);

      if (state.hudVisible) {
        const labelModel = multiply(
          photoPanModel(),
          multiply(translate(0, -state.height / 2 - 0.2, -z), scale(1.2, 0.3, 1)),
        );
        draw(gl, state.texLabel, multiply(proj, multiply(viewM, labelModel)), [0, 0], [1, 1]);
      }
    }

    session.requestAnimationFrame(onFrame, refSpace);
  } catch (err) {
    // Ошибку кадра видно в панели «Логи» даже без подключенной консоли.
    logClient('ERROR', 'VR frame failed', err);
    session.end().catch(() => {});
  }
}

async function enterVR() {
  extendForwardEcho('vr enter');
  if (!navigator.xr) {
    throw new Error(t('errNoWebXR'));
  }
  if (!(await navigator.xr.isSessionSupported('immersive-vr'))) {
    throw new Error(t('errNoImmersive'));
  }

  logClient('INFO', 'enterVR: requesting immersive-vr session');
  const session = await navigator.xr.requestSession('immersive-vr');
  state.session = session;
  try {
    state.zoom = state.zoomByRoot[state.rootId] ?? 1.0;
    setCurve(state.curveByRoot[state.rootId] ?? 0, false);
    applyViewFromRoot(state.rootId);
    state.gallery.deleteArmed = false;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { xrCompatible: true, alpha: false, antialias: true });
    if (!gl) throw new Error(t('errNoWebGL'));
    await gl.makeXRCompatible();
    // state.gl выставляем только после успешной инициализации: иначе после
    // неудачного входа 2D-панель попытается рисовать в отсутствующий canvas.
    initGL(gl);
    state.gl = gl;
    logClient('INFO', 'enterVR: GL initialized');
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
      if (state.mode === 'gallery') {
        state.gripConsumed = true; // этот grip возвращает из галереи, панель не трогаем
        toggleGallery();
      }
      // В режиме фото grip — только модификатор изгиба в сочетании со стиком.
    });
    session.addEventListener('end', () => {
      logClient('INFO', 'VR session ended');
      extendForwardEcho('vr end');
      syncHistoryMarker();
      state.session = null;
      clearGLState();
      state.mode = 'photo';
      state.gallery.ray = null;
      state.gallery.hover = -1;
      state.gallery.navHover = '';
      state.gallery.deleteArmed = false;
      state.buttons = { stick: false, b: false, a: false, grip: false, trigger: false };
      state.hudVisible = true;
      state.gripModified = false;
      state.gripConsumed = false;
      state.lastPanoDebug = 0;
      state.curveAxis.y = 0;
      state.panAxis = { x: 0, y: 0, last: 0 };
      state.shiftAxis = { x: 0, last: 0 };
      updateSelectionUI();
      $('#vrBtn').disabled = state.current < 0;
    });

    if (state.current < 0) throw new Error(t('errNoImage'));
    await loadPhoto(state.entries[state.current]);
    state.lastPanoDebug = 0;
    logClient('INFO', `enterVR: photo loaded, layout=${state.photoLayout?.type || '?'}, projection=${panoMode()}`);
    session.requestAnimationFrame(onFrame, state.refSpace);
  } catch (err) {
    // Любая ошибка входа не должна оставлять выставленный state.gl.
    logClient('ERROR', 'enterVR failed', err);
    clearGLState();
    state.session = null;
    try {
      await session.end();
    } catch { /* сессия уже закрыта */ }
    throw err;
  }
}

init().catch(showError);
