const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// Helper: build conversation response object
async function buildConvResponse(conv, userId) {
  const members = await db.members.find({ conversation_id: conv._id });
  const memberIds = members.map(m => m.user_id);
  const users = await db.users.find({ _id: { $in: memberIds } });
  const userMap = {};
  users.forEach(u => userMap[u._id] = u);

  // Unread count
  const myMember = members.find(m => m.user_id === userId);
  const lastRead = myMember?.last_read_at || 0;
  const unread = await db.messages.count({
    conversation_id: conv._id,
    sender_id: { $ne: userId },
    created_at: { $gt: lastRead },
    deleted: { $ne: 1 },
  });

  // Last message
  const lastMsgs = await db.messages.find({ conversation_id: conv._id, deleted: { $ne: 1 } })
    .sort({ created_at: -1 }).limit(1);
  const lastMsg = lastMsgs[0];

  let display_name = conv.name;
  let display_avatar = conv.avatar || null;
  let other_user = null;

  if (conv.type === 'direct') {
    const otherId = memberIds.find(id => id !== userId);
    const other = userMap[otherId];
    if (other) {
      display_name = other.display_name;
      display_avatar = other.avatar || null;
      other_user = {
        id: other._id,
        display_name: other.display_name,
        username: other.username,
        bio: other.bio || '',
        status: other.status || '',
        avatar: other.avatar || null,
        online: other.online || 0,
        last_seen: other.last_seen || 0,
      };
    }
  }

  return {
    id: conv._id,
    type: conv.type,
    name: conv.name,
    display_name,
    display_avatar,
    other_user,
    members: members.map(m => ({
      id: m.user_id,
      display_name: userMap[m.user_id]?.display_name || 'Unknown',
      role: m.role,
      online: userMap[m.user_id]?.online || 0,
    })),
    last_message: lastMsg?.content || null,
    last_message_at: lastMsg?.created_at || conv.created_at,
    updated_at: lastMsg?.created_at || conv.created_at,
    unread_count: unread,
    created_at: conv.created_at,
  };
}

// GET /api/conversations
router.get('/', authMiddleware, async (req, res) => {
  try {
    const myMemberships = await db.members.find({ user_id: req.userId });
    const convIds = myMemberships.map(m => m.conversation_id);
    const convs = await db.conversations.find({ _id: { $in: convIds } });

    const results = await Promise.all(convs.map(c => buildConvResponse(c, req.userId)));
    results.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    res.json({ conversations: results });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations/direct
router.post('/direct', authMiddleware, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    if (user_id === req.userId) return res.status(400).json({ error: 'Cannot chat with yourself' });

    // Check if direct conv already exists
    const myMems = await db.members.find({ user_id: req.userId });
    const myConvIds = myMems.map(m => m.conversation_id);
    const theirMems = await db.members.find({ user_id, conversation_id: { $in: myConvIds } });

    for (const mem of theirMems) {
      const conv = await db.conversations.findOne({ _id: mem.conversation_id, type: 'direct' });
      if (conv) {
        const response = await buildConvResponse(conv, req.userId);
        return res.json({ conversation: response });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const conv = await db.conversations.insert({
      _id: uuidv4(),
      type: 'direct',
      name: null,
      avatar: null,
      created_by: req.userId,
      created_at: now,
    });

    await db.members.insert([
      { _id: uuidv4(), conversation_id: conv._id, user_id: req.userId, role: 'member', joined_at: now, last_read_at: 0 },
      { _id: uuidv4(), conversation_id: conv._id, user_id, role: 'member', joined_at: now, last_read_at: 0 },
    ]);

    const response = await buildConvResponse(conv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/conversations/group
router.post('/group', authMiddleware, async (req, res) => {
  try {
    const { name, member_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'Group name required' });
    if (!member_ids?.length) return res.status(400).json({ error: 'Add at least one member' });

    const now = Math.floor(Date.now() / 1000);
    const conv = await db.conversations.insert({
      _id: uuidv4(),
      type: 'group',
      name,
      avatar: null,
      created_by: req.userId,
      created_at: now,
    });

    const allMemberIds = [req.userId, ...member_ids.filter(id => id !== req.userId)];
    await db.members.insert(allMemberIds.map(uid => ({
      _id: uuidv4(),
      conversation_id: conv._id,
      user_id: uid,
      role: uid === req.userId ? 'admin' : 'member',
      joined_at: now,
      last_read_at: 0,
    })));

    // System message
    const creator = await db.users.findOne({ _id: req.userId });
    await db.messages.insert({
      _id: uuidv4(),
      conversation_id: conv._id,
      sender_id: req.userId,
      sender_name: creator.display_name,
      type: 'system',
      content: `${creator.display_name} created this group`,
      created_at: now,
    });

    const response = await buildConvResponse(conv, req.userId);
    res.json({ conversation: response });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/conversations/:id/members
router.get('/:id/members', authMiddleware, async (req, res) => {
  try {
    const membership = await db.members.findOne({ conversation_id: req.params.id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const members = await db.members.find({ conversation_id: req.params.id });
    const userIds = members.map(m => m.user_id);
    const users = await db.users.find({ _id: { $in: userIds } });
    const userMap = {};
    users.forEach(u => userMap[u._id] = u);

    const result = members.map(m => ({
      id: m.user_id,
      display_name: userMap[m.user_id]?.display_name || 'Unknown',
      username: userMap[m.user_id]?.username || '',
      role: m.role,
      online: userMap[m.user_id]?.online || 0,
      last_seen: userMap[m.user_id]?.last_seen || 0,
    }));

    res.json({ members: result });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/conversations/:id/pinned
router.get('/:id/pinned', authMiddleware, async (req, res) => {
  try {
    const membership = await db.members.findOne({ conversation_id: req.params.id, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const pins = await db.pins.find({ conversation_id: req.params.id }).sort({ pinned_at: -1 });
    const msgIds = pins.map(p => p.message_id);
    const msgs = await db.messages.find({ _id: { $in: msgIds } });
    const msgMap = {};
    msgs.forEach(m => msgMap[m._id] = m);

    const pinned = pins.map(p => {
      const m = msgMap[p.message_id];
      return m ? { id: m._id, content: m.content, sender_name: m.sender_name, created_at: m.created_at } : null;
    }).filter(Boolean);

    res.json({ pinned });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.buildConvResponse = buildConvResponse;
