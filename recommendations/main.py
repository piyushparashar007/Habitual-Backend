import os
import json
import threading
import pika
import time
import sqlite3
import uuid
import psycopg2
from datetime import datetime
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
DATABASE_URL = os.getenv("DATABASE_URL")
DB_DIR = "/app/data"
os.makedirs(DB_DIR, exist_ok=True)
DB_FILE = os.path.join(DB_DIR, "recommendations.db")

def get_db_conn():
    if DATABASE_URL:
        return psycopg2.connect(DATABASE_URL)
    return sqlite3.connect(DB_FILE)

def init_db():
    conn = get_db_conn()
    cursor = conn.cursor()
    if DATABASE_URL:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS activity_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                activity_id TEXT,
                date TEXT,
                status TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS recommendations (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                activity_id TEXT,
                suggestion TEXT,
                type TEXT,
                accepted BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')
    else:
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS activity_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                activity_id TEXT,
                date TEXT,
                status TEXT,
                created_at TEXT
            )
        ''')
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS recommendations (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                activity_id TEXT,
                suggestion TEXT,
                type TEXT,
                accepted BOOLEAN DEFAULT 0,
                created_at TEXT
            )
        ''')
    conn.commit()
    conn.close()

init_db()

class ComputeRequest(BaseModel):
    user_id: str
    activity_id: str

class AcceptRequest(BaseModel):
    user_id: str
    recommendation_id: str
    accepted: bool

def rabbitmq_consumer():
    while True:
        try:
            params = pika.URLParameters(RABBITMQ_URL)
            connection = pika.BlockingConnection(params)
            channel = connection.channel()
            channel.exchange_declare(exchange='activity_events', exchange_type='fanout')
            result = channel.queue_declare(queue='', exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange='activity_events', queue=queue_name)

            def callback(ch, method, properties, body):
                try:
                    data = json.loads(body)
                    if data.get("event") == "ACTIVITY_LOGGED":
                        payload = data["payload"]
                        conn = get_db_conn()
                        cursor = conn.cursor()
                        created_at = payload.get("created_at") or datetime.now().isoformat()
                        
                        if DATABASE_URL:
                            cursor.execute('INSERT INTO activity_logs (id, user_id, activity_id, date, status, created_at) VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING',
                                (payload["id"], payload["user_id"], payload["activity_id"], payload["date"], payload["status"], created_at))
                        else:
                            cursor.execute('INSERT OR IGNORE INTO activity_logs (id, user_id, activity_id, date, status, created_at) VALUES (?,?,?,?,?,?)',
                                (payload["id"], payload["user_id"], payload["activity_id"], payload["date"], payload["status"], created_at))
                        conn.commit()
                        conn.close()
                except Exception as e:
                    print(f"Error processing message: {e}")

            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=True)
            channel.start_consuming()
        except Exception as e:
            print(f"Recommendations Service: Error: {e}, retrying in 5s...")
            time.sleep(5)

@app.on_event("startup")
def startup_event():
    thread = threading.Thread(target=rabbitmq_consumer, daemon=True)
    thread.start()

