const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { enrichMessages } = require('../routes/messages');

// Track online users: userId -> Set of socketIds
const onlineUsers = new Map();

function getSocketsForUser(io, userId) {
  const socketIds = onlineUsers.get(userId);
  if (!socketIds) return [];
  return [...socketIds].map(id => io.sockets.sockets.get(id)).filter(Boolean);
}

async function getMemberIds(convId) {
  const members = await db.members.find({ conversation_id: convId });
  return members.map(m => m.user_id);
}

function setupSocket(io) {
  io.on('connection', async (socket) => {
    const userId = socket.userId;
    const user = socket.user;

    // Track online
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socket.id);

    // Mark user online
    await db.users.update({ _id: userId }, { $set: { online: 1 } });

    // Notify contacts of presence
    const myMems = await db.members.find({ user_id: userId });
    const convIds = myMems.map(m => m.conversation_id);
    if (convIds.length) {
      const allMems = await db.members.find({ conversation_id: { $in: convIds }, user_id: { $ne: userId } });
      const contactIds = [...new Set(allMems.map(m => m.user_id))];
      for (const contactId of contactIds) {
        for (const sock of getSocketsForUser(io, contactId)) {
          sock.emit('user:presence', { user_id: userId, online: true });
        }
      }
    }

    console.log(`[socket] ${user.display_name} connected (${socket.id})`);

    // ─── JOIN CONVERSATION ROOM ───────────────────────────────────
    socket.on('conversation:join', async ({ conversation_id }) => {
      const membership = await db.members.findOne({ conversation_id, user_id: userId });
      if (!membership) return;
      socket.join(`conv:${conversation_id}`);
    });

    // ─── AUTO-JOIN all user's conversations on connect ────────────
    // So they receive messages even without clicking a conversation
    if (convIds.length) {
      for (const cid of convIds) socket.join(`conv:${cid}`);
    }

    // ─── SEND MESSAGE ─────────────────────────────────────────────
    socket.on('message:send', async (data, ack) => {
      try {
        const { conversation_id, content, type = 'text', reply_to, file_url, file_name, file_size } = data;

        const membership = await db.members.findOne({ conversation_id, user_id: userId });
        if (!membership) return ack?.({ error: 'Not a member' });
        if (!content && !file_url) return ack?.({ error: 'Empty message' });

        const now = Math.floor(Date.now() / 1000);

        let reply_content = null, reply_sender_name = null;
        if (reply_to) {
          const replyMsg = await db.messages.findOne({ _id: reply_to });
          if (replyMsg) {
            reply_content = replyMsg.content;
            reply_sender_name = replyMsg.sender_name;
          }
        }

        const msg = await db.messages.insert({
          _id: uuidv4(),
          conversation_id,
          sender_id: userId,
          sender_name: user.display_name,
          content: content || '',
          type,
          file_url: file_url || null,
          file_name: file_name || null,
          file_size: file_size || null,
          reply_to: reply_to || null,
          reply_content,
          reply_sender_name,
          edited: 0,
          deleted: 0,
          created_at: now,
        });

        const [enriched] = await enrichMessages([msg], userId);

        // Broadcast to entire room (all members auto-joined their conv rooms on connect)
        io.to(`conv:${conversation_id}`).emit('message:new', { conversation_id, message: enriched });

        ack?.({ success: true, message: enriched });
      } catch (e) {
        console.error('[message:send]', e);
        ack?.({ error: 'Failed to send' });
      }
    });

    // ─── EDIT MESSAGE ─────────────────────────────────────────────
    socket.on('message:edit', async ({ message_id, content }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id, sender_id: userId });
        if (!msg || msg.deleted) return;
        await db.messages.update({ _id: message_id }, { $set: { content, edited: 1 } });
        const updated = { ...msg, content, edited: 1 };
        const [enriched] = await enrichMessages([updated], userId);
        io.to(`conv:${msg.conversation_id}`).emit('message:edited', { conversation_id: msg.conversation_id, message: enriched });
      } catch (e) {
        console.error('[message:edit]', e);
      }
    });

    // ─── DELETE MESSAGE ───────────────────────────────────────────
    socket.on('message:delete', async ({ message_id, deleteForEveryone }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id, sender_id: userId });
        if (!msg) return;
        if (deleteForEveryone) {
          await db.messages.update({ _id: message_id }, { $set: { deleted: 1, content: 'This message was deleted' } });
          io.to(`conv:${msg.conversation_id}`).emit('message:deleted', { conversation_id: msg.conversation_id, message_id });
        } else {
          socket.emit('message:deleted', { conversation_id: msg.conversation_id, message_id });
        }
      } catch (e) {
        console.error('[message:delete]', e);
      }
    });

    // ─── REACT ────────────────────────────────────────────────────
    socket.on('message:react', async ({ message_id, emoji }) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id });
        if (!msg) return;
        const membership = await db.members.findOne({ conversation_id: msg.conversation_id, user_id: userId });
        if (!membership) return;

        const existing = await db.reactions.findOne({ message_id, user_id: userId, emoji });
        if (existing) {
          await db.reactions.remove({ _id: existing._id });
        } else {
          await db.reactions.insert({ _id: uuidv4(), message_id, user_id: userId, emoji, created_at: Math.floor(Date.now() / 1000) });
        }

        const reactions = await db.reactions.find({ message_id });
        io.to(`conv:${msg.conversation_id}`).emit('message:reacted', {
          conversation_id: msg.conversation_id,
          message_id,
          reactions: reactions.map(r => ({ emoji: r.emoji, user_id: r.user_id })),
        });
      } catch (e) {
        console.error('[message:react]', e);
      }
    });

    // ─── PIN MESSAGE ──────────────────────────────────────────────
    socket.on('message:pin', async ({ message_id }, ack) => {
      try {
        const msg = await db.messages.findOne({ _id: message_id });
        if (!msg) return ack?.({ error: 'Not found' });
        const membership = await db.members.findOne({ conversation_id: msg.conversation_id, user_id: userId });
        if (!membership) return ack?.({ error: 'Not a member' });

        const existing = await db.pins.findOne({ message_id });
        if (existing) {
          await db.pins.remove({ _id: existing._id });
        } else {
          await db.pins.insert({ _id: uuidv4(), conversation_id: msg.conversation_id, message_id, pinned_by: userId, pinned_at: Math.floor(Date.now() / 1000) });
        }

        io.to(`conv:${msg.conversation_id}`).emit('message:pinned', { conversation_id: msg.conversation_id, message_id });
        ack?.({ success: true });
      } catch (e) {
        console.error('[message:pin]', e);
        ack?.({ error: 'Failed' });
      }
    });

    // ─── READ RECEIPTS ────────────────────────────────────────────
    socket.on('message:read', async ({ conversation_id, message_ids }) => {
      try {
        if (!message_ids?.length) return;
        const now = Math.floor(Date.now() / 1000);

        for (const mid of message_ids) {
          const exists = await db.reads.findOne({ message_id: mid, user_id: userId });
          if (!exists) await db.reads.insert({ _id: uuidv4(), message_id: mid, user_id: userId, read_at: now });
        }

        await db.members.update({ conversation_id, user_id: userId }, { $set: { last_read_at: now } });

        const msgs = await db.messages.find({ _id: { $in: message_ids } });
        const senderIds = [...new Set(msgs.map(m => m.sender_id).filter(id => id !== userId))];
        for (const sid of senderIds) {
          for (const sock of getSocketsForUser(io, sid)) {
            sock.emit('message:seen', { conversation_id, user_id: userId, message_ids });
          }
        }
      } catch (e) {
        console.error('[message:read]', e);
      }
    });

    // ─── TYPING ───────────────────────────────────────────────────
    socket.on('typing:start', async ({ conversation_id }) => {
      const membership = await db.members.findOne({ conversation_id, user_id: userId });
      if (!membership) return;
      socket.to(`conv:${conversation_id}`).emit('typing:start', { conversation_id, user_id: userId, display_name: user.display_name });
    });

    socket.on('typing:stop', async ({ conversation_id }) => {
      socket.to(`conv:${conversation_id}`).emit('typing:stop', { conversation_id, user_id: userId });
    });

    // ═══════════════════════════════════════════════════════════════
    // VOICE/VIDEO CALLS — routed by target_user_id (not conv room)
    // Frontend emits: call:offer, call:answer, call:reject, call:end, call:ice-candidate
    // All use { target_user_id, ... }
    // ═══════════════════════════════════════════════════════════════

    // Caller initiates — frontend emits 'call:offer'
    socket.on('call:offer', async ({ target_user_id, conversation_id, call_type, offer }) => {
      console.log(`[call:offer] ${user.display_name} → ${target_user_id}`);
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:incoming', {
          conversation_id,
          call_type: call_type || 'voice',
          from_user_id: userId,
          from_display_name: user.display_name,
          offer,
        });
      }
    });

    // Callee answers — frontend emits 'call:answer'
    socket.on('call:answer', async ({ target_user_id, answer }) => {
      console.log(`[call:answer] ${user.display_name} → ${target_user_id}`);
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:answered', { answer });
      }
    });

    // Callee rejects — frontend emits 'call:reject'
    socket.on('call:reject', async ({ target_user_id }) => {
      console.log(`[call:reject] ${user.display_name} → ${target_user_id}`);
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:rejected');
      }
    });

    // Either side ends — frontend emits 'call:end'
    socket.on('call:end', async ({ target_user_id }) => {
      console.log(`[call:end] ${user.display_name} → ${target_user_id}`);
      if (target_user_id) {
        for (const sock of getSocketsForUser(io, target_user_id)) {
          sock.emit('call:ended');
        }
      }
    });

    // ICE candidates — frontend emits 'call:ice-candidate'
    socket.on('call:ice-candidate', async ({ target_user_id, candidate }) => {
      for (const sock of getSocketsForUser(io, target_user_id)) {
        sock.emit('call:ice-candidate', { candidate });
      }
    });

    // ─── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', async () => {
      const sockets = onlineUsers.get(userId);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          onlineUsers.delete(userId);
          const now = Math.floor(Date.now() / 1000);
          await db.users.update({ _id: userId }, { $set: { online: 0, last_seen: now } });

          const myMems2 = await db.members.find({ user_id: userId });
          const convIds2 = myMems2.map(m => m.conversation_id);
          if (convIds2.length) {
            const allMems2 = await db.members.find({ conversation_id: { $in: convIds2 }, user_id: { $ne: userId } });
            const contactIds2 = [...new Set(allMems2.map(m => m.user_id))];
            for (const contactId of contactIds2) {
              for (const sock of getSocketsForUser(io, contactId)) {
                sock.emit('user:presence', { user_id: userId, online: false });
              }
            }
          }
        }
      }
      console.log(`[socket] ${user.display_name} disconnected`);
    });
  });
}

module.exports = setupSocket;
