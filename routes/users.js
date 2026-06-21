const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function publicUser(u) {
  return {
    id: u._id,
    display_name: u.display_name,
    username: u.username,
    bio: u.bio || '',
    status: u.status || '',
    avatar: u.avatar || null,
    online: u.online || 0,
    last_seen: u.last_seen || 0,
  };
}

// GET /api/users/search?q=...
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (q.length < 2) return res.json({ users: [] });

    // Get blocked user IDs in both directions
    const blocks = await db.blocks.find({
      $or: [{ blocker_id: req.userId }, { blocked_id: req.userId }]
    });
    const blockedIds = new Set(blocks.flatMap(b => [b.blocker_id, b.blocked_id]));
    blockedIds.delete(req.userId); // Don't exclude ourselves from blocked set

    const allUsers = await db.users.find({
      _id: { $ne: req.userId }
    });

    const results = allUsers.filter(u => {
      if (blockedIds.has(u._id)) return false;
      return u.display_name?.toLowerCase().includes(q) || u.username?.toLowerCase().includes(q);
    }).slice(0, 15).map(publicUser);

    res.json({ users: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/users/block
router.post('/block', authMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    const existing = await db.blocks.findOne({ blocker_id: req.userId, blocked_id: user_id });
    if (!existing) {
      await db.blocks.insert({
        _id: uuidv4(),
        blocker_id: req.userId,
        blocked_id: user_id,
        created_at: Math.floor(Date.now() / 1000),
      });
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/users/block/:userId
router.delete('/block/:userId', authMiddleware, async (req, res) => {
  try {
    await db.blocks.remove({ blocker_id: req.userId, blocked_id: req.params.userId });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
