/**
 * ╔═══════════════════════════════════╗
 * ║      NEON CHAT - SERVER v1.0      ║
 * ║      NEON GAMESHOWS - SERVER v1.0 ║
 * ╚═══════════════════════════════════╝
 */

const express = require('express');
const axios = require('axios');
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

// ─── Nạp .env cho môi trường dev (không cần thư viện ngoài) ─────────────────────
// Trên Railway/production các biến đã có sẵn trong process.env, nên loader này chỉ
// điền những biến CÒN THIẾU và không bao giờ ghi đè giá trị đã có.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)$/);
      if (!m) continue; // bỏ qua dòng trống và comment (#...)
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) { /* bỏ qua lỗi đọc .env */ }
})();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  maxHttpBufferSize: 4 * 1024 * 1024
});

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error('❌ Thiếu biến môi trường JWT_SECRET. Hãy đặt JWT_SECRET trước khi chạy server.');
  process.exit(1);
}
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

// ─── Game Show (hỏi đáp) ──────────────────────────────────────────────────────
// roomCode → { code, hostSocket, players: Map(socketId→{name,color,score}), currentQuestion }
const gameRooms = new Map();

// Bảng tiền "Ai là triệu phú" VN — 15 mốc, index 0..14 ứng với độ khó 1..15
const MILLIONAIRE_PRIZES = [
  200000, 400000, 600000, 1000000, 2000000,
  3000000, 6000000, 10000000, 14000000, 22000000,
  30000000, 40000000, 60000000, 85000000, 150000000
];
function prizeForDifficulty(d) {
  const i = Math.max(1, Math.min(15, parseInt(d) || 1)) - 1;
  return MILLIONAIRE_PRIZES[i];
}
function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (gameRooms.has(code));
  return code;
}
function roomScoreboard(room) {
  return [...room.players.entries()]
    .map(([sid, p]) => ({ id: sid, name: p.name, color: p.color, score: p.score, isHost: sid === room.hostSocket }))
    .sort((a, b) => b.score - a.score);
}
function broadcastScoreboard(code) {
  const room = gameRooms.get(code);
  if (room) io.to(code).emit('gs_scoreboard', roomScoreboard(room));
}
function normalizeAnswer(s) {
  return String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}
function publicGameQuestion(q) {
  const { correctAnswer, explanation, answered, ...pub } = q;
  return pub;
}
function mistralKey() {
  return process.env.MISTRAL_API_KEY || process.env.MISTRAL_KEY || '';
}
function mistralModelLabel(id) {
  return String(id || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}
function isMistralChatModel(model) {
  const id = String(model?.id || '').toLowerCase();
  if (!id) return false;
  if (/embed|moderation|ocr|audio|voxtral|transcribe|rerank/.test(id)) return false;

  const caps = model?.capabilities || {};
  if (caps.completion_chat === false || caps.chat_completion === false) return false;
  if (caps.completion_chat === true || caps.chat_completion === true) return true;

  return /mistral|ministral|mixtral|magistral|pixtral/.test(id);
}
function formatMistralModel(model) {
  const id = String(model?.id || '').trim();
  return { id, label: mistralModelLabel(id) };
}
function elevenLabsKey() {
  return process.env.ELEVENLABS_API_KEY || process.env.ELEVENLABS_KEY || '';
}
function elevenLabsModel() {
  return process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';
}
function clampTtsText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 2200);
}
const ttsBuckets = new Map();
const ttsCache = new Map();
function allowTtsRequest(req) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const prev = ttsBuckets.get(ip) || [];
  const recent = prev.filter(ts => now - ts < 60_000);
  if (recent.length >= 20) {
    ttsBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  ttsBuckets.set(ip, recent);
  return true;
}
function googleTtsCacheKey(text) {
  return crypto.createHash('sha256').update(`google-translate-tts\nvi\n${text}`).digest('hex');
}
function elevenLabsTtsCacheKey(voiceId, key, text) {
  const keyHash = key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : 'server';
  return crypto.createHash('sha256').update(`${elevenLabsModel()}\n${voiceId}\n${keyHash}\n${text}`).digest('hex');
}
function isFreeElevenLabsVoice(voice) {
  const category = String(voice?.category || '').toLowerCase();
  if (['professional', 'cloned', 'generated'].includes(category)) return false;

  const tiers = Array.isArray(voice?.available_for_tiers) ? voice.available_for_tiers.map(t => String(t).toLowerCase()) : [];
  if (tiers.length && !tiers.includes('free')) return false;

  const sharing = voice?.sharing || {};
  if (sharing && sharing.free_users_allowed === false) return false;
  if (sharing && sharing.status && String(sharing.status).toLowerCase() !== 'enabled') return false;

  return !!voice?.voice_id;
}
function formatElevenLabsVoice(voice) {
  const name = String(voice?.name || 'ElevenLabs voice').trim();
  const category = String(voice?.category || 'premade').trim();
  const accent = voice?.labels?.accent ? `, ${voice.labels.accent}` : '';
  const gender = voice?.labels?.gender ? `${voice.labels.gender}` : category;
  return {
    id: String(voice.voice_id).trim(),
    label: `${name} - ${gender}${accent}`.slice(0, 90)
  };
}
function sendTtsBuffer(res, audio) {
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(audio);
}
function rememberTts(key, audio) {
  ttsCache.set(key, { audio, ts: Date.now() });
  if (ttsCache.size > 80) {
    const oldest = [...ttsCache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 20);
    oldest.forEach(([k]) => ttsCache.delete(k));
  }
}

