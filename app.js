require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const { socketAuth } = require('./middleware/auth');
const setupSocket = require('./routes/socket');

// Ensure data & uploads dirs exist
['data', 'uploads'].forEach(dir => {
  const p = path.join(__dirname, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 30e6, // 30 MB for large socket payloads
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static: serve frontend & uploads ───────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/users',         require('./routes/users'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/messages',      require('./routes/messages'));
app.use('/api/uploads',       require('./routes/uploads'));

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: Date.now() }));

// ── Socket.IO ─────────────────────────────────────────────────────────────
io.use(socketAuth);
setupSocket(io);

// ── Catch-all: serve frontend SPA ─────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Frontend not found. Place index.html in /public/' });
  }
});

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🟣 Pulse Messenger backend running on http://localhost:${PORT}`);
  console.log(`   API:      http://localhost:${PORT}/api`);
  console.log(`   Frontend: place index.html in ./public/\n`);
});
