# ⚡ NEON CHAT

Ứng dụng chat real-time với giao diện Cyberpunk Neon, chạy hoàn toàn trên **Cloudflare Workers**.

- **Runtime:** Cloudflare Workers (`src/worker.js`)
- **Real-time & lưu trữ:** Durable Object `NeonChatRoom` (WebSocket + SQLite tích hợp)
- **Tệp tin:** Backblaze B2 (qua API, cấu hình bằng secrets)
- **Giao diện tĩnh:** thư mục `public/` (phục vụ qua Assets binding)

> Bản Node.js/Express + MySQL (`server.js`) đã được gỡ bỏ. Dự án giờ chỉ còn một backend duy nhất là Worker.

---

## 🚀 Phát triển & Triển khai

Yêu cầu: Node.js ≥ 18 và đã đăng nhập Cloudflare (`npx wrangler login`).

```bash
npm install          # cài wrangler

npm run dev          # chạy thử cục bộ (wrangler dev)
npm run cf:dry-run   # kiểm tra build không publish
npm run deploy       # triển khai lên Cloudflare
npm run cf:tail      # xem log real-time
```

Cấu hình domain/binding nằm trong `wrangler.toml`.

### Secrets cần thiết (đặt bằng `npx wrangler secret put <TÊN>`)
| Secret | Mục đích |
|--------|----------|
| `JWT_SECRET` | Ký/verify token đăng nhập (HMAC-SHA256) |
| `B2_KEY_ID`, `B2_APP_KEY`, `B2_BUCKET_NAME` | Lưu trữ tệp trên Backblaze B2 |
| `ELEVENLABS_API_KEY`, `MISTRAL_API_KEY` | (tuỳ chọn) tính năng gameshow TTS / AI |
| `RAILWAY_TOOL_URL` | Origin HTTPS của service trong `railway-setup/` |
| `RAILWAY_TOOL_TOKEN` | Phải trùng với `TOOL_SHARED_SECRET` trên Railway |

### KGVN Online Tool

Trang `/chạytool.html` gửi file tới `/api/tool/jobs`. Worker chuyển tiếp body
multipart dạng stream sang Railway và tự gắn token bí mật. Railway trả job ID,
sau đó trình duyệt polling `/api/tool/jobs/{id}` đến khi thành công hoặc lỗi.

Hướng dẫn cấu hình Railway và secrets Cloudflare nằm tại
[`railway-setup/README.md`](railway-setup/README.md).

---

## 👥 Tài khoản mặc định

Được tạo tự động lần đầu khởi tạo Durable Object:

| Đăng nhập | Mật khẩu | Vai trò |
|-----------|----------|---------|
| owner     | owner123 | 👑 Owner |
| admin     | admin123 | 🛡️ Admin |

---

## ✨ Tính năng

### 🗨️ Chat
- Nhắn tin real-time qua WebSocket (`/ws`)
- Kênh chung + nhóm chat riêng
- Gửi ảnh / video / tệp tin (Backblaze B2)
- Indicator "đang nhập"

### 👤 Tài khoản
- Đăng ký / Đăng nhập / Khách
- Tùy chỉnh màu tên, avatar, ảnh bìa, bio, mạng xã hội

### 🛡️ Trang quản trị (`neon_chat_admin_dashboard.html`)
- Đồng bộ tài khoản đã đăng nhập từ trang chat
- Tổng quan số liệu thật (người dùng, online, tin nhắn, nhóm, bị ban)
- Quản lý người dùng: ban/unban, đổi vai trò, reset mật khẩu, xóa
- Kiểm duyệt & xóa tin nhắn kênh chung
- Quản lý & giải tán nhóm chat

---

## 📁 Cấu trúc

```
neon-chat/
├── src/
│   └── worker.js     ← Backend Worker + Durable Object NeonChatRoom
├── wrangler.toml     ← Cấu hình Cloudflare (binding, domain, vars)
├── package.json
├── scripts/
│   └── import-cloudflare-data.js  ← Nhập dữ liệu từ data/*.json vào Worker
└── public/
    ├── index.html                     ← Giao diện chat
    ├── neon_chat_admin_dashboard.html ← Bảng điều khiển quản trị
    └── ...                            ← Trang & tài nguyên tĩnh khác
```

---

## 📦 Nhập dữ liệu (tuỳ chọn)

Đặt `users.json`, `messages.json`, `groups.json` trong thư mục `data/`, rồi:

```bash
npm run cf:import -- https://your-site.workers.dev OWNER_TOKEN
```

Script gọi endpoint `POST /api/admin/import-json` (chỉ Owner) trên Worker.

---

Made with ⚡ on Cloudflare Workers
# tool
# tool
# tool
# tool