// Tạo tài khoản owner/admin mặc định nếu chưa tồn tại (chạy ở cả MySQL lẫn JSON).
async function ensureDefaultUsers() {
  const defaultUsers = [
    { id: "owner-001", username: "owner", loginName: "owner", email: null, password: hashPassword("owner123"), role: "owner", color: "#ff00ff", bio: "👑 Owner", badge: "⚡ OWNER", banned: false },
    { id: "admin-001", username: "admin", loginName: "admin", email: null, password: hashPassword("admin123"), role: "admin", color: "#00ffff", bio: "🛡️ Admin", badge: "🛡️ ADMIN", banned: false }
  ];
  let needSave = false;
  for (const def of defaultUsers) {
    if (!users.find(u => u.id === def.id)) {
      users.push(def);
      needSave = true;
    }
  }
  if (needSave) await saveUsers();
}

async function initData() {
  try {
    await initDB();
    dbReady = true;

    // Load users từ MySQL
    const [rows] = await pool.execute('SELECT * FROM users');
    users = rows.map(u => ({...u, banned: !!u.banned}));

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
    console.error('MySQL không khả dụng, dùng lưu trữ JSON cục bộ:', err.message);
    dbReady = false;
    // Fallback JSON
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = []; }
    try { messages = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8')); } catch (e) { messages = []; }
    if (!Array.isArray(users)) users = [];
    if (!Array.isArray(messages)) messages = [];
  }

  // Đảm bảo có owner/admin mặc định ở mọi chế độ lưu trữ
  await ensureDefaultUsers();
  console.log(`Sẵn sàng: ${users.length} users, ${messages.length} messages, ${groups.length} groups (${dbReady ? 'MySQL' : 'JSON'})`);
}

