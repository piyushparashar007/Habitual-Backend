// index.js (users service)
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

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const dbFile = path.join(DATA_DIR, 'users.db');
const db = new Database(dbFile);

// init schema if exists
const initPath = path.join(__dirname, 'init_db.sql');
if (fs.existsSync(initPath)) {
  const initSql = fs.readFileSync(initPath, 'utf8');
  db.exec(initSql);
} else {
  // Minimal schema fallback if init file missing (safe default)
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      password_hash TEXT,
      name TEXT,
      bio TEXT,
      timezone TEXT,
      reminder_time TEXT,
      preferred_categories TEXT,
      avatar TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

const app = express();

// Allow larger JSON bodies so base64 uploads can be sent in JSON as avatarBase64
app.use(express.json({ limit: '5mb' })); // adjust limit as needed
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(morgan('tiny'));
app.use(cors());

// serve uploads
app.use('/uploads', express.static(UPLOADS_DIR));

// multer for form uploads (multipart)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = uuidv4();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${id}${ext}`);
  }
});
const upload = multer({ storage });

// helpers
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

// save a dataURL (data:image/...) as a file in uploads and return the URL path
function saveDataUrlToFile(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') throw new Error('No dataUrl provided');
  // match data:[mime];base64,[data]
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!m) throw new Error('Invalid data URL format');
  const mime = m[1].toLowerCase();
  const ext = m[2].toLowerCase() === 'png' ? 'png' : 'jpg';
  const base64 = m[3].replace(/\s+/g, ''); // strip whitespace
  const buffer = Buffer.from(base64, 'base64');
  // ensure reasonable size
  if (buffer.length > 1024 * 1024 * 3) { // >3MB
    throw new Error('Image too large');
  }
  const fname = `${uuidv4()}.${ext}`;
  const dst = path.join(UPLOADS_DIR, fname);
  fs.writeFileSync(dst, buffer);
  return `/uploads/${fname}`;
}

// Signup
app.post('/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  const id = uuidv4();
  try {
    const hash = await bcrypt.hash(password, 10);
    const stmt = db.prepare('INSERT INTO users (id,email,password_hash,name) VALUES (?,?,?,?)');
    stmt.run(id, email, hash, name || '');
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    const token = createToken(row);
    return res.json({ token, user: userPublic(row) });
  } catch (e) {
    if (String(e).toLowerCase().includes('unique')) return res.status(400).json({ error: 'email exists' });
    console.error('signup err', e);
    return res.status(500).json({ error: 'db error' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email & password required' });
  try {
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!row) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(password, row.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = createToken(row);
    return res.json({ token, user: userPublic(row) });
  } catch (e) {
    console.error('login err', e);
    return res.status(500).json({ error: 'server error' });
  }
});

/**
 * Account update endpoint
 * Accepts:
 *  - JSON body with fields and optional `avatarBase64` (data url)
 *  - OR multipart/form-data with file field `avatar` (multer will place file)
 *
 * Returns updated user object { user: {...} }
 */
app.post('/account/update', upload.single('avatar'), async (req, res) => {
  try {
    // If multipart upload occurred, multer put req.file; else we expect JSON
    let body = {};
    if (req.is('multipart/form-data')) {
      // multer has parsed form fields into req.body, file in req.file
      body = req.body || {};
      if (req.file) {
        // file saved by multer
        body.avatar = `/uploads/${req.file.filename}`;
      }
    } else {
      body = req.body || {};
    }

    // If avatarBase64 provided in JSON, prefer it (decode & save)
    if (body.avatarBase64 && typeof body.avatarBase64 === 'string') {
      try {
        const avatarUrl = saveDataUrlToFile(body.avatarBase64);
        body.avatar = avatarUrl;
      } catch (e) {
        console.warn('avatarBase64 save failed:', e.message);
        // do not abort whole request; continue without avatar
      }
    }

    // normalize preferredCategories if string
    if (body.preferredCategories && typeof body.preferredCategories === 'string') {
      try {
        body.preferredCategories = JSON.parse(body.preferredCategories);
      } catch (e) {
        // leave as-is
      }
    }

    const id = body.id;
    if (!id) return res.status(400).json({ error: 'id is required' });

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'user not found' });

    // Build updated values (keep previous if not provided)
    const upd = {
      name: body.name ?? row.name,
      email: body.email ?? row.email,
      bio: body.bio ?? row.bio,
      timezone: body.timezone ?? row.timezone,
      reminder_time: body.reminderTime ?? row.reminder_time,
      preferred_categories: Array.isArray(body.preferredCategories) ? JSON.stringify(body.preferredCategories) : (body.preferredCategories ?? row.preferred_categories),
      avatar: body.avatar ?? row.avatar
    };

    // If password change requested
    if (body.password && typeof body.password === 'string' && body.password.length > 0) {
      const hash = await bcrypt.hash(body.password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    }

    db.prepare('UPDATE users SET name=?,email=?,bio=?,timezone=?,reminder_time=?,preferred_categories=?,avatar=? WHERE id=?')
      .run(upd.name, upd.email, upd.bio, upd.timezone, upd.reminder_time, upd.preferred_categories, upd.avatar, id);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    return res.json({ user: userPublic(updated) });
  } catch (e) {
    console.error('account/update err', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// Account delete
app.post('/account/delete', (req, res) => {
  const id = req.body?.id;
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return res.json({ ok: true });
  } catch (e) {
    console.error('account/delete err', e);
    return res.status(500).json({ error: 'failed' });
  }
});

// Get user
app.get('/account/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    return res.json({ user: userPublic(row) });
  } catch (e) {
    console.error('account/get err', e);
    return res.status(500).json({ error: 'failed' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`users-service listening on ${PORT}`));
