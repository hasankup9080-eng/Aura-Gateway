/**
 * ⚡ AURA GATEWAY - Premium Backend Server v4.8
 * Replit Deployment with Railway PostgreSQL
 * 
 * DEPLOYMENT CONFIGURATION:
 * - Running on: Replit
 * - Database: Railway PostgreSQL (External)
 * - SSL Mode: rejectUnauthorized: false (Required for Railway connection)
 * 
 * NEW in v4.8 (The Sigma 14):
 * 1. Flexible SMS API (number/phone/to/recipient + message/text/msg/sms)
 * 2. Atomic Transactions with SELECT FOR UPDATE
 * 3. Rate Limiting (3 SMS per minute per API key)
 * 4. Admin Middleware Protection
 * 5. User Approval (5 free credits on activation)
 * 6. Balance Management (Admin credit top-up)
 * 7. User List for Admin Dashboard
 * 8. Status Monitoring (key_status + sms_balance)
 * 9. Android Polling (GET /api/pending-sms)
 * 10. Delivery Status (POST /api/status)
 * 11. Device Health Monitoring
 * 12. Robust Request Logging (req.body debug)
 * 13. Fail-Safe Startup (DB connection test)
 * 14. CORS + express.json() with 10mb limit
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const crypto = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'production';

// Security Configuration
const API_KEY = process.env.API_KEY || 'lynx-aura-gateway-2025';
const ADMIN_DEVICE_ID = 'REAL-MENA-RZO5-0177';
const SECRET_OWNER_KEY = process.env.SECRET_OWNER_KEY || '★LYNX★';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lynx-admin-2025';

// Rate Limiting Storage (In-Memory)
const rateLimitStore = new Map(); // { apiKey: [timestamp1, timestamp2, ...] }

// ════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

// CORS Configuration
app.use(cors());

// JSON Parser with 10MB limit (Sigma Requirement #14)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request Logging Middleware with req.body Debug (Sigma Requirement #12)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n⚡ [${timestamp}] ${req.method} ${req.path}`);
  console.log(`   User-Agent: ${req.headers['user-agent'] || 'Unknown'}`);
  
  // Log req.body for ALL POST requests (Debug Mode)
  if (req.method === 'POST') {
    console.log(`   📦 req.body:`, JSON.stringify(req.body, null, 2));
  }
  
  next();
});

// ════════════════════════════════════════════════════════════════════════════
// POSTGRESQL DATABASE CONFIGURATION (REPLIT → RAILWAY)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 🔐 REPLIT-RAILWAY SSL FIX:
 * Railway PostgreSQL requires SSL, but Replit cannot verify the certificate.
 * Solution: Set `rejectUnauthorized: false` to allow the connection.
 * This is REQUIRED when connecting from Replit to Railway PostgreSQL.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false  // ⚠️ CRITICAL for Replit → Railway connection
  },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  console.log('🔌 Database client connected (Railway PostgreSQL)');
});

pool.on('error', (err) => {
  console.error('💥 Unexpected database error:', err);
});

// ════════════════════════════════════════════════════════════════════════════
// DATABASE SCHEMA INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Fail-Safe Database Initialization (Sigma Requirement #13)
 * Server will NOT start if DB connection fails
 */
