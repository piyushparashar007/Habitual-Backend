const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const cors = require('cors');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const DATABASE_URL = process.env.DATABASE_URL;

let db;
let isPostgres = false;
if (DATABASE_URL) {
  const pool = new Pool({ connectionString: DATABASE_URL });
  db = {
    prepare: (sql) => ({
      get: async (...args) => (await pool.query(sql.replace(/\?/g, (m, i, s) => `$${(s.slice(0, i).match(/\?/g) || []).length + 1}`), args)).rows[0],
      all: async (...args) => (await pool.query(sql.replace(/\?/g, (m, i, s) => `$${(s.slice(0, i).match(/\?/g) || []).length + 1}`), args)).rows,
      run: async (...args) => (await pool.query(sql.replace(/\?/g, (m, i, s) => `$${(s.slice(0, i).match(/\?/g) || []).length + 1}`), args))
    }),
    exec: (sql) => pool.query(sql)
  };
  isPostgres = true;
  console.log('Users Service: Using Postgres (RDS)');
} else {
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbFile = path.join(DATA_DIR, 'users.db');
  const sqliteDb = new Database(dbFile);
  db = {
    prepare: (sql) => ({
      get: (...args) => Promise.resolve(sqliteDb.prepare(sql).get(...args)),
      all: (...args) => Promise.resolve(sqliteDb.prepare(sql).all(...args)),
      run: (...args) => Promise.resolve(sqliteDb.prepare(sql).run(...args))
    }),
    exec: (sql) => Promise.resolve(sqliteDb.exec(sql))
  };
  console.log('Users Service: Using SQLite');
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// init schema
const initPath = path.join(__dirname, 'init_db.sql');
(async () => {
  if (fs.existsSync(initPath)) {
    let initSql = fs.readFileSync(initPath, 'utf8');
    if (isPostgres) {
      initSql = initSql.replace(/TEXT DEFAULT \(datetime\('now'\)\)/gi, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
      initSql = initSql.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
    }
    await db.exec(initSql);
  }
})();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(morgan('tiny'));
app.use(cors());
app.use('/uploads', express.static(UPLOADS_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage });

function createToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function userPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    bio: row.bio,
    timezone: row.timezone,
    reminderTime: row.reminder_time,
    preferredCategories: row.preferred_categories ? JSON.parse(row.preferred_categories) : [],
    avatar: row.avatar,
    created_at: row.created_at
  };
}

function saveDataUrlToFile(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No dataUrl provided');
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw new Error('Invalid data URL format');
  const base64 = m[3].replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  const fname = `${uuidv4()}.${m[2].toLowerCase() === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fname), buffer);
  return `/uploads/${fname}`;
}

app.post('/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const id = uuidv4();
  try {
    const hash = await bcrypt.hash(password, 10);
    await db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)').run(id, email, hash, name || '');
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const token = createToken(row);
    return res.json({ token, user: userPublic(row) });
  } catch (e) {
    if (String(e).toLowerCase().includes('unique')) return res.status(400).json({ error: 'email exists' });
    return res.status(500).json({ error: 'db error' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  try {
    const row = await db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = createToken(row);
    return res.json({ token, user: userPublic(row) });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
});

app.post('/account/update', upload.single('avatar'), async (req, res) => {
  try {
    let body = req.is('multipart/form-data') ? (req.body || {}) : (req.body || {});
    if (req.file) body.avatar = `/uploads/${req.file.filename}`;
    if (body.avatarBase64) {
      try { body.avatar = saveDataUrlToFile(body.avatarBase64); } catch (e) {}
    }
    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'user not found' });
    const upd = {
      name: body.name ?? row.name,
      email: body.email ?? row.email,
      bio: body.bio ?? row.bio,
      timezone: body.timezone ?? row.timezone,
      reminder_time: body.reminderTime ?? row.reminder_time,
      preferred_categories: Array.isArray(body.preferredCategories) ? JSON.stringify(body.preferredCategories) : (body.preferredCategories ?? row.preferred_categories),
      avatar: body.avatar ?? row.avatar
    };
    if (body.password) {
      const hash = await bcrypt.hash(body.password, 10);
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    }
    await db.prepare('UPDATE users SET name=?,email=?,bio=?,timezone=?,reminder_time=?,preferred_categories=?,avatar=? WHERE id=?')
      .run(upd.name, upd.email, upd.bio, upd.timezone, upd.reminder_time, upd.preferred_categories, upd.avatar, id);
    const updated = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return res.json({ user: userPublic(updated) });
  } catch (e) {
    return res.status(500).json({ error: 'failed' });
  }
});

app.get('/account/:id', async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    return res.json({ user: userPublic(row) });
  } catch (e) {
    return res.status(500).json({ error: 'failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`users-service listening on ${PORT}`));
