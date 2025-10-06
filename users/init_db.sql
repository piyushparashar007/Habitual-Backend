CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  bio TEXT,
  timezone TEXT,
  reminder_time TEXT,
  preferred_categories TEXT,
  avatar TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