const initializeDatabase = async () => {
  // Test connection first
  try {
    const testClient = await pool.connect();
    testClient.release();
    console.log('✅ Railway PostgreSQL connection verified');
  } catch (connError) {
    console.error('\n════════════════════════════════════════════════════════════════');
    console.error('💥 FATAL: Cannot connect to Railway PostgreSQL!');
    console.error('   Error:', connError.message);
    console.error('   Check your DATABASE_URL environment variable.');
    console.error('   Server will NOT start without database connection.');
    console.error('════════════════════════════════════════════════════════════════\n');
    process.exit(1);
  }

  try {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('📊 Initializing database schema...');
    console.log('════════════════════════════════════════════════════════════════\n');

    // Create SMS Received Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_received (
        id UUID PRIMARY KEY,
        sender VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "sms_received" ready');

    // Create Users Table with SaaS Features
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255),
        phone VARCHAR(20) NOT NULL,
        payment_number VARCHAR(20) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        otp_code VARCHAR(6),
        is_verified BOOLEAN DEFAULT FALSE,
        device_id VARCHAR(255),
        api_key TEXT UNIQUE,
        key_status TEXT DEFAULT 'pending',
        credits INTEGER DEFAULT 0,
        expiry_date TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Safe migration: add password_hash column if table already exists without it
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255)`);
    } catch (e) {
      // Column may already exist, safe to ignore
    }
    console.log('✅ Table "users" ready');

    // Create Outgoing SMS Queue
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outgoing_sms (
        id UUID PRIMARY KEY,
        recipient_number VARCHAR(20) NOT NULL,
        message_text TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        sent_at TIMESTAMP
      );
    `);
    console.log('✅ Table "outgoing_sms" ready');

    // Create Device Status Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_status (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(255) NOT NULL UNIQUE,
        battery_level INTEGER,
        is_charging BOOLEAN DEFAULT FALSE,
        signal_strength INTEGER,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "device_status" ready');

    // Create Chat Messages Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY,
        sender_id VARCHAR(255),
        username VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'User',
        device_id VARCHAR(255),
        reply_to_id UUID,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "chat_messages" ready');

    // Create OTP Requests Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(20) NOT NULL,
        requested_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "otp_requests" ready');

    // Create Indexes
    console.log('\n🔍 Creating performance indexes...\n');
    
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key)',
      'CREATE INDEX IF NOT EXISTS idx_users_key_status ON users(key_status)',
      'CREATE INDEX IF NOT EXISTS idx_outgoing_sms_status ON outgoing_sms(status, created_at)',
      'CREATE INDEX IF NOT EXISTS idx_sms_received_timestamp ON sms_received(timestamp DESC)',
      'CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp DESC)'
    ];

    for (const idx of indexes) {
      try {
        await pool.query(idx);
        console.log(`✅ Index created`);
      } catch (error) {
        console.log(`⚠️  Index error:`, error.message);
      }
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('🎉 Database initialization complete!');
    console.log('════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n════════════════════════════════════════════════════════════════');
    console.error('❌ Database initialization failed:', error);
    console.error('════════════════════════════════════════════════════════════════\n');
    throw error;
  }
};

// ════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Sanitize and truncate text input
 */
const sanitizeText = (text, maxLength = 1600) => {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > maxLength ? str.substring(0, maxLength) : str;
};

/**
 * Generate SaaS API Key
 */
const generateSaaSApiKey = () => {
  const randomString = crypto.randomBytes(24).toString('hex');
  return `aura_live_${randomString}`;
};

/**
 * Validate Bangladeshi Phone Number (11 digits, starts with 01)
 */
const validateBangladeshiPhone = (phone) => {
  const regex = /^01[0-9]{9}$/;
  return regex.test(phone);
};

/**
 * Hash Password using scrypt (built-in crypto, no extra dependency)
 */
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

/**
 * Verify Password against stored hash
 */
const verifyPassword = (password, storedHash) => {
  const [salt, hash] = storedHash.split(':');
  const hashToVerify = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashToVerify, 'hex'));
};

/**
 * Generate 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Check OTP Cooldown (3 requests per 15 minutes)
 */
const checkOTPCooldown = async (phone) => {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const result = await pool.query(
    `SELECT COUNT(*) as count FROM otp_requests 
     WHERE phone_number = $1 AND requested_at > $2`,
    [phone, fifteenMinutesAgo]
  );
  return parseInt(result.rows[0].count) >= 3;
};

/**
 * Log OTP Request
 */
const logOTPRequest = async (phone) => {
  await pool.query(`INSERT INTO otp_requests (phone_number) VALUES ($1)`, [phone]);
};

/**
 * Detect Owner Role
 */
const detectOwnerRole = (deviceId, message, secretKey) => {
  if (deviceId === ADMIN_DEVICE_ID) return '★ OWNER';
  if (secretKey && secretKey === SECRET_OWNER_KEY) return '★ OWNER';
  if (message && message.includes(SECRET_OWNER_KEY)) return '★ OWNER';
  return 'User';
};

/**
 * Format Timestamp
 */
const formatTimestamp = (date) => {
  return date.toISOString();
};

// ════════════════════════════════════════════════════════════════════════════
// MIDDLEWARE: AUTHENTICATION & RATE LIMITING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Legacy API Key Validation
 */
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API Key is required',
      message: '🔒 Access denied. Please provide a valid API key.'
    });
  }

  if (apiKey !== API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API Key',
      message: '⚠️ Authentication failed. Invalid credentials.'
    });
  }

  next();
};

