/**
 * ╔═══════════════════════════════════╗
 * ║      NEON CHAT - SERVER v1.0      ║
 * ║   Built for Termux Android        ║
 * ╚═══════════════════════════════════╝
 */

const express = require('express');
const { pool, initDB } = require('./db');
const { uploadFile, getPresignedUrl, deleteFile } = require('./b2');
const multer = require('multer');
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 } // 200MB max
});
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
let groups = [];
let dbReady = false;
const onlineSockets = new Map(); // socketId → userId

async function initData() {
  try {
    await initDB();
    dbReady = true;

    // Load users từ MySQL
    const [rows] = await pool.execute('SELECT * FROM users');
    users = rows.map(u => ({...u, banned: !!u.banned}));

    // Thêm default accounts nếu chưa có (không ghi đè nếu đã tồn tại)
    const defaultUsers = [
      { id: "owner-001", username: "owner", loginName: "owner", password: hashPassword("owner123"), role: "owner", color: "#ff00ff", bio: "👑 Owner", badge: "⚡ OWNER", banned: false },
      { id: "admin-001", username: "admin", loginName: "admin", password: hashPassword("admin123"), role: "admin", color: "#00ffff", bio: "🛡️ Admin", badge: "🛡️ ADMIN", banned: false }
    ];
    let needSave = false;
    for (const def of defaultUsers) {
      if (!users.find(u => u.id === def.id)) {
        users.push(def);
        needSave = true;
      }
    }
    if (needSave) await saveUsers();

    // Load messages từ MySQL
    const [msgRows] = await pool.execute('SELECT * FROM messages ORDER BY timestamp DESC LIMIT 500');
    messages = msgRows.reverse();

    // Load groups
    const [groupRows] = await pool.execute('SELECT * FROM groups_chat ORDER BY createdAt ASC');
    groups = groupRows;
    for (const g of groups) {
      const [members] = await pool.execute('SELECT * FROM group_members WHERE groupId = ?', [g.id]);
      g.members = members;
    }

    console.log(`Loaded ${users.length} users, ${messages.length} messages, ${groups.length} groups from MySQL`);
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
      INSERT INTO users (id, email, loginName, username, password, color, bio, role, badge, avatar, banned)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        email=VALUES(email), loginName=VALUES(loginName), username=VALUES(username),
        password=VALUES(password), color=VALUES(color), bio=VALUES(bio),
        role=VALUES(role), badge=VALUES(badge), avatar=VALUES(avatar), banned=VALUES(banned)
    `, [u.id, u.email||null, u.loginName||null, u.username, u.password, u.color||'#00f5ff', u.bio||'', u.role||'user', u.badge||'', u.avatar||null, u.banned?1:0]);
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
    avatar: u.avatar || null,
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type,x-token');
  next();
});
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
  const input = email.toLowerCase().trim();

  // Owner và admin đăng nhập bằng loginName cố định
  let user = null;
  if (['owner', 'admin'].includes(input)) {
    user = users.find(u => (u.loginName || u.username).toLowerCase() === input && ['owner', 'admin'].includes(u.role));
  }
  // User thường đăng nhập bằng email
  if (!user) {
    user = users.find(u => u.email && u.email.toLowerCase() === input);
  }

  if (!user || user.password !== hashPassword(password))
    return res.status(401).json({ error: 'Thông tin đăng nhập không đúng' });
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

  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });

  // Đổi username (cho phép trùng tên)
  if (newUsername) {
    const uname = newUsername.trim();
    if (uname.length < 2 || uname.length > 32)
      return res.status(400).json({ error: 'Tên: 2-32 ký tự' });
    messages.forEach(m => { if (m.userId === req.user.id) m.username = uname; });
    saveMessages();
    users[idx].username = uname;
  }

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

// Update avatar
app.put('/api/avatar', requireAuth, async (req, res) => {
  const { avatar } = req.body || {};
  if (!avatar || !avatar.startsWith('data:image/')) return res.status(400).json({ error: 'Invalid image' });
  if (avatar.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Ảnh tối đa 2MB' });
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  users[idx].avatar = avatar;
  await saveUsers();
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

// ── File Upload API ──────────────────────────

app.post('/api/upload', requireAuth, (req, res, next) => {
  req.setTimeout(300000); // 5 phút timeout
  res.setTimeout(300000);
  next();
}, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const file = req.file;
  const ext = file.originalname.split('.').pop().toLowerCase();
  const isVideo = ['mp4','webm','mov','avi','mkv'].includes(ext);
  const isFile = !isVideo && !['jpg','jpeg','png','gif','webp'].includes(ext);

  // Giới hạn kích thước
  const maxSize = isVideo ? 200 * 1024 * 1024 : isFile ? 1024 * 1024 * 1024 : 10 * 1024 * 1024;
  if (file.size > maxSize) {
    return res.status(400).json({ error: isVideo ? 'Video tối đa 200MB' : isFile ? 'File tối đa 1GB' : 'Ảnh tối đa 10MB' });
  }

  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const type = isVideo ? 'video' : isFile ? 'file' : 'image';

  try {
    await uploadFile(key, file.buffer, file.mimetype);
    const url = await getPresignedUrl(key);
    res.json({
      key,
      url,
      type,
      name: file.originalname,
      size: file.size,
      mime: file.mimetype,
      expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString()
    });
  } catch(e) {
    console.error('B2 upload error:', e);
    res.status(500).json({ error: 'Lỗi upload file' });
  }
});

// Lấy presigned URL mới cho file
app.get('/api/file/:key', requireAuth, async (req, res) => {
  try {
    const url = await getPresignedUrl(decodeURIComponent(req.params.key));
    res.json({ url });
  } catch(e) {
    res.status(404).json({ error: 'File không tồn tại hoặc đã hết hạn' });
  }
});

// ── Group API ────────────────────────────────

// Lấy danh sách group của user
app.get('/api/groups', requireAuth, (req, res) => {
  const myGroups = groups.filter(g => g.members.some(m => m.userId === req.user.id));
  res.json(myGroups);
});

// Tạo group mới
app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, memberIds, avatar } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Tên group không được trống' });
  if (name.trim().length > 50) return res.status(400).json({ error: 'Tên tối đa 50 ký tự' });

  const groupId = 'g' + Date.now();
  const newGroup = {
    id: groupId,
    name: name.trim(),
    createdBy: req.user.id,
    avatar: avatar || '👥',
    createdAt: new Date().toISOString(),
    members: []
  };

  // Thêm người tạo làm admin
  const allMemberIds = [...new Set([req.user.id, ...(memberIds || [])])];

  if (dbReady) {
    await pool.execute('INSERT INTO groups_chat (id, name, createdBy, avatar) VALUES (?,?,?,?)',
      [groupId, newGroup.name, req.user.id, newGroup.avatar]);
    for (const uid of allMemberIds) {
      const role = uid === req.user.id ? 'admin' : 'member';
      await pool.execute('INSERT INTO group_members (groupId, userId, role) VALUES (?,?,?)',
        [groupId, uid, role]);
      newGroup.members.push({ groupId, userId: uid, role });
    }
  }

  groups.push(newGroup);
  // Thông báo cho các thành viên
  for (const [sid, uid] of onlineSockets) {
    if (allMemberIds.includes(uid)) {
      io.to(sid).emit('group_added', newGroup);
    }
  }
  res.json(newGroup);
});

// Xóa group
app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const member = group.members.find(m => m.userId === req.user.id);
  const isSysPriv = ['owner','admin'].includes(req.user.role);
  if (!isSysPriv && (!member || member.role !== 'admin')) return res.status(403).json({ error: 'Không có quyền xóa group' });

  if (dbReady) {
    await pool.execute('DELETE FROM groups_chat WHERE id = ?', [req.params.id]);
    await pool.execute('DELETE FROM group_members WHERE groupId = ?', [req.params.id]);
    await pool.execute('DELETE FROM group_messages WHERE groupId = ?', [req.params.id]);
  }
  groups = groups.filter(g => g.id !== req.params.id);
  io.emit('group_deleted', { groupId: req.params.id });
  res.json({ success: true });
});

// Thêm thành viên vào group
app.post('/api/groups/:id/members', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const me = group.members.find(m => m.userId === req.user.id);
  const isSysPriv = ['owner','admin'].includes(req.user.role);
  if (!isSysPriv && (!me || me.role !== 'admin')) return res.status(403).json({ error: 'Không có quyền thêm thành viên' });
  const { userId } = req.body || {};
  if (group.members.find(m => m.userId === userId)) return res.status(400).json({ error: 'Đã là thành viên' });

  if (dbReady) {
    await pool.execute('INSERT INTO group_members (groupId, userId, role) VALUES (?,?,?)', [group.id, userId, 'member']);
  }
  group.members.push({ groupId: group.id, userId, role: 'member' });
  for (const [sid, uid] of onlineSockets) {
    if (uid === userId) io.to(sid).emit('group_added', group);
  }
  io.emit('group_updated', group);
  res.json({ success: true });
});

// Rời group
app.delete('/api/groups/:id/members/:userId', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const targetId = req.params.userId;
  const me = group.members.find(m => m.userId === req.user.id);
  const isSysPriv = ['owner','admin'].includes(req.user.role);
  if (targetId !== req.user.id && !isSysPriv && (!me || me.role !== 'admin'))
    return res.status(403).json({ error: 'Không có quyền' });

  if (dbReady) {
    await pool.execute('DELETE FROM group_members WHERE groupId = ? AND userId = ?', [group.id, targetId]);
  }
  group.members = group.members.filter(m => m.userId !== targetId);
  io.emit('group_updated', group);
  res.json({ success: true });
});

// Lấy tin nhắn group
app.get('/api/groups/:id/messages', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (!group.members.find(m => m.userId === req.user.id)) return res.status(403).json({ error: 'Không phải thành viên' });
  if (!dbReady) return res.json([]);
  const [rows] = await pool.execute(
    'SELECT * FROM group_messages WHERE groupId = ? ORDER BY timestamp DESC LIMIT 80', [req.params.id]);
  res.json(rows.reverse());
});

// Đổi role thành viên trong group
app.put('/api/groups/:id/members/:userId/role', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const myMember = group.members.find(m => m.userId === req.user.id);
  const isSysPriv = ['owner','admin'].includes(req.user.role);
  if (!isSysPriv && (!myMember || myMember.role !== 'admin')) return res.status(403).json({ error: 'Không có quyền' });
  const { role } = req.body || {};
  if (!['admin', 'member'].includes(role)) return res.status(400).json({ error: 'Role không hợp lệ' });
  const target = group.members.find(m => m.userId === req.params.userId);
  if (!target) return res.status(404).json({ error: 'Thành viên không tồn tại' });
  target.role = role;
  if (dbReady) {
    await pool.execute('UPDATE group_members SET role = ? WHERE groupId = ? AND userId = ?',
      [role, group.id, req.params.userId]);
  }
  io.emit('group_updated', group);
  res.json({ success: true });
});

// Tìm kiếm group (tất cả group public)
app.get('/api/groups/search', requireAuth, (req, res) => {
  const keyword = (req.query.q || '').toLowerCase().trim();
  const result = groups
    .filter(g => !keyword || g.name.toLowerCase().includes(keyword))
    .map(g => ({
      id: g.id,
      name: g.name,
      avatar: g.avatar,
      memberCount: g.members.length,
      isMember: g.members.some(m => m.userId === req.user.id)
    }))
    .slice(0, 20);
  res.json(result);
});

// Tham gia group
app.post('/api/groups/:id/join', requireAuth, async (req, res) => {
  const group = groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.members.find(m => m.userId === req.user.id))
    return res.status(400).json({ error: 'Đã là thành viên' });
  if (dbReady) {
    await pool.execute('INSERT INTO group_members (groupId, userId, role) VALUES (?,?,?)',
      [group.id, req.user.id, 'member']);
  }
  group.members.push({ groupId: group.id, userId: req.user.id, role: 'member' });
  for (const [sid, uid] of onlineSockets) {
    if (uid === req.user.id) io.to(sid).emit('group_added', group);
  }
  io.emit('group_updated', group);
  res.json({ success: true });
});

// Admin/Owner: reset user password
app.post('/api/users/:id/reset-password', requireAuth, async (req, res) => {
  if (!['admin', 'owner'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Mật khẩu tối thiểu 4 ký tự' });
  const target = users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Không thể reset mật khẩu owner' });
  if (req.user.role === 'admin' && target.role === 'admin') return res.status(403).json({ error: 'Không thể reset mật khẩu admin khác' });
  const idx = users.findIndex(u => u.id === req.params.id);
  users[idx].password = hashPassword(newPassword);
  await saveUsers();
  res.json({ success: true });
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
  if (dbReady) {
    pool.execute('DELETE FROM users WHERE id = ?', [req.params.id]).catch(console.error);
    pool.execute('DELETE FROM messages WHERE userId = ?', [req.params.id]).catch(console.error);
  }
  messages = messages.filter(m => m.userId !== req.params.id);
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

  socket.on('send_message', ({ content, token, type, imageData, fileKey, fileUrl, fileName, fileSize, fileMime, fileExpires }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return;

    const msgType = ['image','video','file'].includes(type) ? type : 'text';

    if (msgType === 'image') {
      if (!imageData || !imageData.startsWith('data:image/')) return;
      if (imageData.length > 3 * 1024 * 1024) return;
      const msg = {
        id: Date.now().toString() + Math.random().toString(36).slice(2,6),
        userId: user.id, username: user.username, color: user.color,
        role: user.role, badge: user.badge || '', type: 'image',
        content: '', imageData, avatar: user.avatar || null,
        timestamp: new Date().toISOString()
      };
      messages.push(msg);
      if (messages.length > 1000) messages.splice(0, 100);
      saveMessages();
      io.emit('new_message', msg);
      return;
    }

    if (msgType === 'video' || msgType === 'file') {
      if (!fileKey) return;
      const msg = {
        id: Date.now().toString() + Math.random().toString(36).slice(2,6),
        userId: user.id, username: user.username, color: user.color,
        role: user.role, badge: user.badge || '', type: msgType,
        content: '', fileKey, fileUrl, fileName, fileSize, fileMime,
        fileExpires, avatar: user.avatar || null,
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
      userId: user.id, username: user.username, color: user.color,
      role: user.role, badge: user.badge || '', type: 'text',
      content: text, avatar: user.avatar || null,
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
    console.log('delete_message:', messageId, 'found:', idx !== -1);
    if (idx !== -1) {
      messages.splice(idx, 1);
      if (dbReady) {
        pool.execute('DELETE FROM messages WHERE id = ?', [messageId]).catch(console.error);
      }
      io.emit('message_deleted', { messageId });
    }
  });

  socket.on('send_group_message', async ({ groupId, content, token, type, imageData }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return;
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.members.find(m => m.userId === user.id)) return;

    const msgType = type === 'image' ? 'image' : 'text';
    if (msgType === 'text') {
      const text = String(content || '').trim();
      if (!text || text.length > 2000) return;
    } else {
      if (!imageData || !imageData.startsWith('data:image/')) return;
      if (imageData.length > 3 * 1024 * 1024) return;
    }

    const msg = {
      id: Date.now().toString() + Math.random().toString(36).slice(2,6),
      groupId,
      userId: user.id,
      username: user.username,
      color: user.color,
      role: user.role,
      badge: user.badge || '',
      type: msgType,
      content: msgType === 'text' ? String(content).trim() : '',
      imageData: msgType === 'image' ? imageData : null,
      avatar: user.avatar || null,
      timestamp: new Date().toISOString()
    };

    if (dbReady) {
      await pool.execute(`INSERT INTO group_messages (id, groupId, userId, username, color, role, badge, type, content, imageData, avatar, timestamp)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [msg.id, groupId, msg.userId, msg.username, msg.color, msg.role, msg.badge, msg.type, msg.content, msg.imageData, msg.avatar, new Date(msg.timestamp)]);
    }

    // Gửi cho tất cả thành viên group đang online
    for (const [sid, uid] of onlineSockets) {
      if (group.members.find(m => m.userId === uid)) {
        io.to(sid).emit('new_group_message', msg);
      }
    }
  });

  socket.on('delete_group_message', async ({ groupId, messageId, token }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user) return;
    const group = groups.find(g => g.id === groupId);
    if (!group) return;
    const member = group.members.find(m => m.userId === user.id);
    if (!member || (member.role !== 'admin' && !['admin','owner'].includes(user.role))) return;

    if (dbReady) {
      await pool.execute('DELETE FROM group_messages WHERE id = ? AND groupId = ?', [messageId, groupId]);
    }
    for (const [sid, uid] of onlineSockets) {
      if (group.members.find(m => m.userId === uid)) {
        io.to(sid).emit('group_message_deleted', { groupId, messageId });
      }
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
