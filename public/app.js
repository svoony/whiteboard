/* ── helpers ──────────────────────────────────────────────── */
function uid() { return Math.random().toString(36).slice(2, 10); }
function toast(msg, ms = 2000) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ── state ───────────────────────────────────────────────── */
const S = {
  tool: 'pen',
  color: '#1a1a2e',
  size: 4,
  me: null,                // { id, name, color }
  users: [],
  elements: [],            // committed strokes + textboxes
  liveStrokes: new Map(),  // id → { color, width, points[] }  (in-progress)
  textboxEls: new Map(),   // id → DOM div
  cursorEls: new Map(),    // userId → DOM div
  drawing: false,
  strokeId: null,
  strokePts: [],
  offset: { x: 0, y: 0 }, // pan
  spaceDown: false,
  panStart: null,
  offsetStart: null,
  dpr: window.devicePixelRatio || 1,
};

/* ── canvas setup ────────────────────────────────────────── */
const canvas = document.getElementById('main-canvas');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('canvas-wrap');
const tbLayer = document.getElementById('textbox-layer');
const curLayer = document.getElementById('cursor-layer');

function resizeCanvas() {
  S.dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = w * S.dpr;
  canvas.height = h * S.dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
  render();
}
window.addEventListener('resize', resizeCanvas);

/* ── drawing helpers ─────────────────────────────────────── */
function drawStroke(c, pts, color, width) {
  if (!pts || pts.length < 2) return;
  c.save();
  c.strokeStyle = color;
  c.lineWidth = width;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.globalCompositeOperation = (color === '#ffffff') ? 'destination-out' : 'source-over';
  c.beginPath();
  c.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  c.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  c.stroke();
  c.globalCompositeOperation = 'source-over';
  c.restore();
}

function render() {
  const w = canvas.width / S.dpr, h = canvas.height / S.dpr;
  ctx.clearRect(0, 0, w, h);

  // white background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.translate(S.offset.x, S.offset.y);

  // committed strokes
  for (const el of S.elements) {
    if (el.type === 'stroke') drawStroke(ctx, el.points, el.color, el.width);
  }

  // live / in-progress strokes
  for (const [, stroke] of S.liveStrokes) {
    drawStroke(ctx, stroke.points, stroke.color, stroke.width);
  }

  ctx.restore();

  // reposition text boxes and cursors to match pan
  positionTextboxes();
  positionCursors();
}

/* ── screen ↔ world coords ───────────────────────────────── */
function toWorld(sx, sy) {
  const r = canvas.getBoundingClientRect();
  return { x: sx - r.left - S.offset.x, y: sy - r.top - S.offset.y };
}
function toScreen(wx, wy) {
  return { x: wx + S.offset.x, y: wy + S.offset.y };
}

/* ── textboxes ───────────────────────────────────────────── */
function positionTextboxes() {
  for (const [id, div] of S.textboxEls) {
    const el = S.elements.find(e => e.id === id);
    if (!el) continue;
    const sc = toScreen(el.x, el.y);
    div.style.left = sc.x + 'px';
    div.style.top = sc.y + 'px';
  }
}

function createTextboxDOM(el, editable = false) {
  if (S.textboxEls.has(el.id)) return S.textboxEls.get(el.id);

  const div = document.createElement('div');
  div.className = 'textbox' + (editable ? ' editable mine' : '');
  div.setAttribute('contenteditable', editable ? 'true' : 'false');
  div.style.color = el.color;
  div.style.fontSize = el.fontSize + 'px';
  div.innerText = el.text || '';

  const sc = toScreen(el.x, el.y);
  div.style.left = sc.x + 'px';
  div.style.top = sc.y + 'px';

  // editing events (only for own boxes)
  if (editable) {
    let dragOff = null;
    // move on mousedown background area
    div.addEventListener('mousedown', e => {
      if (e.target !== div) return; // clicking inside text - let browser handle
      dragOff = { sx: e.clientX, sy: e.clientY, ox: el.x, oy: el.y };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!dragOff) return;
      const r = canvas.getBoundingClientRect();
      el.x = dragOff.ox + (e.clientX - dragOff.sx);
      el.y = dragOff.oy + (e.clientY - dragOff.sy);
      positionTextboxes();
      socket.emit('textbox-update', { id: el.id, text: el.text, x: el.x, y: el.y });
    });
    window.addEventListener('mouseup', () => { dragOff = null; });

    div.addEventListener('input', () => {
      el.text = div.innerText;
      socket.emit('textbox-update', { id: el.id, text: el.text, x: el.x, y: el.y });
    });

    // dbl-click to delete
    div.addEventListener('dblclick', () => {
      if (!confirm('Delete this text box?')) return;
      socket.emit('textbox-delete', { id: el.id });
      removeTextbox(el.id);
    });

    // focus immediately
    setTimeout(() => { div.focus(); placeCaretAtEnd(div); }, 50);
  }

  tbLayer.appendChild(div);
  S.textboxEls.set(el.id, div);
  return div;
}