/**
 * Admin Middleware Protection (Sigma Requirement #4)
 */
const verifyAdmin = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey || apiKey !== API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required',
      message: '🔒 Provide a valid Master API Key in x-api-key header.'
    });
  }

  next();
};

/**
 * SaaS API Key Verification with Status Check (Sigma Requirement #8)
 */
const verifySaaSKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'API Key required',
        message: '🔒 Please provide your SaaS API key in x-api-key header'
      });
    }

    if (!apiKey.startsWith('aura_live_')) {
      return res.status(401).json({
        success: false,
        error: 'Invalid API Key format',
        message: '⚠️ SaaS API keys must start with "aura_live_"'
      });
    }

    const result = await pool.query(
      'SELECT id, username, key_status, credits, expiry_date FROM users WHERE api_key = $1',
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(403).json({
        success: false,
        error: 'Invalid API Key',
        message: '⚠️ API key not found in our system'
      });
    }

    const user = result.rows[0];

    // Check key_status (Sigma Requirement #8)
    if (user.key_status !== 'active') {
      const statusMessages = {
        pending: '⏳ Your account is pending admin approval.',
        suspended: '🚫 Your account has been suspended.'
      };
      return res.status(403).json({
        success: false,
        error: `Account ${user.key_status}`,
        message: statusMessages[user.key_status] || `Account status: ${user.key_status}`,
        key_status: user.key_status,
        sms_balance: user.credits
      });
    }

    // Check expiry date
    if (user.expiry_date && new Date(user.expiry_date) < new Date()) {
      return res.status(403).json({
        success: false,
        error: 'API key expired',
        message: '⏰ Your API key has expired. Please renew.',
        key_status: 'expired',
        sms_balance: user.credits
      });
    }

    req.saasUser = user;
    next();

  } catch (error) {
    console.error('❌ SaaS Key Verification Error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed',
      message: error.message
    });
  }
};

/**
 * Rate Limiting Middleware (Sigma Requirement #3)
 * Limit: 3 SMS per minute per API key
 */
const rateLimitSMS = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  if (!rateLimitStore.has(apiKey)) {
    rateLimitStore.set(apiKey, []);
  }

  const timestamps = rateLimitStore.get(apiKey);
  
  // Remove timestamps older than 1 minute
  const recentTimestamps = timestamps.filter(ts => ts > oneMinuteAgo);
  rateLimitStore.set(apiKey, recentTimestamps);

  if (recentTimestamps.length >= 3) {
    console.log(`\n🚫 RATE LIMIT EXCEEDED - API Key: ${apiKey.substring(0, 20)}...`);
    return res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: '⚠️ You can only send 3 SMS per minute. Please wait.',
      retry_after: '60 seconds'
    });
  }

  // Add current timestamp
  recentTimestamps.push(now);
  rateLimitStore.set(apiKey, recentTimestamps);

  next();
};

// ════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// ROOT & HEALTH CHECK
// ────────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    success: true,
    app: '⚡ AURA GATEWAY',
    version: '4.8.0',
    deployment: 'Replit → Railway PostgreSQL',
    database: 'Connected',
    status: 'operational',
    sigma_features: [
      'Flexible SMS API',
      'Atomic Transactions',
      'Rate Limiting (3/min)',
      'Admin Protection',
      'User Approval (5 credits)',
      'Balance Management',
      'User List',
      'Status Monitoring',
      'Android Polling',
      'Delivery Status',
      'Device Health',
      'Robust Logging',
      'Fail-Safe Startup',
      'CORS + JSON 10mb'
    ]
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      deployment: 'Replit → Railway PostgreSQL',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION
// ────────────────────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, device_id, deviceId } = req.body;
    const finalDeviceId = device_id || deviceId;

    if (!username || !password || !finalDeviceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'password', 'device_id']
      });
    }

    if (password === ADMIN_PASSWORD) {
      return res.json({
        success: true,
        message: 'Login successful',
        apiKey: API_KEY,
        role: finalDeviceId === ADMIN_DEVICE_ID ? '★ OWNER' : 'Admin',
        device_id: finalDeviceId
      });
    }

    const userResult = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_verified = true',
      [username]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials or unverified account'
      });
    }

    const user = userResult.rows[0];

    if (!user.password_hash) {
      return res.status(401).json({
        success: false,
        error: 'Account has no password set. Please contact admin.'
      });
    }

    const isPasswordValid = verifyPassword(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    res.json({
      success: true,
      message: 'Login successful',
      apiKey: user.api_key,
      role: 'User',
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        key_status: user.key_status,
        sms_balance: user.credits
      }
    });

  } catch (error) {
    console.error('❌ Login Error:', error);
    res.status(500).json({
      success: false,
      error: 'Login failed',
      message: error.message
    });
  }
});

