/**
 * ╔═══════════════════════════════════╗
 * ║      NEON CHAT - SERVER v1.0      ║
 * ║   Built for Termux Android        ║
 * ╚═══════════════════════════════════╝
 */

const express = require('express');
const { pool, initDB } = require('./db');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  maxHttpBufferSize: 4 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const SECRET = 'NeonChat_S3cr3t_K3y_2024!';
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

// ─── Utilities ───────────────────────────────────────────────────────────────

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET).update(password).digest('hex');
}

function generateToken(userId) {
  const payload = JSON.stringify({ userId, ts: Date.now() });
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  try {
    if (!token || !token.includes('.')) return null;
    const [b64, sig] = token.split('.');
    const payload = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    return JSON.parse(payload);
  } catch { return null; }
}

// ─── Data Management ─────────────────────────────────────────────────────────

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let users = [];
let messages = [];
let dbReady = false;
const onlineSockets = new Map(); // socketId → userId

async function initData() {
  try {
    await initDB();
    dbReady = true;

    // Load users từ MySQL
    const [rows] = await pool.execute('SELECT * FROM users');
    users = rows.map(u => ({...u, banned: !!u.banned}));

    // Thêm default accounts nếu chưa có
    const defaultUsers = [
      { id: "owner-001", username: "owner", password: hashPassword("owner123"), role: "owner", color: "#ff00ff", bio: "👑 Owner", badge: "⚡ OWNER", banned: false },
      { id: "admin-001", username: "admin", password: hashPassword("admin123"), role: "admin", color: "#00ffff", bio: "🛡️ Admin", badge: "🛡️ ADMIN", banned: false }
    ];
    for (const def of defaultUsers) {
      if (!users.find(u => u.id === def.id)) {
        users.push(def);
      }
    }
    await saveUsers();

    // Load messages từ MySQL
    const [msgRows] = await pool.execute('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 500');
    messages = msgRows.reverse();

    console.log(`Loaded ${users.length} users, ${messages.length} messages from MySQL`);
  } catch (err) {
    console.error('MySQL error, falling back to JSON:', err.message);
    dbReady = false;
    // Fallback JSON
    if (!fs.existsSync(USERS_FILE)) { users = []; saveUsers(); }
    else users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (!fs.existsSync(MESSAGES_FILE)) { messages = []; saveMessages(); }
    else messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
  }
}

async function saveUsers() {
  if (!dbReady) { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch(e){} return; }
  for (const u of users) {
    await pool.execute(`
      INSERT INTO users (id, email, username, password, color, bio, role, badge, banned)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        email=VALUES(email), username=VALUES(username), password=VALUES(password),
        color=VALUES(color), bio=VALUES(bio), role=VALUES(role),
        badge=VALUES(badge), banned=VALUES(banned)
    `, [u.id, u.email||null, u.username, u.password, u.color||'#00f5ff', u.bio||'', u.role||'user', u.badge||'', u.banned?1:0]);
  }
}

async function saveMessages() {
  if (!dbReady) { try { fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2)); } catch(e){} return; }
  // Chỉ lưu tin nhắn mới nhất chưa có trong DB
  for (const m of messages.slice(-50)) {
    await pool.execute(`
      INSERT IGNORE INTO messages (id, userId, username, color, role, badge, type, content, imageData, timestamp)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `, [m.id, m.userId, m.username, m.color||'#00f5ff', m.role||'user', m.badge||'', m.type||'text', m.content||'', m.imageData||null, new Date(m.timestamp)]);
  }
}

function publicUser(u) {
  const isOnline = [...onlineSockets.values()].includes(u.id);
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    color: u.color,
    bio: u.bio || '',
    badge: u.badge || '',
    banned: u.banned || false,
    online: isOnline
  };
}

function broadcastUsers() {
  io.emit('users_update', users.map(publicUser));
}

function broadcastOnline() {
  const onlineIds = [...new Set(onlineSockets.values())];
  io.emit('online_update', onlineIds);
}

