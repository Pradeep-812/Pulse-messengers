const express = require('express');
const db = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

async function enrichMessages(messages, userId) {
  const msgIds = messages.map(m => m._id);

  const [reactions, reads] = await Promise.all([
    db.reactions.find({ message_id: { $in: msgIds } }),
    db.reads.find({ message_id: { $in: msgIds } }),
  ]);

  const reactionMap = {};
  reactions.forEach(r => {
    if (!reactionMap[r.message_id]) reactionMap[r.message_id] = [];
    reactionMap[r.message_id].push({ emoji: r.emoji, user_id: r.user_id });
  });

  const readMap = {};
  reads.forEach(r => {
    if (!readMap[r.message_id]) readMap[r.message_id] = [];
    readMap[r.message_id].push({ user_id: r.user_id });
  });

  return messages.map(m => ({
    id: m._id,
    conversation_id: m.conversation_id,
    sender_id: m.sender_id,
    sender_name: m.sender_name,
    content: m.content,
    type: m.type || 'text',
    file_url: m.file_url || null,
    file_name: m.file_name || null,
    file_size: m.file_size || null,
    reply_to: m.reply_to || null,
    reply_content: m.reply_content || null,
    reply_sender_name: m.reply_sender_name || null,
    edited: m.edited || 0,
    deleted: m.deleted || 0,
    created_at: m.created_at,
    reactions: reactionMap[m._id] || [],
    read_by: readMap[m._id] || [],
  }));
}

// GET /api/messages/:convId?limit=60&before=<timestamp>
router.get('/:convId', authMiddleware, async (req, res) => {
  try {
    const { convId } = req.params;

    // Verify membership
    const membership = await db.members.findOne({ conversation_id: convId, user_id: req.userId });
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const limit = Math.min(parseInt(req.query.limit) || 60, 100);
    const before = parseInt(req.query.before) || null;

    let query = { conversation_id: convId };
    if (before) query.created_at = { $lt: before };

    const messages = await db.messages.find(query).sort({ created_at: -1 }).limit(limit);
    messages.reverse();

    const enriched = await enrichMessages(messages, req.userId);
    res.json({ messages: enriched });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports.enrichMessages = enrichMessages;