function placeCaretAtEnd(el) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function removeTextbox(id) {
  const div = S.textboxEls.get(id);
  if (div) { div.remove(); S.textboxEls.delete(id); }
  S.elements = S.elements.filter(e => e.id !== id);
}

/* ── cursors ─────────────────────────────────────────────── */
function positionCursors() {
  for (const [uid, { el, wx, wy }] of S.cursorEls) {
    const sc = toScreen(wx, wy);
    el.style.left = sc.x + 'px';
    el.style.top = sc.y + 'px';
  }
}

function setCursor(userId, name, color, wx, wy) {
  let data = S.cursorEls.get(userId);
  if (!data) {
    const el = document.createElement('div');
    el.className = 'r-cursor';
    el.innerHTML = `
      <svg viewBox="0 0 24 24" fill="${color}" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 0L4 20L8.5 15.5L12 22L14 21L10.5 14.5L17 14.5Z"/>
      </svg>
      <span class="r-cursor-label" style="background:${color}">${name}</span>`;
    curLayer.appendChild(el);
    data = { el, wx: 0, wy: 0 };
    S.cursorEls.set(userId, data);
  }
  data.wx = wx;
  data.wy = wy;
  const sc = toScreen(wx, wy);
  data.el.style.left = sc.x + 'px';
  data.el.style.top = sc.y + 'px';
}

function removeCursor(userId) {
  const data = S.cursorEls.get(userId);
  if (data) { data.el.remove(); S.cursorEls.delete(userId); }
}

/* ── lobby ───────────────────────────────────────────────── */
function updateLobby(users) {
  S.users = users;
  const container = document.getElementById('lobby-avatars');
  const count = document.getElementById('lobby-count');
  container.innerHTML = '';
  for (const u of users) {
    const av = document.createElement('div');
    av.className = 'avatar';
    av.style.background = u.color;
    av.textContent = u.name.charAt(0).toUpperCase();
    av.title = u.name;
    container.appendChild(av);
  }
  count.textContent = users.length + (users.length === 1 ? ' online' : ' online');
}