// ─── Express Middleware ───────────────────────────────────────────────────────

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers['x-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid token' });
  const user = users.find(u => u.id === payload.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (user.banned) return res.status(403).json({ error: 'Account banned' });
  req.user = user;
  next();
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu' });
  const user = users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase().trim());
  if (!user || user.password !== hashPassword(password))
    return res.status(401).json({ error: 'Email hoặc mật khẩu không đúng' });
  if (user.banned) return res.status(403).json({ error: 'Tài khoản đã bị khóa' });
  const token = generateToken(user.id);
  res.json({ token, user: publicUser(user) });
});

// Register
app.post('/api/register', (req, res) => {
  const { email, username, password } = req.body || {};
  if (!email || !username || !password) return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  const uname = username.trim();
  const uemail = email.toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(uemail)) return res.status(400).json({ error: 'Email không hợp lệ' });
  if (uname.length < 2 || uname.length > 32) return res.status(400).json({ error: 'Tên hiển thị: 2-32 ký tự' });
  if (password.length < 4) return res.status(400).json({ error: 'Mật khẩu: tối thiểu 4 ký tự' });
  if (users.find(u => u.email && u.email.toLowerCase() === uemail))
    return res.status(400).json({ error: 'Email này đã được đăng ký' });

  const colors = ['#ff6b35','#00ff88','#ff88cc','#88aaff','#ffaa00','#00aaff','#ff4488','#44ffcc'];
  const newUser = {
    id: 'u' + Date.now(),
    email: uemail,
    username: uname,
    password: hashPassword(password),
    role: 'user',
    color: colors[Math.floor(Math.random() * colors.length)],
    bio: '',
    badge: '',
    createdAt: new Date().toISOString(),
    banned: false
  };
  users.push(newUser);
  saveUsers();
  const token = generateToken(newUser.id);
  res.json({ token, user: publicUser(newUser) });
});

// Get recent messages (last 80)
app.get('/api/messages', requireAuth, (req, res) => {
  const recent = messages.slice(-80).map(msg => {
    const sender = users.find(u => u.id === msg.userId);
    return {
      ...msg,
      username: sender?.username || msg.username,
      color: sender?.color || msg.color,
      role: sender?.role || 'user',
      badge: sender?.badge || ''
    };
  });
  res.json(recent);
});

// Get all users
app.get('/api/users', requireAuth, (req, res) => {
  res.json(users.map(publicUser));
});

// Update own profile
app.put('/api/profile', requireAuth, (req, res) => {
  const { color, bio, badge, newPassword, currentPassword, newUsername } = req.body || {};

  // Đổi username
  if (newUsername) {
    const uname = newUsername.trim();
    if (uname.length < 3 || uname.length > 16)
      return res.status(400).json({ error: 'Tên: 3-16 ký tự' });
    if (!/^[a-zA-Z0-9_]+$/.test(uname))
      return res.status(400).json({ error: 'Chỉ dùng chữ, số, gạch dưới' });
    if (users.find(u => u.username.toLowerCase() === uname.toLowerCase() && u.id !== req.user.id))
      return res.status(400).json({ error: 'Tên này đã có người dùng' });
    // Cập nhật username trong lịch sử tin nhắn
    messages.forEach(m => { if (m.userId === req.user.id) m.username = uname; });
    saveMessages();
    users[idx].username = uname;
  }
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) users[idx].color = color;
  if (bio !== undefined) users[idx].bio = String(bio).slice(0, 100);
  if (badge !== undefined) users[idx].badge = String(badge).slice(0, 20);

  if (newPassword) {
    if (!currentPassword) return res.status(400).json({ error: 'Current password required' });
    if (users[idx].password !== hashPassword(currentPassword)) return res.status(400).json({ error: 'Wrong current password' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'New password: min 4 chars' });
    users[idx].password = hashPassword(newPassword);
  }

  saveUsers();
  broadcastUsers();
  res.json({ user: publicUser(users[idx]) });
});

