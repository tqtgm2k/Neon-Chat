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
  } catch(e) {} // Bỏ qua nếu đã có
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
  conn.release();
  console.log('MySQL connected & tables ready');
}

module.exports = { pool, initDB };