/* ── mouse / touch events ────────────────────────────────── */
function getPos(e) {
  if (e.touches) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

// throttle cursor emit
let lastCursorEmit = 0;
function emitCursor(wx, wy) {
  const now = Date.now();
  if (now - lastCursorEmit < 40) return;
  lastCursorEmit = now;
  socket.emit('cursor', { x: wx, y: wy });
}

wrap.addEventListener('mousedown', onPointerDown);
wrap.addEventListener('touchstart', onPointerDown, { passive: false });
wrap.addEventListener('mousemove', onPointerMove);
wrap.addEventListener('touchmove', onPointerMove, { passive: false });
window.addEventListener('mouseup', onPointerUp);
window.addEventListener('touchend', onPointerUp);

function onPointerDown(e) {
  if (e.touches && e.touches.length > 1) return; // ignore multi-touch for now
  e.preventDefault();

  const { x: sx, y: sy } = getPos(e);

  // panning: space+drag or middle mouse
  if (S.spaceDown || e.button === 1) {
    S.panStart = { x: sx, y: sy };
    S.offsetStart = { ...S.offset };
    wrap.classList.add('panning');
    return;
  }

  if (!S.me) return;

  if (S.tool === 'text') {
    const wp = toWorld(sx, sy);
    const el = { type: 'textbox', id: uid(), userId: S.me.id, x: wp.x, y: wp.y, text: '', color: S.color, fontSize: S.size * 4 + 4 };
    S.elements.push(el);
    createTextboxDOM(el, true);
    socket.emit('textbox-add', { id: el.id, x: el.x, y: el.y, text: '', color: el.color, fontSize: el.fontSize });
    return;
  }

  if (S.tool === 'pen' || S.tool === 'eraser') {
    S.drawing = true;
    S.strokeId = uid();
    const wp = toWorld(sx, sy);
    S.strokePts = [wp];
    const strokeColor = S.tool === 'eraser' ? '#ffffff' : S.color;
    const strokeWidth = S.tool === 'eraser' ? S.size * 3 : S.size;
    S.liveStrokes.set(S.strokeId, { color: strokeColor, width: strokeWidth, points: S.strokePts });
    socket.emit('stroke-start', { id: S.strokeId, color: strokeColor, width: strokeWidth, points: S.strokePts });
    render();
  }
}

function onPointerMove(e) {
  if (e.touches) e.preventDefault();
  const { x: sx, y: sy } = getPos(e);

  // panning
  if (S.panStart) {
    S.offset.x = S.offsetStart.x + (sx - S.panStart.x);
    S.offset.y = S.offsetStart.y + (sy - S.panStart.y);
    render();
    return;
  }

  const wp = toWorld(sx, sy);
  emitCursor(wp.x, wp.y);

  if (!S.drawing) return;

  S.strokePts.push(wp);
  const stroke = S.liveStrokes.get(S.strokeId);
  if (stroke) stroke.points = S.strokePts;
  socket.emit('stroke-move', { id: S.strokeId, points: S.strokePts });
  render();
}

function onPointerUp() {
  // end pan
  if (S.panStart) {
    S.panStart = null;
    S.offsetStart = null;
    wrap.classList.remove('panning');
    return;
  }

  if (!S.drawing) return;
  S.drawing = false;

  const stroke = S.liveStrokes.get(S.strokeId);
  if (!stroke || stroke.points.length < 2) {
    S.liveStrokes.delete(S.strokeId);
    render();
    return;
  }

  // commit
  const committed = { type: 'stroke', id: S.strokeId, userId: S.me?.id, color: stroke.color, width: stroke.width, points: stroke.points };
  S.elements.push(committed);
  S.liveStrokes.delete(S.strokeId);
  socket.emit('stroke-end', committed);
  render();
}

/* ── keyboard ────────────────────────────────────────────── */
window.addEventListener('keydown', e => {
  if (e.code === 'Space' && document.activeElement.tagName !== 'INPUT' && !document.querySelector('.textbox:focus')) {
    e.preventDefault();
    S.spaceDown = true;
    wrap.style.cursor = 'grab';
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    socket.emit('undo');
  }
  if (e.key === 'p' || e.key === 'P') setTool('pen');
  if (e.key === 'e' || e.key === 'E') setTool('eraser');
  if (e.key === 't' || e.key === 'T') setTool('text');
});
window.addEventListener('keyup', e => {
  if (e.code === 'Space') {
    S.spaceDown = false;
    wrap.style.cursor = '';
    setToolCursor();
  }
});

/* ── toolbar ─────────────────────────────────────────────── */
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  setToolCursor();
}

function setToolCursor() {
  wrap.classList.remove('tool-text', 'tool-eraser');
  if (S.tool === 'text') wrap.classList.add('tool-text');
  if (S.tool === 'eraser') wrap.classList.add('tool-eraser');
}

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

// color
const colorBtn = document.getElementById('color-btn');
const colorInput = document.getElementById('color-input');
colorBtn.addEventListener('click', () => colorInput.click());
colorInput.addEventListener('input', () => {
  S.color = colorInput.value;
  colorBtn.style.background = S.color;
});

// size
const sizeSlider = document.getElementById('size-slider');
sizeSlider.addEventListener('input', () => { S.size = +sizeSlider.value; });

