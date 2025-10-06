// (same top imports)
const express = require('express');
const bodyParser = require('body-parser');
const morgan = require('morgan');
const cors = require('cors');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3003;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret';
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const dbFile = path.join(DATA_DIR, 'activities.db');
const db = new Database(dbFile);

const initSql = fs.readFileSync(path.join(__dirname, 'init_db.sql'), 'utf8');
db.exec(initSql);

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

// Activities CRUD
app.get('/activities', (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const rows = db.prepare('SELECT * FROM activities WHERE user_id = ? ORDER BY created_at DESC').all(uid);
  res.json(rows);
});

app.post('/activities', (req, res) => {
  const uid = req.user?.id || req.body.user_id || 'u1';
  const id = uuidv4();
  const { title, notes, frequency, category } = req.body;
  db.prepare('INSERT INTO activities (id,user_id,title,notes,frequency,category) VALUES (?,?,?,?,?,?)')
    .run(id, uid, title || 'Untitled', notes || '', frequency || 'daily', category || '');
  res.json({ id, title, notes, frequency, category, user_id: uid });
});

app.get('/activities/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM activities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.put('/activities/:id', (req, res) => {
  const id = req.params.id;
  const a = req.body;
  db.prepare('UPDATE activities SET title=?,notes=?,frequency=?,category=? WHERE id=?')
    .run(a.title, a.notes, a.frequency, a.category, id);
  res.json({ ok: true });
});

app.delete('/activities/:id', (req, res) => {
  db.prepare('DELETE FROM activities WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM logs WHERE activity_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Activity logs
app.post('/activities/:id/log', (req, res) => {
  const aid = req.params.id;
  const uid = req.user?.id || req.body.user_id || 'u1';
  const date = req.body.date || (new Date()).toISOString().slice(0,10);
  const status = req.body.status || 'done';
  const id = uuidv4();
  db.prepare('INSERT INTO logs (id,activity_id,user_id,date,status) VALUES (?,?,?,?,?)')
    .run(id, aid, uid, date, status);
  res.json({ id, activity_id: aid, user_id: uid, date, status });
});

// get recent logs or logs for activity
app.get('/logs', (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const rows = db.prepare('SELECT * FROM logs WHERE user_id = ? ORDER BY date DESC LIMIT 200').all(uid);
  res.json(rows);
});

app.get('/activities/:id/logs', (req, res) => {
  const aid = req.params.id;
  const rows = db.prepare('SELECT * FROM logs WHERE activity_id = ? ORDER BY date DESC').all(aid);
  res.json(rows);
});

// due today endpoint
app.get('/due', (req, res) => {
  const uid = req.user?.id || req.query.user_id || 'u1';
  const activities = db.prepare('SELECT * FROM activities WHERE user_id = ?').all(uid);

  const result = activities.filter(a => {
    if (!a.frequency || a.frequency === 'daily') return true;
    if (a.frequency === 'weekly') {
      const rows = db.prepare('SELECT 1 FROM logs WHERE activity_id = ? AND date >= ? LIMIT 1')
        .all(a.id, lastNDaysDate(7));
      return rows.length === 0;
    }
    if (a.frequency === '3xweek') {
      const cnt = db.prepare("SELECT count(*) as c FROM logs WHERE activity_id = ? AND date >= ?").get(a.id, lastNDaysDate(7)).c;
      return cnt < 3;
    }
    return true;
  });

  res.json(result);
});

// analytics endpoint
app.get('/analytics/:userId', (req, res) => {
  const uid = req.params.userId;
  const activities = db.prepare('SELECT * FROM activities WHERE user_id = ?').all(uid);

  const perActivity = activities.map(a => {
    const total = db.prepare('SELECT COUNT(*) as c FROM logs WHERE activity_id = ?').get(a.id).c || 0;
    const doneCount = db.prepare("SELECT COUNT(*) as c FROM logs WHERE activity_id = ? AND status = 'done'").get(a.id).c || 0;
    const missedCount = db.prepare("SELECT COUNT(*) as c FROM logs WHERE activity_id = ? AND status = 'missed'").get(a.id).c || 0;
    const streak = computeStreak(a.id);
    const consistency = total === 0 ? 0 : Math.round((doneCount / total) * 100);
    return {
      activity: { id: a.id, title: a.title, category: a.category },
      doneCount,
      total,
      missedCount,
      consistency,
      streak
    };
  });

  const mostMissed = perActivity.map(p => ({ ...p, total: p.total })).sort((a,b) => (b.total - b.doneCount) - (a.total - a.doneCount)).slice(0,5);
  const mostConsistent = perActivity.slice().sort((a,b) => b.consistency - a.consistency).slice(0,5);

  res.json({
    totals: { activities: activities.length },
    perActivity,
    mostMissed,
    mostConsistent,
    payload: {}
  });
});

function lastNDaysDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n-1));
  return d.toISOString().slice(0,10);
}

function computeStreak(activityId) {
  let streak = 0;
  let day = new Date();
  for (let i=0;i<365;i++) {
    const iso = day.toISOString().slice(0,10);
    const row = db.prepare("SELECT 1 FROM logs WHERE activity_id = ? AND date = ? AND status = 'done' LIMIT 1").get(activityId, iso);
    if (row) {
      streak++;
      day.setDate(day.getDate() - 1);
    } else break;
  }
  return streak;
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`activities-service listening on ${PORT}`));