app.post('/api/signup', async (req, res) => {
  const client = await pool.connect();

  try {
    const username = sanitizeText(req.body.username, 255);
    const { phone, payment_number, provider, password } = req.body;

    if (!username || !phone || !payment_number || !provider || !password) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'password', 'phone', 'payment_number', 'provider']
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password too short',
        message: 'Password must be at least 6 characters long'
      });
    }

    if (!validateBangladeshiPhone(phone)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format',
        message: 'Phone must be 11 digits starting with 01'
      });
    }

    if (!validateBangladeshiPhone(payment_number)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment number format',
        message: 'Payment number must be 11 digits starting with 01'
      });
    }

    if (!['bKash', 'Nagad', 'Rocket'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment provider',
        allowed: ['bKash', 'Nagad', 'Rocket']
      });
    }

    const isCooldownActive = await checkOTPCooldown(phone);
    if (isCooldownActive) {
      return res.status(429).json({
        success: false,
        error: 'Too many OTP requests',
        message: 'You can only request OTP 3 times per 15 minutes.'
      });
    }

    await client.query('BEGIN');

    const existingUser = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        error: 'Username already exists'
      });
    }

    const otpCode = generateOTP();
    const userId = uuidv4();
    const saasApiKey = generateSaaSApiKey();
    const hashedPassword = hashPassword(password);

    await client.query(
      `INSERT INTO users (
        id, username, password_hash, phone, payment_number, provider,
        otp_code, is_verified, api_key, key_status, credits
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, 'pending', 0)`,
      [userId, username, hashedPassword, phone, payment_number, provider, otpCode, saasApiKey]
    );

    const smsId = uuidv4();
    const smsMessage = `Your Aura Gateway OTP is: ${otpCode}. Valid for 15 minutes.`;

    await client.query(
      `INSERT INTO outgoing_sms (id, recipient_number, message_text, status)
       VALUES ($1, $2, $3, 'pending')`,
      [smsId, phone, smsMessage]
    );

    await logOTPRequest(phone);
    await client.query('COMMIT');

    console.log(`\n✅ NEW USER SIGNUP - Username: ${username} | API Key: ${saasApiKey.substring(0, 30)}...`);

    res.status(201).json({
      success: true,
      message: 'User registered successfully. OTP sent via SMS.',
      user: {
        id: userId,
        username,
        phone,
        api_key: saasApiKey,
        key_status: 'pending',
        sms_balance: 0
      },
      otp_sent: true,
      next_step: 'Verify OTP, then wait for admin approval'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Signup Error:', error);
    res.status(500).json({
      success: false,
      error: 'Signup failed',
      message: error.message
    });
  } finally {
    client.release();
  }
});