async function saveUsers() {
  if (!dbReady) { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch(e){} return; }
  for (const u of users) {
    await pool.execute(`
      INSERT INTO users (id, email, loginName, username, password, color, bio, role, badge, avatar, cover, socials, msgCount, banned)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        email=VALUES(email), loginName=VALUES(loginName), username=VALUES(username),
        password=VALUES(password), color=VALUES(color), bio=VALUES(bio),
        role=VALUES(role), badge=VALUES(badge), avatar=VALUES(avatar),
        cover=VALUES(cover), socials=VALUES(socials), msgCount=VALUES(msgCount), banned=VALUES(banned)
    `, [u.id, u.email||null, u.loginName||null, u.username, u.password, u.color||'#00f5ff', u.bio||'', u.role||'user', u.badge||'', u.avatar||null, u.cover||null, JSON.stringify(u.socials||{}), u.msgCount||0, u.banned?1:0]);
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
  let socials = {};
  try { socials = typeof u.socials === 'string' ? JSON.parse(u.socials) : (u.socials || {}); } catch(e) {}
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar || null,
    cover: u.cover || null,
    role: u.role,
    color: u.color,
    bio: u.bio || '',
    badge: u.badge || '',
    banned: u.banned || false,
    online: isOnline,
    createdAt: u.createdAt || null,
    socials: socials,
    msgCount: u.msgCount || 0
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
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Trang chủ + các trang chính
app.get('/',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/chat',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/gameshow', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gameshow.html')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'icon-192.png')));

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

app.post('/api/gameshow/google-tts', async (req, res) => {
  if (!allowTtsRequest(req)) return res.status(429).json({ error: 'Đọc giọng nói quá nhanh, hãy thử lại sau ít phút' });

  const text = clampTtsText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Thiếu nội dung cần đọc' });
  const chunks = [];
  for (let i = 0; i < text.length; i += 180) chunks.push(text.slice(i, i + 180));
  const cacheKey = googleTtsCacheKey(text);
  const cached = ttsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60_000) return sendTtsBuffer(res, cached.audio);
  if (cached) ttsCache.delete(cacheKey);

  try {
    const audioParts = [];
    for (const q of chunks) {
      const response = await axios.get('https://translate.google.com/translate_tts', {
        params: { ie: 'UTF-8', tl: 'vi', client: 'tw-ob', q },
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://translate.google.com/'
        },
        responseType: 'arraybuffer',
        timeout: 15000
      });
      audioParts.push(Buffer.from(response.data));
    }
    const audio = Buffer.concat(audioParts);
    rememberTts(cacheKey, audio);
    sendTtsBuffer(res, audio);
  } catch (err) {
    const status = err.response?.status || 502;
    res.status(status >= 400 && status < 500 ? status : 502).json({
      error: 'Không tạo được giọng Google Translate TTS'
    });
  }
});

app.post('/api/gameshow/tts', async (req, res) => {
  const key = String(req.body?.apiKey || elevenLabsKey()).trim();
  if (!key) return res.status(503).json({ error: 'Chưa nhập API key ElevenLabs hoặc cấu hình ELEVENLABS_API_KEY trên server' });
  if (!allowTtsRequest(req)) return res.status(429).json({ error: 'Đọc giọng nói quá nhanh, hãy thử lại sau ít phút' });

  const text = clampTtsText(req.body?.text);
  const voiceId = String(req.body?.voiceId || process.env.ELEVENLABS_VOICE_ID || '').trim();
  if (!text) return res.status(400).json({ error: 'Thiếu nội dung cần đọc' });
  if (!voiceId) return res.status(400).json({ error: 'Thiếu ID giọng nói ElevenLabs' });
  if (!/^[A-Za-z0-9_-]+$/.test(voiceId)) return res.status(400).json({ error: 'ID giọng nói không hợp lệ' });

  const cacheKey = elevenLabsTtsCacheKey(voiceId, key, text);
  const cached = ttsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 10 * 60_000) return sendTtsBuffer(res, cached.audio);
  if (cached) ttsCache.delete(cacheKey);

  try {
    const payload = {
      text,
      model_id: elevenLabsModel(),
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
        style: 0.25,
        use_speaker_boost: true
      }
    };

    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      payload,
      {
        headers: {
          'xi-api-key': key,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );
    const audio = Buffer.from(response.data);
    rememberTts(cacheKey, audio);
    sendTtsBuffer(res, audio);
  } catch (err) {
    const status = err.response?.status || 502;
    let msg = 'Không tạo được giọng đọc ElevenLabs';
    if (err.response?.data) {
      try {
        const body = Buffer.isBuffer(err.response.data)
          ? JSON.parse(err.response.data.toString('utf8'))
          : err.response.data;
        msg = body.detail?.message || body.detail || body.error || msg;
      } catch {}
    } else if (err.message) {
      msg = err.message;
    }
    res.status(status >= 400 && status < 500 ? status : 502).json({ error: String(msg).slice(0, 300) });
  }
});

