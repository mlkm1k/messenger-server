const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./messenger.db');

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        nickname TEXT,
        avatar TEXT DEFAULT '👤',
        avatarUri TEXT,
        last_seen INTEGER,
        is_online INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        created_by TEXT,
        created_at INTEGER,
        last_message TEXT,
        last_message_time INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS chat_members (
        chat_id TEXT,
        user_id TEXT,
        joined_at INTEGER,
        UNIQUE(chat_id, user_id)
    )`);

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

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

function updateLastMessage(chatId, text, timestamp) {
    db.run('UPDATE chats SET last_message = ?, last_message_time = ? WHERE id = ?', [text, timestamp, chatId]);
}

// ========== API ==========

// Авторизация
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
    db.all('SELECT id, username, nickname, avatar, avatarUri, is_online, last_seen FROM users', (err, users) => {
        res.json(users || []);
    });
});

// Обновление профиля
app.post('/api/update-profile', (req, res) => {
    const { userId, nickname, avatarUri } = req.body;
    db.run('UPDATE users SET nickname = ?, avatarUri = ? WHERE id = ?', 
           [nickname, avatarUri || null, userId], function(err) {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            res.json({ success: true });
        }
    });
});

// Получить или создать личный чат (включая "Избранное" с самим собой)
app.post('/api/get-private-chat', (req, res) => {
    const { userId, friendId } = req.body;

    // Если это чат с самим собой (Избранное)
    if (userId === friendId) {
        const chatId = `saved_${userId}`;
        db.get('SELECT id FROM chats WHERE id = ?', [chatId], (err, existing) => {
            if (existing) {
                res.json({ chatId });
            } else {
                db.run('INSERT INTO chats (id, name, is_group, created_at, last_message, last_message_time) VALUES (?, ?, 0, ?, ?, ?)', 
                       [chatId, 'Избранное', Date.now(), null, null]);
                db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', 
                       [chatId, userId, Date.now()]);
                res.json({ chatId });
            }
        });
        return;
    }

    // Обычный личный чат с другом
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
            db.run('INSERT INTO chats (id, name, is_group, created_at, last_message, last_message_time) VALUES (?, ?, 0, ?, ?, ?)', 
                   [chatId, 'private', Date.now(), null, null]);
            db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', 
                   [chatId, userId, Date.now()]);
            db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)', 
                   [chatId, friendId, Date.now()]);
            res.json({ chatId });
        }
    });
});

// Создать группу
app.post('/api/create-group', (req, res) => {
    const { name, creatorId, memberIds } = req.body;
    const chatId = generateId();
    const allMembers = [creatorId, ...(memberIds || [])];

    db.run('INSERT INTO chats (id, name, is_group, created_by, created_at, last_message, last_message_time) VALUES (?, ?, 1, ?, ?, ?, ?)',
           [chatId, name, creatorId, Date.now(), null, null]);

    allMembers.forEach(userId => {
        db.run('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)',
               [chatId, userId, Date.now()]);
    });

    res.json({ chatId });
});

// Добавить участника в группу
app.post('/api/add-group-member', (req, res) => {
    const { chatId, userId } = req.body;
    db.run('INSERT OR IGNORE INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)',
           [chatId, userId, Date.now()], function(err) {
        if (err) {
            res.json({ success: false, error: err.message });
        } else {
            res.json({ success: true });
        }
    });
});

// Получить участников чата
app.get('/api/chat-members/:chatId', (req, res) => {
    const { chatId } = req.params;
    db.all(`
        SELECT u.id, u.nickname, u.username, u.avatarUri, u.is_online
        FROM chat_members cm
        JOIN users u ON cm.user_id = u.id
        WHERE cm.chat_id = ?
    `, [chatId], (err, members) => {
        res.json(members || []);
    });
});

// Получить чаты пользователя
app.get('/api/chats/:userId', (req, res) => {
    const { userId } = req.params;

    db.all(`
        SELECT c.* FROM chats c
        JOIN chat_members cm ON c.id = cm.chat_id
        WHERE cm.user_id = ?
        ORDER BY c.last_message_time DESC
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
                    avatar: '👥',
                    avatarUri: null,
                    last_message: chat.last_message,
                    last_message_time: chat.last_message_time
                });
                count++;
                if (count === chats.length) res.json(result);
            } else if (chat.name === 'Избранное') {
                result.push({
                    id: chat.id,
                    name: 'Избранное',
                    is_group: false,
                    avatar: '⭐',
                    avatarUri: null,
                    last_message: chat.last_message,
                    last_message_time: chat.last_message_time
                });
                count++;
                if (count === chats.length) res.json(result);
            } else {
                db.get(`
                    SELECT u.nickname, u.username, u.avatarUri FROM users u
                    JOIN chat_members cm ON u.id = cm.user_id
                    WHERE cm.chat_id = ? AND u.id != ?
                `, [chat.id, userId], (err, friend) => {
                    result.push({
                        id: chat.id,
                        name: friend?.nickname || friend?.username || 'Друг',
                        is_group: false,
                        avatar: '👤',
                        avatarUri: friend?.avatarUri || null,
                        last_message: chat.last_message,
                        last_message_time: chat.last_message_time
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
        SELECT m.*, u.nickname, u.username, u.avatarUri
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE m.chat_id = ?
        ORDER BY m.timestamp ASC
        LIMIT 100
    `, [chatId], (err, messages) => {
        res.json(messages || []);
    });
});

// ========== WEBSOCKET ==========
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
                    updateLastMessage(msg.chatId, msg.text, Date.now());
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

// ========== ЗАПУСК ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
});