# Habitual — Microservices Backend

## Architecture Overview
Habitual is a cloud-native microservices architecture designed for scalability and personalized AI insights.

### Services:
- **Gateway (Express)**: API Gateway routing requests to internal microservices.
- **Users Service (Express/SQLite)**: Handles authentication, user profiles, and JWT.
- **Activities Service (Express/SQLite)**: Manages CRUD operations for activities and logs activity events. Publishes events to RabbitMQ.
- **Coach Service (FastAPI/Chroma/Ollama)**: AI Activity Coach. Listens to RabbitMQ to store activity logs in ChromaDB. Provides a RAG pipeline (`/coach/ask`) to query a local LLM (Ollama) using user activity context.
- **Recommendations Service (FastAPI/SQLite)**: Listens to RabbitMQ and generates personalized timing and frequency nudges (`/recommendations`).
- **RabbitMQ**: Message broker for asynchronous event-driven architecture.
- **Ollama**: Local LLM engine serving open-source models for the AI Coach.

## Quick start (local)
1. Ensure Docker and Docker Compose are installed.
2. From the `Habitual-Backend` folder, start the services:
   ```bash
   docker-compose up -d --build
   ```
3. The Gateway will be available at `http://localhost:3002`.
   *(Note: The Ollama container is exposed on `11434`. You may need to pull a model inside it manually e.g. `docker exec -it ollama ollama run llama3` for the AI coach to work perfectly).*

## Endpoints (via gateway http://localhost:3002)
- POST `/signup`         {email,password} -> { token, user }
- POST `/login`          {email,password} -> { token, user }
- POST `/account/update` multipart or json -> { user }
- GET  `/account/:id`
- GET  `/activities`
- POST `/activities`
- GET  `/activities/:id`
- PUT  `/activities/:id`
- DELETE `/activities/:id`
- POST `/activities/:id/log`
- GET  `/activities/:id/logs`
- GET  `/logs`
- GET  `/due`
- GET  `/analytics/:userId`
- POST `/coach/ask`      {user_id, question} -> { response, context_used }
- GET  `/recommendations/:userId` -> list of nudges
- POST `/recommendations/accept` {user_id, recommendation_id, accepted: true}

## Cloud Deployment (Kubernetes)
Manifests are located in `k8s/`:
- `configmap.yaml` & `secret.yaml` for configuration.
- `deployments.yaml` containing Deployments, Services, and HPA (Horizontal Pod Autoscaler) rules for all microservices.

## CI/CD
A GitHub Actions workflow is provided in `.github/workflows/deploy.yml` which builds Docker images, pushes them to a private registry, and updates the Kubernetes cluster.

