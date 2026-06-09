# ⚡ NEON CHAT

Ứng dụng chat real-time với giao diện Cyberpunk Neon.
Chạy được trên Termux Android và mọi thiết bị có Node.js.

---

## 📱 Cài đặt trên Termux (Android)

### Bước 1: Cài Termux
Tải Termux từ F-Droid (khuyến nghị) hoặc Google Play.

### Bước 2: Cài Node.js
```bash
pkg update && pkg upgrade -y
pkg install nodejs -y
```

### Bước 3: Tạo thư mục và copy files
```bash
mkdir ~/neon-chat
cd ~/neon-chat
```
Copy toàn bộ thư mục `neon-chat` vào Termux.

Hoặc dùng nano để tạo từng file.

### Bước 4: Cài dependencies
```bash
cd ~/neon-chat
npm install
```

### Bước 5: Chạy server
```bash
node server.js
```

### Bước 6: Mở chat
Mở trình duyệt trên điện thoại và vào:
```
http://localhost:3000
```

---

## 🌐 Kết nối từ thiết bị khác (cùng WiFi)

1. Kiểm tra IP của Android:
```bash
ip addr show wlan0 | grep "inet "
```
Hoặc: Cài đặt → WiFi → Thông tin mạng → IP

2. Truy cập từ thiết bị khác:
```
http://[IP_CỦA_ANDROID]:3000
```

---

## 👥 Tài khoản mặc định

| Username | Mật khẩu | Vai trò |
|----------|-----------|---------|
| owner    | owner123  | 👑 Owner |
| admin    | admin123  | 🛡️ Admin |
| user1    | user1     | 👤 User |
| user2    | user2     | 👤 User |

---

## ✨ Tính năng

### 🗨️ Chat
- Nhắn tin real-time
- Hỗ trợ link URL tự động
- Indicator "đang nhập"
- Lưu lịch sử 500 tin nhắn

### 👤 Tài khoản
- Đăng ký / Đăng nhập
- Tùy chỉnh màu tên
- Thêm bio (tiểu sử)
- Đổi mật khẩu
- Badge tùy chỉnh (Owner)

### 🛡️ Admin
- Xem danh sách người dùng
- Ban / Unban người dùng
- Xóa tin nhắn bất kỳ

### 👑 Owner
- Tất cả quyền Admin
- Thêm / Hạ cấp Admin
- Xóa tài khoản
- Badge tùy chỉnh

---

## 📁 Cấu trúc

```
neon-chat/
├── server.js        ← Backend (Node.js + Socket.io)
├── package.json     ← Dependencies
├── data/
│   ├── users.json   ← Dữ liệu người dùng (tự tạo)
│   └── messages.json← Lịch sử tin nhắn (tự tạo)
└── public/
    └── index.html   ← Giao diện web
```

---

## 🔧 Tuỳ chỉnh

### Đổi port
```bash
PORT=8080 node server.js
```

### Chạy background trên Termux
```bash
nohup node server.js > neon-chat.log 2>&1 &
```

Để dừng:
```bash
kill $(cat neon-chat.pid)
# hoặc
pkill -f "node server.js"
```

---

## ⚠️ Lưu ý
- Data lưu trong `data/` — backup thư mục này nếu cần
- Mật khẩu được mã hóa HMAC-SHA256
- Token tự hết hạn khi restart server → cần đăng nhập lại

---

Made with ⚡ for Termux Android
# Neon-Chat