// undo
document.getElementById('btn-undo').addEventListener('click', () => socket.emit('undo'));

// clear
document.getElementById('btn-clear').addEventListener('click', () => {
  if (!confirm('Clear the entire board for everyone?')) return;
  socket.emit('clear');
});

// share
document.getElementById('btn-share').addEventListener('click', openShare);
document.getElementById('close-share-btn').addEventListener('click', () => {
  document.getElementById('share-modal').classList.remove('open');
});
document.getElementById('share-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('share-modal'))
    document.getElementById('share-modal').classList.remove('open');
});
document.getElementById('copy-btn').addEventListener('click', () => {
  const url = document.getElementById('share-url').value;
  navigator.clipboard.writeText(url).then(() => toast('Link copied!'));
});
document.getElementById('share-url').addEventListener('click', e => e.target.select());

async function openShare() {
  const sessionId = location.pathname.split('/').pop();
  const modal = document.getElementById('share-modal');
  modal.classList.add('open');
  try {
    const res = await fetch(`/api/qr/${sessionId}`);
    const data = await res.json();
    document.getElementById('qr-img').src = data.qr;
    document.getElementById('share-url').value = data.url;
  } catch {
    toast('Could not load QR code');
  }
}

/* ── socket.io ───────────────────────────────────────────── */
const socket = io();

socket.on('init', ({ me, elements, users }) => {
  S.me = me;

  // load existing elements
  for (const el of elements) {
    S.elements.push(el);
    if (el.type === 'textbox') {
      const isMine = el.userId === me.id;
      createTextboxDOM(el, isMine);
    }
  }

  updateLobby(users);
  render();
});

socket.on('users', updateLobby);

socket.on('user-joined', u => toast(`${u.name} joined`));

socket.on('user-left', ({ id }) => {
  removeCursor(id);
});

// strokes
socket.on('stroke-start', data => {
  S.liveStrokes.set(data.id, { color: data.color, width: data.width, points: data.points || [] });
});
socket.on('stroke-move', data => {
  const s = S.liveStrokes.get(data.id);
  if (s) s.points = data.points;
  render();
});
socket.on('stroke-end', data => {
  S.liveStrokes.delete(data.id);
  S.elements.push({ type: 'stroke', id: data.id, userId: data.userId, color: data.color, width: data.width, points: data.points });
  render();
});

// textboxes
socket.on('textbox-add', el => {
  if (S.textboxEls.has(el.id)) return; // already created (own)
  S.elements.push(el);
  createTextboxDOM(el, false);
});
socket.on('textbox-update', data => {
  const el = S.elements.find(e => e.id === data.id);
  if (el) { el.text = data.text; el.x = data.x; el.y = data.y; }
  const div = S.textboxEls.get(data.id);
  if (div && document.activeElement !== div) {
    div.innerText = data.text;
    positionTextboxes();
  }
});
socket.on('textbox-delete', ({ id }) => removeTextbox(id));

// clear / undo
socket.on('clear', () => {
  S.elements = [];
  S.liveStrokes.clear();
  for (const [id, div] of S.textboxEls) div.remove();
  S.textboxEls.clear();
  render();
});
socket.on('remove-element', ({ id }) => {
  S.elements = S.elements.filter(e => e.id !== id);
  removeTextbox(id);
  render();
});

// cursors
socket.on('cursor', ({ userId, name, color, x, y }) => {
  if (userId !== socket.id) setCursor(userId, name, color, x, y);
});
socket.on('cursor-remove', ({ userId }) => removeCursor(userId));

/* ── join flow ───────────────────────────────────────────── */
const joinOverlay = document.getElementById('join-overlay');
const nameInput = document.getElementById('name-input');
const joinBtn = document.getElementById('join-btn');

function doJoin() {
  const name = nameInput.value.trim() || 'Anonymous';
  const sessionId = location.pathname.split('/').pop();
  joinOverlay.style.display = 'none';
  document.getElementById('app').classList.add('ready');
  resizeCanvas();
  socket.emit('join', { sessionId, name });
}

joinBtn.addEventListener('click', doJoin);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });

// auto-focus name input
nameInput.focus();