app.post('/api/verify-otp', async (req, res) => {
  try {
    const { username, otp_code } = req.body;

    if (!username || !otp_code) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'otp_code']
      });
    }

    const result = await pool.query(
      `UPDATE users 
       SET is_verified = true, otp_code = NULL
       WHERE username = $1 AND otp_code = $2 AND is_verified = false
       RETURNING id, username, phone, key_status, credits`,
      [username, otp_code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP or user already verified'
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      message: 'Account verified successfully',
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        key_status: user.key_status,
        sms_balance: user.credits
      },
      next_step: 'Wait for admin approval to activate your API key'
    });

  } catch (error) {
    console.error('❌ OTP Verification Error:', error);
    res.status(500).json({
      success: false,
      error: 'Verification failed',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// USER MANAGEMENT (Sigma Requirement #7)
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/users - List all users for Admin Dashboard
 */
app.get('/api/users', verifyAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, username, phone, payment_number, provider,
        is_verified, device_id,
        api_key, key_status, credits, expiry_date,
        created_at
      FROM users
      ORDER BY created_at DESC
    `);

    const users = result.rows;

    console.log(`\n👥 USER LIST - Total: ${users.length} | Active: ${users.filter(u => u.key_status === 'active').length}`);

    res.json({
      success: true,
      count: users.length,
      users: users.map(user => ({
        id: user.id,
        username: user.username,
        phone: user.phone,
        payment_number: user.payment_number,
        provider: user.provider,
        is_verified: user.is_verified,
        device_id: user.device_id,
        api_key: user.api_key,
        key_status: user.key_status,
        sms_balance: user.credits,
        expiry_date: user.expiry_date ? formatTimestamp(user.expiry_date) : null,
        created_at: formatTimestamp(user.created_at)
      }))
    });

  } catch (error) {
    console.error('❌ User List Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message
    });
  }
});

/**
 * GET /api/me - Get current user profile
 */
app.get('/api/me', verifySaaSKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, phone, payment_number, provider,
              is_verified, api_key, key_status, credits, expiry_date, created_at
       FROM users WHERE id = $1`,
      [req.saasUser.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        payment_number: user.payment_number,
        provider: user.provider,
        is_verified: user.is_verified,
        api_key: user.api_key,
        key_status: user.key_status,
        sms_balance: user.credits,
        expiry_date: user.expiry_date ? formatTimestamp(user.expiry_date) : null,
        created_at: formatTimestamp(user.created_at)
      }
    });

  } catch (error) {
    console.error('❌ Get Profile Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch profile',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ADMIN TOOLS (Sigma Requirements #5 & #6)
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/approve - Approve user and give 5 free credits (Sigma #5)
 */
app.post('/api/admin/approve', verifyAdmin, async (req, res) => {
  try {
    const { user_id, status } = req.body;
    const freeCredits = status === 'active' ? 5 : 0; // Give 5 credits on activation

    if (!user_id || !status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['user_id', 'status']
      });
    }

    if (!['active', 'suspended', 'pending'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status',
        allowed: ['active', 'suspended', 'pending']
      });
    }

    const result = await pool.query(
      `UPDATE users 
       SET key_status = $1, credits = credits + $2
       WHERE id = $3
       RETURNING id, username, api_key, key_status, credits`,
      [status, freeCredits, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = result.rows[0];

    console.log(`\n🔑 ADMIN APPROVAL - User: ${user.username} | Status: ${status} | Free Credits: ${freeCredits}`);

    res.json({
      success: true,
      message: `User API key ${status === 'active' ? 'activated with 5 free credits' : status}`,
      user: {
        id: user.id,
        username: user.username,
        api_key: user.api_key,
        key_status: user.key_status,
        sms_balance: user.credits
      }
    });

  } catch (error) {
    console.error('❌ Admin Approve Error:', error);
    res.status(500).json({
      success: false,
      error: 'Approval failed',
      message: error.message
    });
  }
});

/**
 * POST /api/admin/renew - Add credits to user (Sigma Requirement #6)
 */
app.post('/api/admin/renew', verifyAdmin, async (req, res) => {
  try {
    const { user_id, credits, days } = req.body;

    if (!user_id || credits === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['user_id', 'credits']
      });
    }

    const daysToAdd = days || 30; // Default 30 days if not specified
    const newExpiryDate = new Date();
    newExpiryDate.setDate(newExpiryDate.getDate() + parseInt(daysToAdd));

    const result = await pool.query(
      `UPDATE users 
       SET credits = credits + $1, expiry_date = $2
       WHERE id = $3
       RETURNING id, username, api_key, key_status, credits, expiry_date`,
      [parseInt(credits), newExpiryDate, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = result.rows[0];

    console.log(`\n💳 ADMIN RENEW - User: ${user.username} | Credits Added: +${credits} | New Balance: ${user.credits}`);

    res.json({
      success: true,
      message: `Added ${credits} credits and extended expiry by ${daysToAdd} days`,
      user: {
        id: user.id,
        username: user.username,
        api_key: user.api_key,
        key_status: user.key_status,
        sms_balance: user.credits,
        expiry_date: formatTimestamp(user.expiry_date)
      }
    });

  } catch (error) {
    console.error('❌ Admin Renew Error:', error);
    res.status(500).json({
      success: false,
      error: 'Renewal failed',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SMS API WITH FLEXIBLE FIELDS (Sigma Requirements #1, #2, #3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/send-sms - Send SMS with Flexible Field Names (Sigma #1)
 * Atomic Transaction with Row Locking (Sigma #2)
 * Rate Limited to 3 SMS per minute (Sigma #3)
 */
app.post('/api/send-sms', verifySaaSKey, rateLimitSMS, async (req, res) => {
  const client = await pool.connect();

  try {
    // Flexible field mapping (Sigma Requirement #1)
    const recipient = req.body.recipient || req.body.number || req.body.phone || req.body.to;
    const messageRaw = req.body.message || req.body.text || req.body.msg || req.body.sms;
    const message = sanitizeText(messageRaw, 1600);

    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        message: 'Provide either: (recipient/number/phone/to) AND (message/text/msg/sms)',
        examples: {
          example1: { recipient: '01712345678', message: 'Hello' },
          example2: { number: '01712345678', text: 'Hello' },
          example3: { phone: '01712345678', msg: 'Hello' },
          example4: { to: '01712345678', sms: 'Hello' }
        }
      });
    }

    if (!validateBangladeshiPhone(recipient)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number',
        message: 'Phone must be 11 digits starting with 01'
      });
    }

    // Atomic Transaction with Row Locking (Sigma Requirement #2)
    await client.query('BEGIN');

    const lockResult = await client.query(
      `SELECT id, username, credits AS sms_balance
       FROM users WHERE id = $1 FOR UPDATE`,
      [req.saasUser.id]
    );

    const user = lockResult.rows[0];

    if (user.sms_balance <= 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        success: false,
        error: 'Insufficient balance',
        message: '💳 You have 0 credits. Please purchase more.',
        sms_balance: 0
      });
    }

    // Deduct 1 credit
    const updateResult = await client.query(
      `UPDATE users SET credits = credits - 1
       WHERE id = $1 RETURNING credits AS sms_balance`,
      [user.id]
    );

    const newBalance = updateResult.rows[0].sms_balance;

    // Queue SMS
    const smsId = uuidv4();
    await client.query(
      `INSERT INTO outgoing_sms (id, recipient_number, message_text, status)
       VALUES ($1, $2, $3, 'pending')`,
      [smsId, recipient, message]
    );

    await client.query('COMMIT');

    console.log(`\n📤 SMS QUEUED - User: ${user.username} | To: ${recipient} | Balance: ${user.sms_balance} → ${newBalance}`);

    res.json({
      success: true,
      message: 'SMS queued successfully',
      sms: {
        id: smsId,
        recipient,
        message,
        status: 'pending'
      },
      sms_balance: newBalance
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Send SMS Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send SMS',
      message: error.message
    });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// ANDROID APP ROUTES (Sigma Requirements #9, #10, #11)
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/pending-sms - Android app polls for queued SMS (Sigma #9)
 */
app.get('/api/pending-sms', verifySaaSKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM outgoing_sms 
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        pending: false,
        message: 'No pending SMS'
      });
    }

    const sms = result.rows[0];

    res.json({
      success: true,
      pending: true,
      sms: {
        id: sms.id,
        recipient: sms.recipient_number,
        message: sms.message_text,
        created_at: sms.created_at
      }
    });

  } catch (error) {
    console.error('❌ Pending SMS Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending SMS',
      message: error.message
    });
  }
});

/**
 * POST /api/status - Android app updates SMS delivery status (Sigma #10)
 */
app.post('/api/status', verifySaaSKey, async (req, res) => {
  try {
    const { sms_id, status } = req.body;

    if (!sms_id || !status) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['sms_id', 'status']
      });
    }

    if (!['sent', 'failed'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status',
        allowed: ['sent', 'failed']
      });
    }

    const result = await pool.query(
      `UPDATE outgoing_sms 
       SET status = $1, sent_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [status, sms_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'SMS not found'
      });
    }

    const sms = result.rows[0];

    console.log(`\n✅ SMS STATUS UPDATE - ID: ${sms.id} | Status: ${status.toUpperCase()}`);

    res.json({
      success: true,
      message: 'SMS status updated',
      sms: {
        id: sms.id,
        recipient: sms.recipient_number,
        status: sms.status,
        sent_at: sms.sent_at
      }
    });

  } catch (error) {
    console.error('❌ SMS Status Update Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update status',
      message: error.message
    });
  }
});

/**
 * POST /api/device-health - Device health monitoring (Sigma #11)
 */
app.post('/api/device-health', verifySaaSKey, async (req, res) => {
  try {
    const { battery_level, is_charging, signal_strength } = req.body;

    if (battery_level === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['battery_level']
      });
    }

    const result = await pool.query(
      `INSERT INTO device_status (device_id, battery_level, is_charging, signal_strength, last_updated)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET
         battery_level = $2,
         is_charging = $3,
         signal_strength = $4,
         last_updated = NOW()
       RETURNING *`,
      [ADMIN_DEVICE_ID, battery_level, is_charging || false, signal_strength || null]
    );

    res.json({
      success: true,
      message: 'Device health updated',
      device: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Device Health Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update device health',
      message: error.message
    });
  }
});

/**
 * POST /api/sms - Log incoming SMS from Android phone
 */
app.post('/api/sms', verifySaaSKey, async (req, res) => {
  try {
    const { sender, device_id, deviceId, timestamp } = req.body;
    const message = sanitizeText(req.body.message, 1600);
    const finalDeviceId = device_id || deviceId;

    if (!sender || !message || !finalDeviceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['sender', 'message', 'device_id']
      });
    }

    const smsId = uuidv4();
    const smsTimestamp = timestamp ? new Date(timestamp) : new Date();

    await pool.query(
      `INSERT INTO sms_received (id, sender, message, device_id, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [smsId, sender, message, finalDeviceId, smsTimestamp]
    );

    console.log(`\n📨 INCOMING SMS - From: ${sender} | Device: ${finalDeviceId}`);

    res.status(201).json({
      success: true,
      message: 'SMS logged successfully',
      data: {
        id: smsId,
        sender,
        message,
        device_id: finalDeviceId,
        timestamp: formatTimestamp(smsTimestamp)
      }
    });

  } catch (error) {
    console.error('❌ SMS Logging Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to log SMS',
      message: error.message
    });
  }
});

