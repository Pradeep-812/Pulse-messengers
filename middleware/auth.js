const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'pulse_secret_change_in_prod';

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function socketAuth(socket, next) {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await db.users.findOne({ _id: payload.sub });
    if (!user) return next(new Error('User not found'));
    socket.userId = user._id;
    socket.user = user;
    next();
  } catch {
    next(new Error('Invalid token'));
  }
}

module.exports = { authMiddleware, socketAuth, JWT_SECRET };