@app.post("/recommendations/compute")
def compute_recommendations(req: ComputeRequest):
    conn = get_db_conn()
    cursor = conn.cursor()
    if DATABASE_URL:
        cursor.execute('SELECT created_at, status FROM activity_logs WHERE user_id = %s AND activity_id = %s', (req.user_id, req.activity_id))
    else:
        cursor.execute('SELECT created_at, status FROM activity_logs WHERE user_id = ? AND activity_id = ?', (req.user_id, req.activity_id))
    logs = cursor.fetchall()
    
    if not logs:
        return {"status": "no data"}

    # logs is a list of tuples (created_at, status)
    # Time-of-day analysis
    morning_success = 0
    morning_total = 0
    evening_success = 0
    evening_total = 0
    
    for row in logs:
        # handle both string (sqlite) and datetime (psycopg2)
        dt = row[0]
        if isinstance(dt, str):
            dt = datetime.fromisoformat(dt.replace('Z', ''))
        
        status = row[1]
        if 5 <= dt.hour < 12:
            morning_total += 1
            if status == 'done': morning_success += 1
        elif 17 <= dt.hour < 23:
            evening_total += 1
            if status == 'done': evening_success += 1
            
    m_rate = morning_success / morning_total if morning_total > 0 else 0
    e_rate = evening_success / evening_total if evening_total > 0 else 0
    
    suggestion = "Keep up your consistency!"
    if m_rate > e_rate + 0.2:
        suggestion = "You are 20%+ more consistent in the morning. Consider scheduling this habit earlier."
    elif e_rate > m_rate + 0.2:
        suggestion = "Evening seems to be your power time for this habit. Try moving it to 7 PM."
    elif len(logs) > 5 and sum(1 for l in logs if l[1] == 'done') / len(logs) < 0.4:
        suggestion = "You are missing this frequently. Try reducing frequency to 3x/week to build momentum."

    rec_id = str(uuid.uuid4())
    now = datetime.now().isoformat()
    if DATABASE_URL:
        cursor.execute('INSERT INTO recommendations (id, user_id, activity_id, suggestion, type, created_at) VALUES (%s,%s,%s,%s,%s,%s)',
                       (rec_id, req.user_id, req.activity_id, suggestion, "timing", now))
    else:
        cursor.execute('INSERT INTO recommendations (id, user_id, activity_id, suggestion, type, created_at) VALUES (?,?,?,?,?,?)',
                       (rec_id, req.user_id, req.activity_id, suggestion, "timing", now))
    conn.commit()
    conn.close()
    return {"id": rec_id, "suggestion": suggestion}

@app.get("/recommendations/stats/{user_id}")
def get_stats(user_id: str):
    conn = get_db_conn()
    cursor = conn.cursor()
    if DATABASE_URL:
        cursor.execute('SELECT created_at, status FROM activity_logs WHERE user_id = %s', (user_id,))
    else:
        cursor.execute('SELECT created_at, status FROM activity_logs WHERE user_id = ?', (user_id,))
    logs = cursor.fetchall()
    conn.close()
    
    hourly = {i: {"done": 0, "total": 0} for i in range(24)}
    daily = {i: {"done": 0, "total": 0} for i in range(7)}
    
    for row in logs:
        dt = row[0]
        if isinstance(dt, str):
            try: dt = datetime.fromisoformat(dt.replace('Z', ''))
            except: continue
        status = row[1]
        hour = dt.hour
        dow = dt.weekday()
        hourly[hour]["total"] += 1
        daily[dow]["total"] += 1
        if status == 'done':
            hourly[hour]["done"] += 1
            daily[dow]["done"] += 1
            
    return {"hourly": hourly, "daily": daily}

@app.get("/recommendations/{user_id}")
def get_recommendations(user_id: str):
    conn = get_db_conn()
    cursor = conn.cursor()
    if DATABASE_URL:
        cursor.execute('SELECT id, activity_id, suggestion, type, accepted FROM recommendations WHERE user_id = %s AND accepted = FALSE ORDER BY created_at DESC', (user_id,))
    else:
        cursor.execute('SELECT id, activity_id, suggestion, type, accepted FROM recommendations WHERE user_id = ? AND accepted = 0 ORDER BY created_at DESC', (user_id,))
    rows = cursor.fetchall()
    conn.close()
    
    result = []
    for r in rows:
        result.append({
            "id": r[0],
            "activity_id": r[1],
            "suggestion": r[2],
            "type": r[3],
            "accepted": bool(r[4])
        })
    return result

@app.post("/recommendations/accept")
def accept_recommendation(req: AcceptRequest):
    conn = get_db_conn()
    cursor = conn.cursor()
    if DATABASE_URL:
        cursor.execute('UPDATE recommendations SET accepted = TRUE WHERE id = %s AND user_id = %s', (req.recommendation_id, req.user_id))
    else:
        cursor.execute('UPDATE recommendations SET accepted = 1 WHERE id = ? AND user_id = ?', (req.recommendation_id, req.user_id))
    conn.commit()
    conn.close()
    return {"status": "accepted"}