// Admin/Owner: update user role or ban
app.put('/api/users/:id', requireAuth, (req, res) => {
  const { role, banned } = req.body || {};
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Permission checks
  if (!['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Cannot modify owner' });
  if (req.user.role === 'admin' && target.role === 'admin') return res.status(403).json({ error: 'Admins cannot modify other admins' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot modify yourself' });

  const idx = users.findIndex(u => u.id === req.params.id);

  if (role !== undefined && req.user.role === 'owner') {
    if (['user', 'admin'].includes(role)) {
      users[idx].role = role;
      users[idx].badge = role === 'admin' ? '🛡️ ADMIN' : '';
    }
  }
  if (banned !== undefined) users[idx].banned = !!banned;

  saveUsers();
  broadcastUsers();

  // Kick banned/demoted users if connected
  if (users[idx].banned) {
    for (const [sid, uid] of onlineSockets) {
      if (uid === req.params.id) {
        io.to(sid).emit('force_logout', { reason: 'Your account has been banned.' });
      }
    }
  }

  res.json({ success: true, user: publicUser(users[idx]) });
});

// Owner: delete user account
app.delete('/api/users/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Cannot delete owner' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  // Kick the user
  for (const [sid, uid] of onlineSockets) {
    if (uid === req.params.id) {
      io.to(sid).emit('force_logout', { reason: 'Your account has been deleted.' });
    }
  }

  users = users.filter(u => u.id !== req.params.id);
  saveUsers();
  broadcastUsers();
  res.json({ success: true });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let myUserId = null;

  socket.on('authenticate', ({ token }) => {
    const payload = verifyToken(token);
    if (!payload) return socket.emit('auth_failed', 'Invalid token');
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return socket.emit('auth_failed', 'Not authorized');
    myUserId = user.id;
    onlineSockets.set(socket.id, user.id);
    socket.emit('authenticated', { userId: user.id });
    broadcastOnline();
    broadcastUsers();
  });

  socket.on('send_message', ({ content, token, type, imageData }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return;

    const msgType = type === 'image' ? 'image' : 'text';

    if (msgType === 'image') {
      if (!imageData || !imageData.startsWith('data:image/')) return;
      if (imageData.length > 3 * 1024 * 1024) return; // giới hạn 3MB
      const msg = {
        id: Date.now().toString() + Math.random().toString(36).slice(2,6),
        userId: user.id,
        username: user.username,
        color: user.color,
        role: user.role,
        badge: user.badge || '',
        type: 'image',
        content: '',
        imageData: imageData,
        timestamp: new Date().toISOString()
      };
      messages.push(msg);
      if (messages.length > 1000) messages.splice(0, 100);
      saveMessages();
      io.emit('new_message', msg);
      return;
    }

    const text = String(content || '').trim();
    if (!text || text.length > 2000) return;

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2,6),
      userId: user.id,
      username: user.username,
      color: user.color,
      role: user.role,
      badge: user.badge || '',
      type: 'text',
      content: text,
      timestamp: new Date().toISOString()
    };
    messages.push(msg);
    if (messages.length > 1000) messages.splice(0, 100);
    saveMessages();
    io.emit('new_message', msg);
  });

  socket.on('delete_message', ({ messageId, token }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || !['admin', 'owner'].includes(user.role)) return;
    const idx = messages.findIndex(m => m.id === messageId);
    if (idx !== -1) {
      messages.splice(idx, 1);
      saveMessages();
      io.emit('message_deleted', { messageId });
    }
  });

  socket.on('typing', ({ token }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return;
    socket.broadcast.emit('user_typing', { username: user.username, color: user.color });
  });

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    broadcastOnline();
    broadcastUsers();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

initData().catch(console.error);
server.listen(PORT, '0.0.0.0', () => {
  const divider = '═'.repeat(45);
  console.log(`\n╔${divider}╗`);
  console.log(`║       ⚡ NEON CHAT SERVER STARTED ⚡        ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  URL   : http://localhost:${PORT}               ║`);
  console.log(`║  Port  : ${PORT}                                 ║`);
  console.log(`╠${divider}╣`);
  console.log(`║  👑 owner  / owner123  [OWNER]              ║`);
  console.log(`║  🛡️  admin  / admin123  [ADMIN]              ║`);
  console.log(`║  👤 user1  / user1     [USER]               ║`);
  console.log(`║  👤 user2  / user2     [USER]               ║`);
  console.log(`╚${divider}╝\n`);
  console.log(`  Open your browser and go to http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop the server\n`);
});
