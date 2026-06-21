const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

function makeToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(u) {
  return {
    id: u._id,
    display_name: u.display_name,
    username: u.username,
    email: u.email,
    bio: u.bio || '',
    status: u.status || '',
    avatar: u.avatar || null,
    online: u.online || 0,
    last_seen: u.last_seen || 0,
  };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { display_name, username, email, password } = req.body;
    if (!display_name || !username || !email || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.users.findOne({ $or: [{ email }, { username: username.toLowerCase() }] });
    if (existing) return res.status(409).json({ error: 'Email or username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const now = Math.floor(Date.now() / 1000);
    const user = await db.users.insert({
      _id: uuidv4(),
      display_name,
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password: hash,
      bio: '',
      status: '',
      avatar: null,
      online: 0,
      last_seen: now,
      created_at: now,
    });

    res.json({ token: makeToken(user._id), user: publicUser(user) });
  } catch (e) {
    if (e.errorType === 'uniqueViolated')
      return res.status(409).json({ error: 'Email or username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'All fields required' });

    const user = await db.users.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ token: makeToken(user._id), user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await db.users.findOne({ _id: req.userId });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: publicUser(user) });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/auth/profile
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { display_name, bio, status } = req.body;
    const updates = {};
    if (display_name !== undefined) updates.display_name = display_name;
    if (bio !== undefined) updates.bio = bio;
    if (status !== undefined) updates.status = status;

    await db.users.update({ _id: req.userId }, { $set: updates });
    const user = await db.users.findOne({ _id: req.userId });
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.publicUser = publicUser;
