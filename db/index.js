const Datastore = require('nedb-promises');
const path = require('path');

const DB_DIR = path.join(__dirname, '../data');

const db = {
  users:         Datastore.create({ filename: path.join(DB_DIR, 'users.db'),         autoload: true }),
  conversations: Datastore.create({ filename: path.join(DB_DIR, 'conversations.db'), autoload: true }),
  members:       Datastore.create({ filename: path.join(DB_DIR, 'members.db'),       autoload: true }),
  messages:      Datastore.create({ filename: path.join(DB_DIR, 'messages.db'),      autoload: true }),
  reactions:     Datastore.create({ filename: path.join(DB_DIR, 'reactions.db'),     autoload: true }),
  pins:          Datastore.create({ filename: path.join(DB_DIR, 'pins.db'),          autoload: true }),
  reads:         Datastore.create({ filename: path.join(DB_DIR, 'reads.db'),         autoload: true }),
  blocks:        Datastore.create({ filename: path.join(DB_DIR, 'blocks.db'),        autoload: true }),
};

// Ensure indexes
(async () => {
  await db.users.ensureIndex({ fieldName: 'email', unique: true });
  await db.users.ensureIndex({ fieldName: 'username', unique: true });
  await db.messages.ensureIndex({ fieldName: 'conversation_id' });
  await db.members.ensureIndex({ fieldName: 'conversation_id' });
  await db.members.ensureIndex({ fieldName: 'user_id' });
  await db.reads.ensureIndex({ fieldName: 'message_id' });
  await db.reactions.ensureIndex({ fieldName: 'message_id' });
})();

module.exports = db;