app.post('/api/gameshow/eleven-voices', async (req, res) => {
  if (!allowTtsRequest(req)) return res.status(429).json({ error: 'Tải danh sách giọng quá nhanh, hãy thử lại sau ít phút' });

  const key = String(req.body?.apiKey || elevenLabsKey()).trim();
  const headers = { 'Accept': 'application/json' };
  if (key) headers['xi-api-key'] = key;

  try {
    const { data } = await axios.get('https://api.elevenlabs.io/v2/voices', {
      params: {
        page_size: 100,
        category: 'premade'
      },
      headers,
      timeout: 15000
    });
    const list = Array.isArray(data?.voices) ? data.voices : [];
    const seen = new Set();
    const voices = list
      .filter(isFreeElevenLabsVoice)
      .map(formatElevenLabsVoice)
      .filter(v => {
        if (!v.id || seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      });
    res.json({ ok: true, voices });
  } catch (err) {
    const status = err.response?.status || 502;
    const msg = err.response?.data?.detail?.message || err.response?.data?.message || err.message || 'Không tải được danh sách giọng ElevenLabs';
    res.status(status >= 400 && status < 500 ? status : 502).json({ error: String(msg).slice(0, 300) });
  }
});

app.post('/api/gameshow/mistral', async (req, res) => {
  const key = String(req.body?.key || mistralKey()).trim();
  if (!key) return res.status(503).json({ error: 'Chưa cấu hình MISTRAL_API_KEY trên server' });
  const prompt = String(req.body?.prompt || '').trim();
  const model = String(req.body?.model || 'mistral-small-latest').trim();
  if (!prompt) return res.status(400).json({ error: 'Thiếu prompt cho Mistral AI' });
  if (!/^[A-Za-z0-9_.:+-]+$/.test(model)) return res.status(400).json({ error: 'Model Mistral không hợp lệ' });
  try {
    const { data } = await axios.post('https://api.mistral.ai/v1/chat/completions', {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 1.0,
      response_format: { type: 'json_object' }
    }, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    const text = data?.choices?.[0]?.message?.content || '';
    res.json({ ok: true, text });
  } catch (err) {
    const status = err.response?.status || 502;
    const msg = err.response?.data?.message || err.response?.data?.error?.message || err.message || 'Không gọi được Mistral AI';
    res.status(status >= 400 && status < 500 ? status : 502).json({ error: String(msg).slice(0, 300) });
  }
});

app.post('/api/gameshow/mistral-models', async (req, res) => {
  const key = String(req.body?.key || mistralKey()).trim();
  if (!key) return res.status(503).json({ error: 'Chưa nhập API key Mistral AI' });

  try {
    const { data } = await axios.get('https://api.mistral.ai/v1/models', {
      headers: {
        'Authorization': `Bearer ${key}`,
        'Accept': 'application/json'
      },
      timeout: 15000
    });
    const list = Array.isArray(data?.data) ? data.data : [];
    const seen = new Set();
    const models = list
      .filter(isMistralChatModel)
      .map(formatMistralModel)
      .filter(m => {
        if (!m.id || seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    res.json({ ok: true, models });
  } catch (err) {
    const status = err.response?.status || 502;
    const msg = err.response?.data?.message || err.response?.data?.error?.message || err.message || 'Không lấy được danh sách model Mistral';
    res.status(status >= 400 && status < 500 ? status : 502).json({ error: String(msg).slice(0, 300) });
  }
});

// Login
app.post('/api/guest', (req, res) => {
  const existing = users.filter(u => u.role === 'guest');
  const nums = existing.map(u => parseInt((u.username || '').replace('Khách ', '')) || 0);
  const nextNum = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  const guestId = 'guest-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const guestUser = {
    id: guestId, username: 'Khách ' + nextNum, loginName: null, email: null,
    password: '', role: 'guest', color: '#aaaaaa', bio: '', badge: '👤 KHÁCH',
    avatar: null, cover: null, socials: {}, msgCount: 0, banned: false,
    createdAt: new Date().toISOString()
  };
  users.push(guestUser);
  broadcastUsers();
  const token = generateToken(guestUser.id);
  res.json({ token, user: publicUser(guestUser) });
});

app.delete('/api/guest/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'guest') return res.status(403).json({ error: 'Not a guest' });
  if (req.user.id !== req.params.id) return res.status(403).json({ error: 'Forbidden' });
  const gid = req.user.id;
  // Xoá khỏi users array
  const idx = users.findIndex(u => u.id === gid);
  if (idx !== -1) users.splice(idx, 1);
  // Xoá messages trong bộ nhớ
  messages = messages.filter(m => m.userId !== gid);
  // Xoá trong MySQL
  if (dbReady) {
    try {
      await pool.execute('DELETE FROM messages WHERE userId = ?', [gid]);
      await pool.execute('DELETE FROM group_messages WHERE userId = ?', [gid]);
      await pool.execute('DELETE FROM group_members WHERE userId = ?', [gid]);
    } catch(e) {}
  }
  broadcastUsers();
  io.emit('messages_reload');
  res.json({ ok: true });
});

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
  const { color, bio, badge, cover, socials, newPassword, currentPassword, newUsername } = req.body || {};

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
  if (cover !== undefined) users[idx].cover = cover || null;
  if (socials !== undefined) users[idx].socials = socials;

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
  if (req.user.role === 'guest') return res.status(403).json({ error: 'Tài khoản khách không thể tạo nhóm' });
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
  const targetUser = users.find(u => u.id === req.body.userId);
  if (targetUser && targetUser.role === 'guest') return res.status(403).json({ error: 'Không thể mời tài khoản khách vào nhóm' });
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
  if (req.user.role === 'guest') return res.status(403).json({ error: 'Tài khoản khách không thể tham gia nhóm' });
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

  socket.on('send_group_message', async ({ groupId, content, token, type, imageData, fileKey, fileUrl, fileName, fileSize, fileMime, fileExpires }) => {
    const payload = verifyToken(token);
    if (!payload) return;
    const user = users.find(u => u.id === payload.userId);
    if (!user || user.banned) return;
    const group = groups.find(g => g.id === groupId);
    if (!group || !group.members.find(m => m.userId === user.id)) return;

    const msgType = ['image','video','file'].includes(type) ? type : 'text';

    if (msgType === 'text') {
      const text = String(content || '').trim();
      if (!text || text.length > 2000) return;
    } else if (msgType === 'image') {
      if (!imageData || !imageData.startsWith('data:image/')) return;
      if (imageData.length > 3 * 1024 * 1024) return;
    } else {
      if (!fileKey) return;
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
      fileKey: fileKey || null,
      fileUrl: fileUrl || null,
      fileName: fileName || null,
      fileSize: fileSize || null,
      fileMime: fileMime || null,
      fileExpires: fileExpires || null,
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

  // ─── Game Show events ──────────────────────────────────────────────────────
  socket.on('gs_create_room', ({ name, color }, cb) => {
    const code = genRoomCode();
    const room = {
      code,
      hostSocket: socket.id,
      players: new Map(),
      currentQuestion: null
    };
    room.players.set(socket.id, {
      name: String(name || 'Quản trò').slice(0, 24),
      color: color || '#00f5ff',
      score: 0
    });
    gameRooms.set(code, room);
    socket.join(code);
    if (typeof cb === 'function') cb({ ok: true, code });
    broadcastScoreboard(code);
  });

  socket.on('gs_join_room', ({ code, name, color }, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = gameRooms.get(code);
    if (!room) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Phòng không tồn tại' });
      return;
    }
    room.players.set(socket.id, {
      name: String(name || 'Người chơi').slice(0, 24),
      color: color || '#bf00ff',
      score: 0
    });
    socket.join(code);
    if (typeof cb === 'function') cb({ ok: true, code, isHost: room.hostSocket === socket.id });
    // Nếu đang có câu hỏi dở, gửi luôn cho người mới (ẩn đáp án)
    if (room.currentQuestion) {
      socket.emit('gs_question', publicGameQuestion(room.currentQuestion));
    }
    broadcastScoreboard(code);
  });

  socket.on('gs_push_question', ({ code, question }) => {
    const room = gameRooms.get(code);
    if (!room || room.hostSocket !== socket.id || !question) return;
    room.currentQuestion = {
      topic: String(question.topic || '').slice(0, 80),
      difficulty: Math.max(1, Math.min(15, parseInt(question.difficulty) || 1)),
      type: question.type === 'essay' ? 'essay' : 'mc',
      content: String(question.content || '').slice(0, 1000),
      options: Array.isArray(question.options) ? question.options.slice(0, 4).map(o => String(o).slice(0, 300)) : [],
      mcEmotion: String(question.mcEmotion || 'neutral').slice(0, 24),
      mcLine: String(question.mcLine || '').slice(0, 500),
      voiceProvider: ['google', 'browser', 'elevenlabs'].includes(question.voiceProvider) ? question.voiceProvider : 'google',
      elevenVoiceId: String(question.elevenVoiceId || '').slice(0, 80),
      voiceSpeed: Math.max(0.75, Math.min(1.35, parseFloat(question.voiceSpeed) || 1)),
      correctAnswer: String(question.correctAnswer || ''),
      explanation: String(question.explanation || '').slice(0, 1000),
      answered: new Set()
    };
    room.currentQuestion.points = prizeForDifficulty(room.currentQuestion.difficulty);
    io.to(code).emit('gs_question', publicGameQuestion(room.currentQuestion));
    broadcastScoreboard(code);
  });

  socket.on('gs_answer', ({ code, answer }, cb) => {
    const room = gameRooms.get(code);
    if (!room || !room.currentQuestion) return;
    const player = room.players.get(socket.id);
    const q = room.currentQuestion;
    if (!player || q.answered.has(socket.id)) {
      if (typeof cb === 'function') cb({ ok: false, error: 'Đã trả lời rồi' });
      return;
    }
    q.answered.add(socket.id);
    let correct;
    if (q.type === 'mc') {
      correct = normalizeAnswer(answer) === normalizeAnswer(q.correctAnswer);
    } else {
      correct = normalizeAnswer(answer) === normalizeAnswer(q.correctAnswer);
    }
    if (correct) player.score += q.points;
    if (typeof cb === 'function') cb({ ok: true, correct, points: correct ? q.points : 0 });
    broadcastScoreboard(code);
  });

  socket.on('gs_reveal', ({ code }) => {
    const room = gameRooms.get(code);
    if (!room || room.hostSocket !== socket.id || !room.currentQuestion) return;
    io.to(code).emit('gs_reveal', {
      correctAnswer: room.currentQuestion.correctAnswer,
      explanation: room.currentQuestion.explanation
    });
  });

  socket.on('gs_leave_room', ({ code }) => {
    leaveGameRoom(socket, code);
  });

  function leaveGameRoom(sock, code) {
    const room = gameRooms.get(code);
    if (!room) return;
    room.players.delete(sock.id);
    sock.leave(code);
    if (room.players.size === 0) {
      gameRooms.delete(code);
      return;
    }
    // Nếu host rời, chuyển quyền host cho người còn lại đầu tiên
    if (room.hostSocket === sock.id) {
      room.hostSocket = room.players.keys().next().value;
      io.to(room.hostSocket).emit('gs_host_granted');
    }
    broadcastScoreboard(code);
  }

  socket.on('disconnect', () => {
    onlineSockets.delete(socket.id);
    // Gỡ khỏi mọi phòng game show đang tham gia
    for (const code of [...gameRooms.keys()]) leaveGameRoom(socket, code);
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
  console.log(`║  👤 User thường: đăng ký bằng email         ║`);
  console.log(`║  🎭 Khách: vào nhanh không cần tài khoản     ║`);
  console.log(`╚${divider}╝\n`);
  console.log(`  Open your browser and go to http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop the server\n`);
});
