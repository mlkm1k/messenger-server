const express = require('express');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const server = http.createServer(app);
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./messenger.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE, nickname TEXT, last_seen INTEGER, is_online INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, name TEXT, is_group INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER, last_message TEXT, last_message_time INTEGER)`);
  db.run(`CREATE TABLE IF NOT EXISTS chat_members (chat_id TEXT, user_id TEXT, joined_at INTEGER, UNIQUE(chat_id, user_id))`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, sender_id TEXT, text TEXT, timestamp INTEGER, is_read INTEGER DEFAULT 0)`);
});

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 6); }

// ========== API ==========
app.post('/api/auth', (req, res) => {
  const { username, nickname } = req.body;
  const id = generateId();
  const now = Date.now();
  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (user) { db.run('UPDATE users SET last_seen = ?, is_online = 1 WHERE id = ?', [now, user.id]); res.json({ success: true, user: { ...user, is_online: 1 } }); }
    else { db.run(`INSERT INTO users (id, username, nickname, last_seen, is_online) VALUES (?, ?, ?, ?, 1)`, [id, username, nickname || username, now]); res.json({ success: true, user: { id, username, nickname: nickname || username, last_seen: now, is_online: 1 } }); }
  });
});

app.get('/api/users', (req, res) => { db.all('SELECT id, username, nickname, is_online, last_seen FROM users', (err, users) => { res.json(users || []); }); });

app.post('/api/get-private-chat', (req, res) => {
  const { userId, friendId } = req.body;
  if (userId === friendId) {
    const chatId = `saved_${userId}`;
    db.get('SELECT id FROM chats WHERE id = ?', [chatId], (err, existing) => {
      if (existing) return res.json({ chatId });
      db.run('INSERT INTO chats (id, name, is_group, created_at) VALUES (?, ?, 0, ?)', [chatId, 'Избранное', Date.now()]);
      db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', [chatId, userId, Date.now()]);
      res.json({ chatId });
    });
    return;
  }
  db.get(`SELECT c.id FROM chats c JOIN chat_members cm1 ON c.id = cm1.chat_id JOIN chat_members cm2 ON c.id = cm2.chat_id WHERE c.is_group = 0 AND cm1.user_id = ? AND cm2.user_id = ?`, [userId, friendId], (err, existing) => {
    if (existing) return res.json({ chatId: existing.id });
    const chatId = generateId();
    db.run('INSERT INTO chats (id, name, is_group, created_at) VALUES (?, ?, 0, ?)', [chatId, 'private', Date.now()]);
    db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', [chatId, userId, Date.now()]);
    db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', [chatId, friendId, Date.now()]);
    res.json({ chatId });
  });
});

app.post('/api/create-group', (req, res) => {
  const { name, creatorId, memberIds } = req.body;
  const chatId = generateId();
  db.run('INSERT INTO chats (id, name, is_group, created_by, created_at) VALUES (?, ?, 1, ?, ?)', [chatId, name, creatorId, Date.now()]);
  [creatorId, ...(memberIds || [])].forEach(uid => db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', [chatId, uid, Date.now()]));
  res.json({ chatId });
});

app.get('/api/chats/:userId', (req, res) => {
  db.all(`SELECT c.* FROM chats c JOIN chat_members cm ON c.id = cm.chat_id WHERE cm.user_id = ? ORDER BY c.last_message_time DESC`, [req.params.userId], (err, chats) => {
    if (!chats || chats.length === 0) return res.json([]);
    const result = []; let count = 0;
    chats.forEach(chat => {
      if (chat.is_group || chat.name === 'Избранное') {
        result.push({ id: chat.id, name: chat.name, is_group: chat.is_group, avatar: chat.is_group ? '👥' : '⭐', last_message: chat.last_message, last_message_time: chat.last_message_time });
        if (++count === chats.length) res.json(result);
      } else {
        db.get(`SELECT u.nickname FROM users u JOIN chat_members cm ON u.id = cm.user_id WHERE cm.chat_id = ? AND u.id != ?`, [chat.id, req.params.userId], (err, friend) => {
          result.push({ id: chat.id, name: friend?.nickname || 'Друг', is_group: false, avatar: '👤', last_message: chat.last_message, last_message_time: chat.last_message_time });
          if (++count === chats.length) res.json(result);
        });
      }
    });
  });
});

app.get('/api/messages/:chatId', (req, res) => {
  db.all(`SELECT m.*, u.nickname FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.chat_id = ? ORDER BY m.timestamp ASC LIMIT 100`, [req.params.chatId], (err, messages) => { res.json(messages || []); });
});

app.post('/api/messages/:chatId', (req, res) => {
  const { userId, text } = req.body;
  db.run(`INSERT INTO messages (chat_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)`, [req.params.chatId, userId, text, Date.now()], function() {
    db.run('UPDATE chats SET last_message = ?, last_message_time = ? WHERE id = ?', [text, Date.now(), req.params.chatId]);
    res.json({ success: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => { console.log(`✅ Сервер запущен на порту ${PORT}`); });