/**
 * GET /api/sms - Fetch SMS logs (Admin)
 */
app.get('/api/sms', verifyAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = await pool.query(
      'SELECT * FROM sms_received ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (error) {
    console.error('❌ SMS Fetch Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch SMS logs',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// CHAT SYSTEM
// ────────────────────────────────────────────────────────────────────────────

app.post('/api/chat', validateApiKey, async (req, res) => {
  try {
    const username = sanitizeText(req.body.username, 255);
    const message = sanitizeText(req.body.message, 1600);
    const { device_id, deviceId, reply_to_id, secret_key } = req.body;
    const finalDeviceId = device_id || deviceId;

    if (!username || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'message']
      });
    }

    const role = detectOwnerRole(finalDeviceId, message, secret_key);
    const messageId = uuidv4();
    const timestamp = new Date();

    await pool.query(
      `INSERT INTO chat_messages (id, username, message, role, device_id, reply_to_id, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, username, message, role, finalDeviceId, reply_to_id || null, timestamp]
    );

    res.status(201).json({
      success: true,
      message: 'Chat message sent',
      data: {
        id: messageId,
        username,
        message,
        role,
        device_id: finalDeviceId,
        reply_to_id: reply_to_id || null,
        timestamp: formatTimestamp(timestamp),
        isOwner: role === '★ OWNER'
      }
    });

  } catch (error) {
    console.error('❌ Chat Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send message',
      message: error.message
    });
  }
});

app.get('/api/chat', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);

    const result = await pool.query(
      `SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT $1`,
      [limit]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows
    });

  } catch (error) {
    console.error('❌ Chat Fetch Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch chat messages',
      message: error.message
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ════════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

app.use((error, req, res, next) => {
  console.error('\n💥 UNHANDLED ERROR:', error);

  res.status(error.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : error.message,
    ...(NODE_ENV === 'development' && { stack: error.stack })
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULED CLEANUP ROUTINES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Rate Limit Store Cleanup - Runs every 5 minutes
 * Removes entries older than 5 minutes to prevent memory leaks
 */
const startRateLimitCleanup = () => {
  setInterval(() => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    let cleaned = 0;

    for (const [apiKey, timestamps] of rateLimitStore.entries()) {
      const fresh = timestamps.filter(ts => ts > fiveMinutesAgo);
      if (fresh.length === 0) {
        rateLimitStore.delete(apiKey);
        cleaned++;
      } else {
        rateLimitStore.set(apiKey, fresh);
      }
    }

    if (cleaned > 0) {
      console.log(`🧹 Rate limit cleanup: removed ${cleaned} stale entries`);
    }
  }, 5 * 60 * 1000);
};

/**
 * Global Message Auto-Cleanup - Runs every 24 hours
 * Deletes data older than 15 days from:
 *   - chat_messages
 *   - outgoing_sms
 *   - sms_received
 * NEVER touches the users table
 */
const startDataCleanup = () => {
  const FIFTEEN_DAYS_MS = 15 * 24 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  const runCleanup = async () => {
    const cutoffDate = new Date(Date.now() - FIFTEEN_DAYS_MS);
    console.log(`\n🧹 AUTO-CLEANUP STARTED - Removing data older than: ${cutoffDate.toISOString()}`);

    try {
      const chatResult = await pool.query(
        `DELETE FROM chat_messages WHERE timestamp < $1`,
        [cutoffDate]
      );
      console.log(`   - chat_messages: ${chatResult.rowCount} rows deleted`);

      const outgoingResult = await pool.query(
        `DELETE FROM outgoing_sms WHERE created_at < $1`,
        [cutoffDate]
      );
      console.log(`   - outgoing_sms: ${outgoingResult.rowCount} rows deleted`);

      const smsReceivedResult = await pool.query(
        `DELETE FROM sms_received WHERE timestamp < $1`,
        [cutoffDate]
      );
      console.log(`   - sms_received: ${smsReceivedResult.rowCount} rows deleted`);

      console.log(`🧹 AUTO-CLEANUP COMPLETE\n`);
    } catch (error) {
      console.error('❌ Auto-cleanup error:', error.message);
    }
  };

  runCleanup();

  setInterval(runCleanup, TWENTY_FOUR_HOURS_MS);
};

// ════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP (Sigma Requirement #13 - Fail-Safe)
// ════════════════════════════════════════════════════════════════════════════

const startServer = async () => {
  try {
    await initializeDatabase();

    startRateLimitCleanup();
    startDataCleanup();

    app.listen(PORT, () => {
      console.log('\n════════════════════════════════════════════════════════════════');
      console.log('⚡ AURA GATEWAY v4.8 - THE SIGMA 14');
      console.log('════════════════════════════════════════════════════════════════');
      console.log(`📡 Server: http://0.0.0.0:${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`💾 Database: Railway PostgreSQL`);
      console.log(`🚀 Deployment: Replit`);
      console.log(`🔒 API Key: ${API_KEY.substring(0, 10)}...`);
      console.log(`⏰ Started: ${new Date().toISOString()}`);
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ SIGMA 14 FEATURES ACTIVE:');
      console.log('   1. ✅ Flexible SMS API (number/phone/to + message/text/msg/sms)');
      console.log('   2. ✅ Atomic Transactions (SELECT FOR UPDATE)');
      console.log('   3. ✅ Rate Limiting (3 SMS per minute)');
      console.log('   4. ✅ Admin Middleware Protection');
      console.log('   5. ✅ User Approval (5 free credits)');
      console.log('   6. ✅ Balance Management (Admin renew)');
      console.log('   7. ✅ User List (GET /api/users)');
      console.log('   8. ✅ Status Monitoring (key_status + sms_balance)');
      console.log('   9. ✅ Android Polling (GET /api/pending-sms) [Protected]');
      console.log('   10. ✅ Delivery Status (POST /api/status) [Protected]');
      console.log('   11. ✅ Device Health Monitoring [Protected]');
      console.log('   12. ✅ Robust Logging (req.body debug)');
      console.log('   13. ✅ Fail-Safe Startup (DB check)');
      console.log('   14. ✅ CORS + JSON 10mb');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('🧹 MAINTENANCE ROUTINES:');
      console.log('   - Rate limit cleanup: every 5 minutes');
      console.log('   - Data auto-cleanup: every 24 hours (15-day retention)');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ Server running successfully!\n');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  console.log('\n⚠️  SIGTERM - Closing gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️  SIGINT - Closing gracefully...');
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;
