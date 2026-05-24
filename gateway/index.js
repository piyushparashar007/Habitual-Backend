// backend/gateway/index.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

const USERS_URL = process.env.USERS_URL || 'http://users-service:3001';
const ACTIVITIES_URL = process.env.ACTIVITIES_URL || 'http://activities-service:3003';
const COACH_URL = process.env.COACH_URL || 'http://coach-service:3004';
const RECOMMENDATIONS_URL = process.env.RECOMMENDATIONS_URL || 'http://recommendations-service:3005';
const PORT = process.env.PORT || 3002;

const app = express();
app.use(morgan('tiny'));
app.use(cors());

// Health endpoint
app.get('/health', (req, res) => res.json({ ok: true, services: { users: USERS_URL, activities: ACTIVITIES_URL } }));

// Serve OpenAPI/Swagger
const openapiPath = path.join(__dirname, 'openapi.json');
let openapi = {};
try { openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8')); } catch (e) {}
if (Object.keys(openapi).length) {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));
}

// Helper: copy parsed body into proxied request
function attachBodyToProxy(proxyReq, req) {
  if (req.body && Object.keys(req.body).length) {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  }
}

// Global Proxy defaults
const proxyOptions = {
  changeOrigin: true,
  proxyTimeout: 60_000,
  timeout: 60_000,
  onProxyReq: attachBodyToProxy,
  onError: (err, req, res) => {
    console.error(`Proxy error [${req.path}] ->`, err && err.message);
    if (!res.headersSent) res.status(502).json({ error: 'upstream_unavailable' });
  }
};

/** 
 * TRANSPARENT PROXYING
 * We mount at root and use a filter function.
 * This prevents http-proxy-middleware from stripping the mount path.
 */

// Users Service
app.use((req, res, next) => {
  const paths = ['/signup', '/login', '/account', '/uploads'];
  if (paths.some(p => req.path.startsWith(p))) {
    return createProxyMiddleware({ ...proxyOptions, target: USERS_URL })(req, res, next);
  }
  next();
});

// Activities Service
app.use((req, res, next) => {
  const paths = ['/activities', '/due', '/analytics', '/logs'];
  if (paths.some(p => req.path.startsWith(p))) {
    return createProxyMiddleware({ ...proxyOptions, target: ACTIVITIES_URL })(req, res, next);
  }
  next();
});

// Coach Service
app.use((req, res, next) => {
  if (req.path.startsWith('/coach')) {
    return createProxyMiddleware({ ...proxyOptions, target: COACH_URL })(req, res, next);
  }
  next();
});

// Recommendations Service
app.use((req, res, next) => {
  if (req.path.startsWith('/recommendations')) {
    return createProxyMiddleware({ ...proxyOptions, target: RECOMMENDATIONS_URL })(req, res, next);
  }
  next();
});

app.listen(PORT, () => console.log(`Gateway listening on ${PORT}`));
