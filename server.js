const express = require('express');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Trust reverse proxy (Nginx) to read real client IP from X-Forwarded-For
app.set('trust proxy', 1);

app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Normalize /sapi prefix if forwarded by reverse proxy (e.g. Nginx proxy_pass without trailing slash)
app.use((req, res, next) => {
  if (req.url.startsWith('/sapi')) {
    req.url = req.url.slice(5) || '/';
  }
  next();
});

// Root ping
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Susu9 Mobile API is running',
    version: '1.0.0'
  });
});

// Rate limiting:
// 1. Auth limiter (up to 100 login attempts per 15 min per IP)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many login attempts, please try again after a few minutes.' }
});

// 2. High-capacity API limiter for real-time polling (up to 10,000 requests per 15 min per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' }
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/subuser-login', authLimiter);
app.use('/api/', apiLimiter);

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/home', require('./routes/home'));
app.use('/api/game', require('./routes/game'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/hisab', require('./routes/hisab'));
app.use('/api/balance', require('./routes/balance'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/received', require('./routes/received'));
app.use('/api/lc', require('./routes/lc'));
app.use('/api/yantri', require('./routes/yantri'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/subscription', require('./routes/subscription'));

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    message: 'Susu9 Mobile API is running',
    version: '1.0.0',
    database: process.env.DB_DATABASE,
    server: process.env.DB_SERVER,
    port: process.env.PORT || 3001,
  });
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(PORT, () => {
  console.log(`🚀 Susu9 Mobile API running on port ${PORT}`);
});
