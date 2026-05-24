const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
const DATABASE_URL = process.env.DATABASE_URL;

let amqpChannel = null;
async function connectRabbitMQ() {
  try {
    const conn = await amqp.connect(RABBITMQ_URL);
    amqpChannel = await conn.createChannel();
    await amqpChannel.assertExchange('activity_events', 'fanout', { durable: false });
    console.log('Connected to RabbitMQ');
  } catch (err) {
    console.error('RabbitMQ connection failed, retrying in 5s...', err.message);
    setTimeout(connectRabbitMQ, 5000);
  }
}
connectRabbitMQ();

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
  console.log('Activities Service: Using Postgres (RDS)');
} else {
  const DATA_DIR = path.join(__dirname, 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
  const dbFile = path.join(DATA_DIR, 'activities.db');
  const sqliteDb = new Database(dbFile);
  db = {
    prepare: (sql) => ({
      get: (...args) => Promise.resolve(sqliteDb.prepare(sql).get(...args)),
      all: (...args) => Promise.resolve(sqliteDb.prepare(sql).all(...args)),
      run: (...args) => Promise.resolve(sqliteDb.prepare(sql).run(...args))
    }),
    exec: (sql) => Promise.resolve(sqliteDb.exec(sql))
  };
  console.log('Activities Service: Using SQLite');
}

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
app.use(bodyParser.json({ limit: '10mb' }));
app.use(morgan('tiny'));
app.use(cors());

function authOptional(req, res, next) {
  const a = req.headers.authorization;
  if (!a) { req.user = null; return next(); }
  const parts = a.split(' ');
  if (parts.length !== 2) { req.user = null; return next(); }
  const token = parts[1];
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.user = p;
  } catch (e) { req.user = null; }
  next();
}
app.use(authOptional);

app.get('/activities', async (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const rows = await db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY created_at DESC').all(uid);
  res.json(rows);
});

app.post('/activities', async (req, res) => {
  const uid = req.user?.id || req.body.user_id || 'u1';
  const id = uuidv4();
  const { title, notes, frequency, category } = req.body;
  await db.prepare('INSERT INTO activities (id,user_id,title,notes,frequency,category) VALUES (?,?,?,?,?,?)')
    .run(id, uid, title || 'Untitled', notes || '', frequency || 'daily', category || '');
  res.json({ id, title, notes, frequency, category, user_id: uid });
});

app.get('/activities/:id', async (req, res) => {
  const row = await db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.put('/activities/:id', async (req, res) => {
  const id = req.params.id;
  const a = req.body;
  await db.prepare('UPDATE activities SET title=?,notes=?,frequency=?,category=? WHERE id=?')
    .run(a.title, a.notes, a.frequency, a.category, id);
  res.json({ ok: true });
});

app.delete('/activities/:id', async (req, res) => {
  await db.prepare('DELETE FROM activities WHERE id = ?').run(req.params.id);
  await db.prepare('DELETE FROM logs WHERE activity_id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/activities/:id/log', async (req, res) => {
  const aid = req.params.id;
  const uid = req.user?.id || req.body.user_id || 'u1';
  const date = req.body.date || (new Date()).toISOString().slice(0,10);
  const status = req.body.status || 'done';
  const id = uuidv4();
  await db.prepare('INSERT INTO logs (id,activity_id,user_id,date,status) VALUES (?,?,?,?,?)')
    .run(id, aid, uid, date, status);
  
  if (amqpChannel) {
    const eventMsg = JSON.stringify({ 
      event: 'ACTIVITY_LOGGED', 
      payload: { id, activity_id: aid, user_id: uid, date, status, created_at: new Date().toISOString() } 
    });
    amqpChannel.publish('activity_events', '', Buffer.from(eventMsg));
  }
  res.json({ id, activity_id: aid, user_id: uid, date, status });
});

app.get('/logs', async (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const rows = await db.prepare('SELECT * FROM logs WHERE user_id = ? ORDER BY date DESC LIMIT 200').all(uid);
  res.json(rows);
});

app.get('/activities/:id/logs', async (req, res) => {
  const aid = req.params.id;
  const rows = await db.prepare('SELECT * FROM logs WHERE activity_id = ? ORDER BY date DESC').all(aid);
  res.json(rows);
});

app.get('/due', async (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const activities = await db.prepare('SELECT * FROM activities WHERE user_id = ?').all(uid);
  const result = [];
  for (const a of activities) {
    let due = true;
    if (a.frequency === 'weekly') {
      const rows = await db.prepare('SELECT 1 FROM logs WHERE activity_id = ? AND date >= ? LIMIT 1')
        .all(a.id, lastNDaysDate(7));
      due = rows.length === 0;
    } else if (a.frequency === '3xweek') {
      const cntRow = await db.prepare("SELECT count(*) as c FROM logs WHERE activity_id = ? AND date >= ?").get(a.id, lastNDaysDate(7));
      due = (cntRow.c || 0) < 3;
    }
    if (due) result.push(a);
  }
  res.json(result);
});

app.get('/analytics/:userId', async (req, res) => {
  const uid = req.params.userId;
  const activities = await db.prepare('SELECT * FROM activities WHERE user_id = ?').all(uid);
  const perActivity = [];
  for (const a of activities) {
    const totalRow = await db.prepare('SELECT COUNT(*) as c FROM logs WHERE activity_id = ?').get(a.id);
    const doneRow = await db.prepare("SELECT COUNT(*) as c FROM logs WHERE activity_id = ? AND status = 'done'").get(a.id);
    const streak = await computeStreak(a.id);
    const total = totalRow.c || 0;
    const doneCount = doneRow.c || 0;
    perActivity.push({
      activity: { id: a.id, title: a.title, category: a.category },
      doneCount,
      total,
      consistency: total === 0 ? 0 : Math.round((doneCount / total) * 100),
      streak
    });
  }
  const mostMissed = perActivity.slice().sort((a,b) => (b.total - b.doneCount) - (a.total - a.doneCount)).slice(0,5);
  const mostConsistent = perActivity.slice().sort((a,b) => b.consistency - a.consistency).slice(0,5);
  res.json({ totals: { activities: activities.length }, perActivity, mostMissed, mostConsistent });
});

function lastNDaysDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n-1));
  return d.toISOString().slice(0,10);
}

async function computeStreak(activityId) {
  let streak = 0;
  let day = new Date();
  for (let i=0;i<365;i++) {
    const iso = day.toISOString().slice(0,10);
    const row = await db.prepare("SELECT 1 FROM logs WHERE activity_id = ? AND date = ? AND status = 'done' LIMIT 1").get(activityId, iso);
    if (row) {
      streak++;
      day.setDate(day.getDate() - 1);
    } else break;
  }
  return streak;
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`activities-service listening on ${PORT}`));
