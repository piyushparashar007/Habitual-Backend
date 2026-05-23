import os
import json
import threading
import pika
import time
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import chromadb
from chromadb.utils import embedding_functions

app = FastAPI()

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")

# Initialize ChromaDB
chroma_client = chromadb.PersistentClient(path="/app/data/chroma")
# Use ChromaDB's default embedding function (usually all-MiniLM-L6-v2)
collection = chroma_client.get_or_create_collection(name="activity_logs")

class AskRequest(BaseModel):
    user_id: str
    question: str

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
                        log_id = payload["id"]
                        user_id = payload["user_id"]
                        activity_id = payload["activity_id"]
                        date = payload["date"]
                        status = payload["status"]
                        
                        document = f"User {user_id} logged activity {activity_id} on {date} with status {status}."
                        collection.add(
                            documents=[document],
                            metadatas=[{"user_id": user_id, "activity_id": activity_id, "date": date, "status": status}],
                            ids=[log_id]
                        )
                        print(f"Added log {log_id} to ChromaDB")
                except Exception as e:
                    print(f"Error processing message: {e}")

            channel.basic_consume(queue=queue_name, on_message_callback=callback, auto_ack=True)
            print("Coach Service: Waiting for activity_events in RabbitMQ...")
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            print("Coach Service: Connection to RabbitMQ failed, retrying in 5s...")
            time.sleep(5)
        except Exception as e:
            print(f"Coach Service: Unexpected error: {e}")
            time.sleep(5)

@app.on_event("startup")
def startup_event():
    thread = threading.Thread(target=rabbitmq_consumer, daemon=True)
    thread.start()

@app.post("/coach/ask")
def ask_coach(req: AskRequest):
    # Retrieve relevant logs
    results = collection.query(
        query_texts=[req.question],
        n_results=10,
        where={"user_id": req.user_id}
    )
    
    context = ""
    if results and results['documents'] and len(results['documents'][0]) > 0:
        context = "\n".join(results['documents'][0])
    
    if not context:
        context = "No activity logs found for this user."

    prompt = f"""You are an AI Activity Coach. Answer the user's question based ONLY on the following context about their habits.

Context:
{context}

Question:
{req.question}

Answer:"""

    try:
        response = requests.post(f"{OLLAMA_URL}/api/generate", json={
            "model": "llama3", # or "mistral", "phi3" etc. depending on what you run
            "prompt": prompt,
            "stream": False
        }, timeout=30)
        response.raise_for_status()
        llm_resp = response.json().get("response", "I could not generate a response.")
        
        return {
            "response": llm_resp,
            "context_used": results['documents'][0] if results and results['documents'] else []
        }
    except Exception as e:
        # Fallback if Ollama is not running/available to prevent app crash for local testing
        print(f"Ollama error: {e}")
        return {
            "response": f"[Mocked Coach Response] Based on your logs:\n{context}\n\nAdvice: Keep up the good work! (Ollama was unreachable)",
            "context_used": results['documents'][0] if results and results['documents'] else []
        }
