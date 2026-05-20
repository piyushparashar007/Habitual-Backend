# Habitual — Lightweight backend (Docker)

## Quick start (local)
1. Copy `.env` and set `JWT_SECRET` (do not use default in production).
2. From `backend/` run:
3. Gateway will be available at `http://localhost:3002`.

## Endpoints (via gateway http://localhost:3002)
- POST /signup         {email,password} -> { token, user }
- POST /login          {email,password} -> { token, user }
- POST /account/update multipart or json -> { user }
- POST /account/delete {id}
- GET  /account/:id
- GET  /activities
- POST /activities
- GET  /activities/:id
- PUT  /activities/:id
- DELETE /activities/:id
- POST /activities/:id/log
- GET  /activities/:id/logs
- GET  /logs
- GET  /due
- GET  /analytics/:userId

Avatar files are served by users-service under path `/uploads/<filename>` proxied by gateway. In responses `avatar` fields contain paths like `/uploads/<filename>` — the frontend should request `http://localhost:3002/uploads/<filename>`.

## Notes
- SQLite DB files are kept in Docker volumes `users_data` and `activities_data`.
- For production: use managed DB (Postgres), a proper file storage (S3), secrets manager, and horizontal scaling.
