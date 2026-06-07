const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// База данных
const db = new sqlite3.Database('./messenger.db');

// Создаём таблицы
db.serialize(() => {
  // Пользователи
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE,
    nickname TEXT,
    avatar TEXT DEFAULT '👤',
    last_seen INTEGER,
    is_online INTEGER DEFAULT 0
  )`);

  // Чаты
  db.run(`CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER DEFAULT 0,
    created_by TEXT,
    created_at INTEGER
  )`);

  // Участники чатов
  db.run(`CREATE TABLE IF NOT EXISTS chat_members (
    chat_id TEXT,
    user_id TEXT,
    joined_at INTEGER,
    UNIQUE(chat_id, user_id)
  )`);

  // Сообщения
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT,
    sender_id TEXT,
    text TEXT,
    audio_url TEXT,
    timestamp INTEGER,
    is_read INTEGER DEFAULT 0
  )`);
});

// Генерация ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// ========== API ==========

// Вход/регистрация
app.post('/api/auth', (req, res) => {
  const { username, nickname } = req.body;
  const id = generateId();
  const now = Date.now();

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (user) {
      db.run('UPDATE users SET last_seen = ?, is_online = 1 WHERE id = ?', [now, user.id]);
      res.json({ success: true, user: { ...user, is_online: 1 } });
    } else {
      db.run(`INSERT INTO users (id, username, nickname, last_seen, is_online) 
              VALUES (?, ?, ?, ?, 1)`, [id, username, nickname || username, now]);
      res.json({ success: true, user: { id, username, nickname: nickname || username, last_seen: now, is_online: 1 } });
    }
  });
});

// Получить всех пользователей
app.get('/api/users', (req, res) => {
  db.all('SELECT id, username, nickname, avatar, is_online, last_seen FROM users', (err, users) => {
    res.json(users || []);
  });
});

// Создать или получить личный чат
app.post('/api/get-private-chat', (req, res) => {
  const { userId, friendId } = req.body;

  db.get(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON c.id = cm1.chat_id
    JOIN chat_members cm2 ON c.id = cm2.chat_id
    WHERE c.is_group = 0 AND cm1.user_id = ? AND cm2.user_id = ?
  `, [userId, friendId], (err, existing) => {
    if (existing) {
      res.json({ chatId: existing.id });
    } else {
      const chatId = generateId();
      db.run('INSERT INTO chats (id, name, is_group, created_at) VALUES (?, ?, 0, ?)', 
             [chatId, 'private', Date.now()]);
      db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', 
             [chatId, userId, Date.now()]);
      db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', 
             [chatId, friendId, Date.now()]);
      res.json({ chatId });
    }
  });
});

// Создать групповой чат
app.post('/api/create-group', (req, res) => {
  const { name, creatorId, memberIds } = req.body;
  const chatId = generateId();
  const allMembers = [creatorId, ...(memberIds || [])];

  db.run('INSERT INTO chats (id, name, is_group, created_by, created_at) VALUES (?, ?, 1, ?, ?)',
         [chatId, name, creatorId, Date.now()]);

  allMembers.forEach(userId => {
    db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)',
           [chatId, userId, Date.now()]);
  });

  res.json({ chatId });
});

// Получить все чаты пользователя
app.get('/api/chats/:userId', (req, res) => {
  const { userId } = req.params;

  db.all(`
    SELECT c.* FROM chats c
    JOIN chat_members cm ON c.id = cm.chat_id
    WHERE cm.user_id = ?
  `, [userId], (err, chats) => {
    if (!chats || chats.length === 0) {
      res.json([]);
      return;
    }

    const result = [];
    let count = 0;

    chats.forEach(chat => {
      if (chat.is_group) {
        result.push({
          id: chat.id,
          name: chat.name,
          is_group: true,
          avatar: '👥'
        });
        count++;
        if (count === chats.length) res.json(result);
      } else {
        db.get(`
          SELECT u.nickname, u.username, u.avatar FROM users u
          JOIN chat_members cm ON u.id = cm.user_id
          WHERE cm.chat_id = ? AND u.id != ?
        `, [chat.id, userId], (err, friend) => {
          result.push({
            id: chat.id,
            name: friend?.nickname || friend?.username || 'Друг',
            is_group: false,
            avatar: friend?.avatar || '👤'
          });
          count++;
          if (count === chats.length) res.json(result);
        });
      }
    });
  });
});

// Получить сообщения чата
app.get('/api/messages/:chatId', (req, res) => {
  const { chatId } = req.params;

  db.all(`
    SELECT m.*, u.nickname, u.username 
    FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ?
    ORDER BY m.timestamp ASC
    LIMIT 100
  `, [chatId], (err, messages) => {
    res.json(messages || []);
  });
});

// ========== WebSocket ==========

const clients = new Map();

function sendToChat(chatId, data, excludeUserId = null) {
  db.all('SELECT user_id FROM chat_members WHERE chat_id = ?', [chatId], (err, members) => {
    if (!members) return;
    members.forEach(member => {
      if (excludeUserId === member.user_id) return;
      const client = clients.get(member.user_id);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });
}

wss.on('connection', (ws) => {
  let currentUserId = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      if (msg.type === 'auth') {
        currentUserId = msg.userId;
        clients.set(currentUserId, ws);
        db.run('UPDATE users SET is_online = 1, last_seen = ? WHERE id = ?', 
               [Date.now(), currentUserId]);
      }

      if (msg.type === 'message') {
        db.run(`INSERT INTO messages (chat_id, sender_id, text, timestamp) 
                VALUES (?, ?, ?, ?)`,
               [msg.chatId, msg.userId, msg.text, Date.now()], function() {
          sendToChat(msg.chatId, {
            type: 'new_message',
            id: this.lastID,
            chat_id: msg.chatId,
            sender_id: msg.userId,
            text: msg.text,
            timestamp: Date.now(),
            sender_nickname: msg.senderNickname
          }, msg.userId);
        });
      }
    } catch (e) {
      console.error('Ошибка обработки сообщения:', e);
    }
  });

  ws.on('close', () => {
    if (currentUserId) {
      clients.delete(currentUserId);
      db.run('UPDATE users SET is_online = 0, last_seen = ? WHERE id = ?', 
             [Date.now(), currentUserId]);
    }
  });
});

// ========== Запуск ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер запущен на порту ${PORT}`);
  console.log(`📍 Адрес: http://localhost:${PORT}`);
});