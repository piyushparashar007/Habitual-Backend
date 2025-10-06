// backend/gateway/index.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const morgan = require('morgan');
const cors = require('cors');
const swaggerUi = require('swagger-ui-express');
const fs = require('fs');
const path = require('path');

const USERS_URL = process.env.USERS_URL || 'http://users:3001';
const ACTIVITIES_URL = process.env.ACTIVITIES_URL || 'http://activities:3003';
const PORT = process.env.PORT || 3002;

const app = express();
app.use(morgan('tiny'));
app.use(cors());

// Health endpoint
app.get('/health', (req, res) => res.json({ ok: true, services: { users: USERS_URL, activities: ACTIVITIES_URL } }));

// Serve OpenAPI/Swagger
const openapiPath = path.join(__dirname, 'openapi.json');
let openapi = {};
try {
  openapi = JSON.parse(fs.readFileSync(openapiPath, 'utf8'));
} catch (e) {
  console.warn('Could not load openapi.json', e && e.message);
}
if (Object.keys(openapi).length) {
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi, { explorer: true }));
  console.log('Swagger UI available at /docs');
}

// Helper: copy parsed body into proxied request (works when body-parser already parsed it)
function attachBodyToProxy(proxyReq, req, res) {
  // If bodyParser has populated req.body (for JSON/form data), forward it
  if (req.body && Object.keys(req.body).length) {
    const bodyData = JSON.stringify(req.body);
    proxyReq.setHeader('Content-Type', 'application/json');
    proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
    proxyReq.write(bodyData);
  }
}

// Proxy creation helper with sensible defaults and request body forward
function makeProxy(target) {
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    proxyTimeout: 10_000,       // give upstream 10s before proxy times out
    timeout: 30_000,            // socket timeout
    onProxyReq: (proxyReq, req, res) => {
      try {
        attachBodyToProxy(proxyReq, req, res);
      } catch (e) {
        // don't crash; just continue
        console.warn('attachBodyToProxy failed', e && e.message);
      }
    },
    onError: (err, req, res) => {
      console.error('Proxy error to', target, err && err.message);
      try {
        if (!res.headersSent) res.status(502).json({ error: 'upstream_unavailable', details: err && err.message });
      } catch (e) {}
    }
  });
}

// Proxy routes
app.use('/signup', makeProxy(USERS_URL));
app.use('/login', makeProxy(USERS_URL));
app.use('/account', makeProxy(USERS_URL));
app.use('/uploads', makeProxy(USERS_URL));

app.use('/activities', makeProxy(ACTIVITIES_URL));
app.use('/due', makeProxy(ACTIVITIES_URL));
app.use('/analytics', makeProxy(ACTIVITIES_URL));
app.use('/logs', makeProxy(ACTIVITIES_URL));

app.listen(PORT, () => {
  console.log(`Gateway listening on ${PORT}`);
});
