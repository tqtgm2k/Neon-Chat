const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: process.env.MYSQLPORT,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  database: process.env.MYSQLDATABASE,
  waitForConnections: true,
  connectionLimit: 10
});

async function initDB() {
  const conn = await pool.getConnection();
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      email VARCHAR(255) UNIQUE,
      username VARCHAR(32) NOT NULL,
      password VARCHAR(255) NOT NULL,
      color VARCHAR(7) DEFAULT '#00f5ff',
      bio VARCHAR(100) DEFAULT '',
      role ENUM('user','admin','owner') DEFAULT 'user',
      badge VARCHAR(20) DEFAULT '',
      banned TINYINT(1) DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Thêm cột email nếu chưa có (migration)
  try {
    await conn.execute('ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE AFTER id');
  } catch(e) {}
  // Thêm cột avatar nếu chưa có
  try {
    await conn.execute('ALTER TABLE users ADD COLUMN avatar MEDIUMTEXT AFTER badge');
  } catch(e) {}
  // Thêm cột file fields nếu chưa có
  try {
    await conn.execute('ALTER TABLE messages ADD COLUMN fileKey VARCHAR(255) AFTER imageData');
    await conn.execute('ALTER TABLE messages ADD COLUMN fileName VARCHAR(255) AFTER fileKey');
    await conn.execute('ALTER TABLE messages ADD COLUMN fileSize BIGINT AFTER fileName');
    await conn.execute('ALTER TABLE messages ADD COLUMN fileMime VARCHAR(100) AFTER fileSize');
    await conn.execute('ALTER TABLE messages ADD COLUMN fileExpires DATETIME AFTER fileMime');
  } catch(e) {}
  try {
    await conn.execute('ALTER TABLE group_messages ADD COLUMN fileKey VARCHAR(255) AFTER imageData');
    await conn.execute('ALTER TABLE group_messages ADD COLUMN fileName VARCHAR(255) AFTER fileKey');
    await conn.execute('ALTER TABLE group_messages ADD COLUMN fileSize BIGINT AFTER fileName');
    await conn.execute('ALTER TABLE group_messages ADD COLUMN fileMime VARCHAR(100) AFTER fileSize');
    await conn.execute('ALTER TABLE group_messages ADD COLUMN fileExpires DATETIME AFTER fileMime');
  } catch(e) {}

  // Thêm cột loginName nếu chưa có
  try {
    await conn.execute("ALTER TABLE users ADD COLUMN loginName VARCHAR(32) AFTER email");
    await conn.execute("UPDATE users SET loginName = 'owner' WHERE id = 'owner-001'");
    await conn.execute("UPDATE users SET loginName = 'admin' WHERE id = 'admin-001'");
  } catch(e) {}
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(64) PRIMARY KEY,
      userId VARCHAR(64) NOT NULL,
      username VARCHAR(16) NOT NULL,
      color VARCHAR(7) DEFAULT '#00f5ff',
      role VARCHAR(10) DEFAULT 'user',
      badge VARCHAR(20) DEFAULT '',
      type VARCHAR(10) DEFAULT 'text',
      content TEXT,
      imageData MEDIUMTEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS groups_chat (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(50) NOT NULL,
      createdBy VARCHAR(64) NOT NULL,
      avatar MEDIUMTEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Migration: đổi cột avatar thành MEDIUMTEXT nếu chưa
  try {
    await conn.execute('ALTER TABLE groups_chat MODIFY COLUMN avatar MEDIUMTEXT');
  } catch(e) {}
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS group_members (
      groupId VARCHAR(64) NOT NULL,
      userId VARCHAR(64) NOT NULL,
      role ENUM('admin','member') DEFAULT 'member',
      joinedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (groupId, userId)
    )
  `);
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS group_messages (
      id VARCHAR(64) PRIMARY KEY,
      groupId VARCHAR(64) NOT NULL,
      userId VARCHAR(64) NOT NULL,
      username VARCHAR(32) NOT NULL,
      color VARCHAR(7) DEFAULT '#00f5ff',
      role VARCHAR(10) DEFAULT 'user',
      badge VARCHAR(20) DEFAULT '',
      type VARCHAR(10) DEFAULT 'text',
      content TEXT,
      imageData MEDIUMTEXT,
      avatar MEDIUMTEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_group (groupId),
      INDEX idx_time (timestamp)
    )
  `);

  conn.release();
  console.log('MySQL connected & tables ready');
}

module.exports = { pool, initDB };
