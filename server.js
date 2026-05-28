const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

const USER_COLORS = [
  '#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c',
  '#3498db','#9b59b6','#e91e63','#00bcd4','#8bc34a'
];

function getOrCreateSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { id, users: new Map(), elements: [] });
  }
  return sessions.get(id);
}

app.get('/', (req, res) => {
  res.redirect('/board/' + uuidv4().slice(0, 8));
});

app.get('/board/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/qr/:id', async (req, res) => {
  const url = `${req.protocol}://${req.get('host')}/board/${req.params.id}`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg', width: 220, margin: 1 });
    const qr = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    res.json({ qr, url });
  } catch (err) {
    console.error('QR error:', err);
    res.status(500).json({ error: 'QR failed' });
  }
});

io.on('connection', (socket) => {
  let session = null;
  let user = null;

  socket.on('join', ({ sessionId, name }) => {
    session = getOrCreateSession(sessionId);
    const colorIdx = session.users.size % USER_COLORS.length;
    user = { id: socket.id, name: name || 'Anonymous', color: USER_COLORS[colorIdx] };
    session.users.set(socket.id, user);
    socket.join(sessionId);

    socket.emit('init', {
      me: user,
      elements: session.elements,
      users: Array.from(session.users.values()),
    });

    socket.to(sessionId).emit('user-joined', user);
    io.to(sessionId).emit('users', Array.from(session.users.values()));
  });

  socket.on('stroke-start', (data) => {
    if (!session) return;
    socket.to(session.id).emit('stroke-start', { ...data, userId: socket.id });
  });

  socket.on('stroke-move', (data) => {
    if (!session) return;
    socket.to(session.id).emit('stroke-move', data);
  });

  socket.on('stroke-end', (data) => {
    if (!session) return;
    const el = { type: 'stroke', id: data.id, userId: socket.id, color: data.color, width: data.width, points: data.points };
    session.elements.push(el);
    socket.to(session.id).emit('stroke-end', el);
  });

  socket.on('textbox-add', (data) => {
    if (!session) return;
    const el = { type: 'textbox', id: data.id, userId: socket.id, x: data.x, y: data.y, text: data.text || '', color: data.color || '#1a1a2e', fontSize: data.fontSize || 18 };
    session.elements.push(el);
    socket.to(session.id).emit('textbox-add', el);
  });

  socket.on('textbox-update', (data) => {
    if (!session) return;
    const el = session.elements.find(e => e.id === data.id);
    if (el) { el.text = data.text; el.x = data.x; el.y = data.y; }
    socket.to(session.id).emit('textbox-update', data);
  });

  socket.on('textbox-delete', (data) => {
    if (!session) return;
    session.elements = session.elements.filter(e => e.id !== data.id);
    io.to(session.id).emit('textbox-delete', data);
  });

  socket.on('clear', () => {
    if (!session) return;
    session.elements = [];
    io.to(session.id).emit('clear');
  });

  socket.on('cursor', (data) => {
    if (!session || !user) return;
    socket.to(session.id).emit('cursor', { userId: socket.id, name: user.name, color: user.color, x: data.x, y: data.y });
  });

  socket.on('undo', () => {
    if (!session) return;
    const myElements = session.elements.filter(e => e.userId === socket.id);
    if (!myElements.length) return;
    const last = myElements[myElements.length - 1];
    session.elements = session.elements.filter(e => e.id !== last.id);
    io.to(session.id).emit('remove-element', { id: last.id });
  });

  socket.on('disconnect', () => {
    if (!session || !user) return;
    session.users.delete(socket.id);
    io.to(session.id).emit('user-left', { id: socket.id });
    io.to(session.id).emit('users', Array.from(session.users.values()));
    io.to(session.id).emit('cursor-remove', { userId: socket.id });
    if (session.users.size === 0) {
      setTimeout(() => { if (sessions.get(session.id)?.users.size === 0) sessions.delete(session.id); }, 3_600_000);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Whiteboard → http://localhost:${PORT}`));
