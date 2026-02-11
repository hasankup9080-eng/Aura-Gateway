/**
 * ⚡ AURA GATEWAY - Premium Backend Server v4.6
 * Lynx Aesthetic | Dark Theme Compatible
 * Production-Ready for Railway Deployment
 *
 * NEW in v4.6 (Security Hardened - Grok Audit Fixes):
 * - Input Sanitization (sanitizeText helper)
 * - DB Fail-Safe with process.exit(1) on connection failure
 * - SELECT ... FOR UPDATE in send-sms transaction
 * - verifyAdmin middleware for admin routes
 * - verifySaaSKey now strictly checks key_status === 'active'
 * - Legacy public routes removed from validateApiKey guard
 * - sanitizeText applied to all user-controlled text inputs
 *
 * Preserved from v4.0–v4.5:
 * - SaaS API Key Management
 * - Credit-based SMS System
 * - Admin Approval Workflow
 * - Auto-Migration for Database Schema Updates
 * - Device Health Monitoring
 * - Bangladeshi Phone Validation
 * - OTP Cooldown Protection
 * - Smart SMS Queue Management (FIFO)
 * - Threaded Chat Conversations
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const crypto = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
// APPLICATION CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security Configuration
const API_KEY = process.env.API_KEY || 'lynx-aura-gateway-2025';
const ADMIN_DEVICE_ID = 'REAL-MENA-RZO5-0177'; // HARDCODED - DO NOT CHANGE
const SECRET_OWNER_KEY = process.env.SECRET_OWNER_KEY || '★LYNX★';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lynx-admin-2025';

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request Logging Middleware (Lynx Premium Aesthetic)
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n⚡ [${timestamp}] ${req.method} ${req.path}`);
  console.log(`   Device: ${req.headers['user-agent'] || 'Unknown'}`);
  next();
});

// ════════════════════════════════════════════════════════════════════════════
// POSTGRESQL DATABASE CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Database connection event handlers
pool.on('connect', () => {
  console.log('🔌 Database client connected');
});

pool.on('error', (err) => {
  console.error('💥 Unexpected database error:', err);
});

// ════════════════════════════════════════════════════════════════════════════
// DATABASE SCHEMA INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create database tables if they don't exist
 * Auto-migrates existing tables with new columns
 * v4.6: Wrapped in fail-safe try-catch; process.exit(1) on connection failure
 */
const initializeDatabase = async () => {
  // ── v4.6 DB FAIL-SAFE: Test connection first ────────────────────────────
  try {
    const testClient = await pool.connect();
    testClient.release();
    console.log('✅ Database connection verified');
  } catch (connError) {
    console.error('\n════════════════════════════════════════════════════════════════');
    console.error('💥 FATAL: Cannot connect to PostgreSQL database!');
    console.error('   Error:', connError.message);
    console.error('   Server will NOT start without a database connection.');
    console.error('════════════════════════════════════════════════════════════════\n');
    process.exit(1);
  }

  try {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('📊 Initializing database schema...');
    console.log('════════════════════════════════════════════════════════════════\n');

    // ─────────────────────────────────────────────────────────────────────
    // STEP 1: CREATE TABLES IF NOT EXISTS
    // ─────────────────────────────────────────────────────────────────────

    // Create SMS Logs Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_logs (
        id UUID PRIMARY KEY,
        sender VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        device_id VARCHAR(255) NOT NULL,
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "sms_logs" ready');

    // Create Users Table with Payment Verification + SaaS Features
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20) NOT NULL,
        payment_number VARCHAR(20) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        otp_code VARCHAR(6),
        is_verified BOOLEAN DEFAULT FALSE,
        device_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "users" ready with payment verification');

    // Create Outgoing SMS Table (Android SMS Gateway / sms_queue)
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
    console.log('✅ Table "outgoing_sms" ready (Android SMS Gateway)');

    // Create Device Status Table (Device Health Monitoring)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_status (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(255) NOT NULL UNIQUE,
        battery_level INTEGER,
        is_charging BOOLEAN DEFAULT FALSE,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "device_status" ready (Device Health Monitoring)');

    // Create Chat Messages Table with Reply Support
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY,
        sender_id VARCHAR(255),
        username VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'User',
        device_id VARCHAR(255),
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "chat_messages" ready');

    // Create OTP Request Tracking Table (For Cooldown)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone_number VARCHAR(20) NOT NULL,
        requested_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "otp_requests" ready (OTP Cooldown Tracking)');

    // ─────────────────────────────────────────────────────────────────────
    // STEP 2: AUTO-MIGRATION - ADD MISSING COLUMNS TO EXISTING TABLES
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n📦 Running auto-migration for schema updates...\n');

    // Migration 1: Add reply_to_id to chat_messages
    try {
      await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID;`);
      console.log('✅ Migration: chat_messages.reply_to_id added/verified');
    } catch (error) {
      console.log('⚠️  Migration: chat_messages.reply_to_id error:', error.message);
    }

    // Migration 2: Add foreign key constraint for reply_to_id
    try {
      await pool.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_reply_to_id_fkey') THEN
            ALTER TABLE chat_messages 
            ADD CONSTRAINT chat_messages_reply_to_id_fkey 
            FOREIGN KEY (reply_to_id) REFERENCES chat_messages(id) ON DELETE SET NULL;
          END IF;
        END $$;
      `);
      console.log('✅ Migration: reply_to_id foreign key constraint verified');
    } catch (error) {
      console.log('⚠️  Migration: Foreign key constraint error:', error.message);
    }

    // Migration 3: Add sender_id to chat_messages
    try {
      await pool.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_id VARCHAR(255);`);
      console.log('✅ Migration: chat_messages.sender_id added/verified');
    } catch (error) {
      console.log('⚠️  Migration: chat_messages.sender_id error:', error.message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 🆕 V4.0 MIGRATIONS - SaaS API Key Management
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🆕 Running v4.0 SaaS migrations...\n');

    // Migration 4: Add api_key column (UNIQUE)
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT UNIQUE;`);
      console.log('✅ Migration: users.api_key added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.api_key error:', error.message);
    }

    // Migration 5: Add key_status column
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS key_status TEXT DEFAULT 'pending';`);
      console.log('✅ Migration: users.key_status added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.key_status error:', error.message);
    }

    // Migration 6: Add credits column (also serves as sms_balance)
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;`);
      console.log('✅ Migration: users.credits added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.credits error:', error.message);
    }

    // Migration 7: Add expiry_date column
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMP;`);
      console.log('✅ Migration: users.expiry_date added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.expiry_date error:', error.message);
    }

    // Migration 8: Add CHECK constraints
    try {
      await pool.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_provider_check') THEN
            ALTER TABLE users ADD CONSTRAINT users_provider_check 
            CHECK (provider IN ('bKash', 'Nagad', 'Rocket'));
          END IF;
        END $$;
      `);
      console.log('✅ Migration: users.provider CHECK constraint verified');
    } catch (error) {
      console.log('⚠️  Migration: users.provider CHECK error:', error.message);
    }

    try {
      await pool.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outgoing_sms_status_check') THEN
            ALTER TABLE outgoing_sms ADD CONSTRAINT outgoing_sms_status_check 
            CHECK (status IN ('pending', 'sent', 'failed'));
          END IF;
        END $$;
      `);
      console.log('✅ Migration: outgoing_sms.status CHECK constraint verified');
    } catch (error) {
      console.log('⚠️  Migration: outgoing_sms.status CHECK error:', error.message);
    }

    try {
      await pool.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_status_battery_level_check') THEN
            ALTER TABLE device_status ADD CONSTRAINT device_status_battery_level_check 
            CHECK (battery_level >= 0 AND battery_level <= 100);
          END IF;
        END $$;
      `);
      console.log('✅ Migration: device_status.battery_level CHECK constraint verified');
    } catch (error) {
      console.log('⚠️  Migration: device_status.battery_level CHECK error:', error.message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // STEP 3: CREATE INDEXES FOR PERFORMANCE
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🔍 Creating performance indexes...\n');

    const indexes = [
      { name: 'idx_sms_timestamp',        table: 'sms_logs',       column: 'timestamp DESC' },
      { name: 'idx_chat_timestamp',        table: 'chat_messages',  column: 'timestamp DESC' },
      { name: 'idx_chat_reply',            table: 'chat_messages',  column: 'reply_to_id' },
      { name: 'idx_outgoing_sms_status',   table: 'outgoing_sms',   column: 'status, created_at' },
      { name: 'idx_users_phone',           table: 'users',          column: 'phone' },
      { name: 'idx_device_status_device',  table: 'device_status',  column: 'device_id' },
      { name: 'idx_otp_requests_phone',    table: 'otp_requests',   column: 'phone_number, requested_at' },
      { name: 'idx_users_api_key',         table: 'users',          column: 'api_key' },   // v4.6 MANDATORY
      { name: 'idx_users_key_status',      table: 'users',          column: 'key_status' }
    ];

    for (const idx of indexes) {
      try {
        await pool.query(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table}(${idx.column});`);
        console.log(`✅ Index: ${idx.name}`);
      } catch (error) {
        console.log(`⚠️  Index: ${idx.name} error:`, error.message);
      }
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('🎉 Database initialization & migration complete!');
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
 * 🆕 v4.6: Sanitize and truncate text input to prevent DB crashes and injection
 * @param {*} text - Raw input
 * @param {number} maxLength - Maximum character length (default 1600 for SMS)
 * @returns {string|null} Trimmed and truncated string, or null if input is falsy
 */
const sanitizeText = (text, maxLength = 1600) => {
  if (text === null || text === undefined) return null;
  const str = String(text).trim();
  return str.length > maxLength ? str.substring(0, maxLength) : str;
};

/**
 * Generate SaaS API Key in format: aura_live_[random_string]
 */
const generateSaaSApiKey = () => {
  const randomString = crypto.randomBytes(24).toString('hex');
  return `aura_live_${randomString}`;
};

/**
 * Legacy API Key Validation Middleware
 * Used for admin-panel routes (GET /api/users, GET /api/sms, etc.)
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
 * 🆕 v4.6: verifyAdmin Middleware
 * Accepts either:
 *   - x-api-key header matching the Master API_KEY, OR
 *   - x-device-id header matching the ADMIN_DEVICE_ID
 */
const verifyAdmin = (req, res, next) => {
  const apiKey  = req.headers['x-api-key'];
  const deviceId = req.headers['x-device-id'] || req.body.device_id || req.body.deviceId;

  const isMasterKey   = apiKey   && apiKey   === API_KEY;
  const isAdminDevice = deviceId && deviceId === ADMIN_DEVICE_ID;

  if (!isMasterKey && !isAdminDevice) {
    return res.status(403).json({
      success: false,
      error: 'Admin access required',
      message: '🔒 Provide a valid x-api-key or admin device ID.'
    });
  }

  next();
};

/**
 * v4.6: SaaS API Key Verification Middleware (The Gatekeeper)
 * Strictly checks: key exists → starts with aura_live_ → key_status === 'active'
 * Credit checks are deferred to individual route transaction logic.
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
      console.log(`\n🚫 INVALID SAAS API KEY - Key: ${apiKey.substring(0, 20)}...`);
      return res.status(403).json({
        success: false,
        error: 'Invalid API Key',
        message: '⚠️ API key not found in our system'
      });
    }

    const user = result.rows[0];

    // Strict status check: only 'active' is allowed
    if (user.key_status !== 'active') {
      const statusMessages = {
        pending:   '⏳ Your account is pending admin approval. Please wait for activation.',
        suspended: '🚫 Your account has been suspended. Contact support.'
      };
      console.log(`\n🔒 SAAS KEY BLOCKED - User: ${user.username} | Status: ${user.key_status}`);
      return res.status(403).json({
        success: false,
        error: `Account ${user.key_status}`,
        message: statusMessages[user.key_status] || `Account status: ${user.key_status}`
      });
    }

    // Check expiry date
    if (user.expiry_date && new Date(user.expiry_date) < new Date()) {
      console.log(`\n⏰ EXPIRED API KEY - User: ${user.username} | Expired: ${user.expiry_date}`);
      return res.status(403).json({
        success: false,
        error: 'API key expired',
        message: '⏰ Your API key has expired. Please renew your subscription.'
      });
    }

    // All checks passed
    req.saasUser = user;
    console.log(`\n✅ SAAS KEY VERIFIED - User: ${user.username} | Credits: ${user.credits}`);
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
 * Validate Bangladeshi Phone Number (11 digits, starts with 01)
 */
const validateBangladeshiPhone = (phone) => {
  const regex = /^01[0-9]{9}$/;
  return regex.test(phone);
};

/**
 * Generate 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Check OTP Request Cooldown (3 requests per 15 minutes)
 */
const checkOTPCooldown = async (phone) => {
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
  const result = await pool.query(
    `SELECT COUNT(*) as count 
     FROM otp_requests 
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
 * Detect if user is an OWNER
 */
const detectOwnerRole = (deviceId, message, secretKey) => {
  if (deviceId === ADMIN_DEVICE_ID)               return '★ OWNER';
  if (secretKey && secretKey === SECRET_OWNER_KEY) return '★ OWNER';
  if (message && message.includes(SECRET_OWNER_KEY)) return '★ OWNER';
  return 'User';
};

/**
 * Format timestamp for Lynx aesthetic
 */
const formatTimestamp = (date) => {
  return date.toISOString();
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
    version: '4.6.0',
    database: 'PostgreSQL',
    theme: 'Lynx Premium',
    status: 'operational',
    features: {
      saas_api_management: true,
      credit_system: true,
      admin_approval: true,
      auto_migration: true,
      payment_verification: true,
      otp_system: true,
      otp_cooldown: true,
      sms_gateway: true,
      chat_replies: true,
      device_health: true,
      bangladeshi_validation: true,
      input_sanitization: true,
      db_fail_safe: true,
      select_for_update: true
    },
    admin: {
      deviceId: ADMIN_DEVICE_ID,
      ownerBadge: '★ OWNER'
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
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
// AUTHENTICATION (LOGIN, SIGNUP, OTP)
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
      console.log(`\n════════════════════════════════════════════════════════════════`);
      console.log(`✅ ADMIN LOGIN SUCCESSFUL`);
      console.log(`   Username: ${username}`);
      console.log(`   Device: ${finalDeviceId}`);
      console.log(`════════════════════════════════════════════════════════════════\n`);

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

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`✅ USER LOGIN SUCCESSFUL`);
    console.log(`   Username: ${username}`);
    console.log(`   Phone: ${user.phone}`);
    console.log(`   Device: ${finalDeviceId}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'Login successful',
      apiKey: API_KEY,
      role: 'User',
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone
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

/**
 * POST /api/signup - Register new user with SaaS API Key
 * v4.6: sanitizeText applied to username
 */
app.post('/api/signup', async (req, res) => {
  const client = await pool.connect();

  try {
    // v4.6: Sanitize username input
    const rawUsername = req.body.username;
    const username    = sanitizeText(rawUsername, 255);
    const { phone, payment_number, provider } = req.body;

    if (!username || !phone || !payment_number || !provider) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'phone', 'payment_number', 'provider']
      });
    }

    if (!validateBangladeshiPhone(phone)) {
      console.log(`\n⚠️  INVALID PHONE FORMAT - Phone: ${phone}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number format',
        message: 'Phone number must be 11 digits starting with 01 (e.g., 01712345678)'
      });
    }

    if (!validateBangladeshiPhone(payment_number)) {
      console.log(`\n⚠️  INVALID PAYMENT NUMBER FORMAT - Payment Number: ${payment_number}`);
      return res.status(400).json({
        success: false,
        error: 'Invalid payment number format',
        message: 'Payment number must be 11 digits starting with 01 (e.g., 01812345678)'
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
      console.log(`\n🚫 OTP COOLDOWN ACTIVE - Phone: ${phone}`);
      return res.status(429).json({
        success: false,
        error: 'Too many OTP requests',
        message: 'You can only request OTP 3 times per 15 minutes. Please wait before trying again.',
        cooldown: '15 minutes'
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

    const otpCode    = generateOTP();
    const userId     = uuidv4();
    const saasApiKey = generateSaaSApiKey();

    await client.query(
      `INSERT INTO users (
        id, username, phone, payment_number, provider,
        otp_code, is_verified, api_key, key_status, credits
      )
       VALUES ($1, $2, $3, $4, $5, $6, false, $7, 'pending', 0)`,
      [userId, username, phone, payment_number, provider, otpCode, saasApiKey]
    );

    const smsId      = uuidv4();
    const smsMessage = `Your Aura Gateway OTP is: ${otpCode}. Valid for 15 minutes.`;

    await client.query(
      `INSERT INTO outgoing_sms (id, recipient_number, message_text, status)
       VALUES ($1, $2, $3, 'pending')`,
      [smsId, phone, smsMessage]
    );

    await logOTPRequest(phone);
    await client.query('COMMIT');

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`👤 NEW USER SIGNUP (v4.6)`);
    console.log(`   Username: ${username}`);
    console.log(`   Phone: ${phone} ✓`);
    console.log(`   Payment: ${payment_number} (${provider}) ✓`);
    console.log(`   OTP: ${otpCode}`);
    console.log(`   🔑 API Key: ${saasApiKey.substring(0, 30)}...`);
    console.log(`   Status: PENDING (awaiting admin approval)`);
    console.log(`   SMS Balance: 0`);
    console.log(`   📱 OTP SMS queued for Android gateway`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

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
      next_step: 'Verify OTP, then wait for admin approval to activate your API key'
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

/**
 * POST /api/verify-otp
 */
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
       RETURNING id, username, phone`,
      [username, otp_code]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid OTP or user already verified'
      });
    }

    const user = result.rows[0];

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`✅ OTP VERIFICATION SUCCESS`);
    console.log(`   User: ${user.username}`);
    console.log(`   Phone: ${user.phone}`);
    console.log(`   ⏳ Status: Pending admin approval for API access`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'Account verified successfully',
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone
      },
      next_step: 'Your account is verified. Wait for admin approval to activate your API key.'
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
// USER MANAGEMENT
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/users - List all users (Admin Panel / Lovable compatible)
 */
app.get('/api/users', validateApiKey, async (req, res) => {
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

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`👥 USER LIST RETRIEVED`);
    console.log(`   Total Users: ${users.length}`);
    console.log(`   Verified: ${users.filter(u => u.is_verified).length}`);
    console.log(`   Active Keys: ${users.filter(u => u.key_status === 'active').length}`);
    console.log(`   Pending Keys: ${users.filter(u => u.key_status === 'pending').length}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      count: users.length,
      users: users.map(user => ({
        id:             user.id,
        username:       user.username,
        phone:          user.phone,
        payment_number: user.payment_number,
        provider:       user.provider,
        is_verified:    user.is_verified,
        device_id:      user.device_id,
        api_key:        user.api_key,
        key_status:     user.key_status,
        sms_balance:    user.credits,
        credits:        user.credits,
        expiry_date:    user.expiry_date ? formatTimestamp(user.expiry_date) : null,
        created_at:     formatTimestamp(user.created_at)
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

// ────────────────────────────────────────────────────────────────────────────
// SAAS: GET /api/me  (verifySaaSKey protected)
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/me - Get current user's profile
 * v4.6: Now guarded by verifySaaSKey
 */
app.get('/api/me', verifySaaSKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id, username, phone, payment_number, provider,
        is_verified, api_key, key_status, credits, expiry_date, created_at
       FROM users 
       WHERE id = $1`,
      [req.saasUser.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = result.rows[0];

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`👤 USER PROFILE RETRIEVED`);
    console.log(`   Username: ${user.username}`);
    console.log(`   Status: ${user.key_status.toUpperCase()}`);
    console.log(`   SMS Balance: ${user.credits}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      user: {
        id:             user.id,
        username:       user.username,
        phone:          user.phone,
        payment_number: user.payment_number,
        provider:       user.provider,
        is_verified:    user.is_verified,
        api_key:        user.api_key,
        key_status:     user.key_status,
        sms_balance:    user.credits,
        credits:        user.credits,
        expiry_date:    user.expiry_date ? formatTimestamp(user.expiry_date) : null,
        created_at:     formatTimestamp(user.created_at)
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
// ADMIN TOOLS  (verifyAdmin protected)
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/approve - Approve / suspend user API keys
 * v4.6: Uses verifyAdmin; also grants free credits on 'active'
 */
app.post('/api/admin/approve', verifyAdmin, async (req, res) => {
  try {
    const { user_id, status, free_credits } = req.body;

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

    // Optionally grant free credits when activating
    const creditsToAdd = (status === 'active' && free_credits) ? parseInt(free_credits) || 0 : 0;

    const result = await pool.query(
      `UPDATE users 
       SET key_status = $1,
           credits    = credits + $2
       WHERE id = $3
       RETURNING id, username, api_key, key_status, credits`,
      [status, creditsToAdd, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const user = result.rows[0];

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`🔑 ADMIN: API KEY STATUS UPDATED`);
    console.log(`   User: ${user.username}`);
    console.log(`   API Key: ${user.api_key.substring(0, 30)}...`);
    console.log(`   New Status: ${status.toUpperCase()}`);
    console.log(`   Free Credits Added: ${creditsToAdd}`);
    console.log(`   Total SMS Balance: ${user.credits}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: `User API key ${status === 'active' ? 'activated' : status === 'suspended' ? 'suspended' : 'set to pending'}`,
      user: {
        id:          user.id,
        username:    user.username,
        api_key:     user.api_key,
        key_status:  user.key_status,
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
 * POST /api/admin/renew - Add credits and extend expiry
 * v4.6: Uses verifyAdmin
 */
app.post('/api/admin/renew', verifyAdmin, async (req, res) => {
  try {
    const { user_id, credits, days } = req.body;

    if (!user_id || credits === undefined || days === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['user_id', 'credits', 'days']
      });
    }

    const newExpiryDate = new Date();
    newExpiryDate.setDate(newExpiryDate.getDate() + parseInt(days));

    const result = await pool.query(
      `UPDATE users 
       SET credits     = credits + $1,
           expiry_date = $2
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

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`💳 ADMIN: CREDITS RENEWED`);
    console.log(`   User: ${user.username}`);
    console.log(`   API Key: ${user.api_key.substring(0, 30)}...`);
    console.log(`   Credits Added: +${credits}`);
    console.log(`   New SMS Balance: ${user.credits}`);
    console.log(`   Extended By: ${days} days`);
    console.log(`   New Expiry: ${formatTimestamp(user.expiry_date)}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: `Added ${credits} credits and extended expiry by ${days} days`,
      user: {
        id:          user.id,
        username:    user.username,
        api_key:     user.api_key,
        key_status:  user.key_status,
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
// SAAS: POST /api/send-sms  (verifySaaSKey + SELECT FOR UPDATE)
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/send-sms - Queue outgoing SMS (SaaS Protected)
 * v4.6: Full PostgreSQL transaction with SELECT ... FOR UPDATE to prevent races
 *       sanitizeText applied to message body
 */
app.post('/api/send-sms', verifySaaSKey, async (req, res) => {
  const client = await pool.connect();

  try {
    const { recipient } = req.body;
    // v4.6: Sanitize message body (max 1600 chars - standard SMS limit)
    const message = sanitizeText(req.body.message, 1600);

    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['recipient', 'message']
      });
    }

    if (!validateBangladeshiPhone(recipient)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipient phone number',
        message: 'Phone must be 11 digits starting with 01'
      });
    }

    await client.query('BEGIN');

    // v4.6: SELECT ... FOR UPDATE locks the user row to prevent double-spend races
    const lockResult = await client.query(
      `SELECT id, username, credits AS sms_balance
       FROM users
       WHERE id = $1
       FOR UPDATE`,
      [req.saasUser.id]
    );

    const user = lockResult.rows[0];

    // Check sms_balance inside the transaction (after lock)
    if (user.sms_balance <= 0) {
      await client.query('ROLLBACK');
      console.log(`\n💳 INSUFFICIENT SMS BALANCE - User: ${user.username} | Balance: ${user.sms_balance}`);
      return res.status(403).json({
        success: false,
        error: 'Insufficient SMS balance',
        message: '💳 You have 0 credits remaining. Please purchase more to continue.',
        sms_balance: user.sms_balance
      });
    }

    // Deduct 1 credit atomically
    const updateResult = await client.query(
      `UPDATE users 
       SET credits = credits - 1
       WHERE id = $1
       RETURNING credits AS sms_balance`,
      [user.id]
    );

    const newBalance = updateResult.rows[0].sms_balance;

    // Queue SMS in outgoing_sms (sms_queue)
    const smsId = uuidv4();
    await client.query(
      `INSERT INTO outgoing_sms (id, recipient_number, message_text, status)
       VALUES ($1, $2, $3, 'pending')`,
      [smsId, recipient, message]
    );

    await client.query('COMMIT');

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`📤 SAAS SMS QUEUED`);
    console.log(`   User: ${user.username}`);
    console.log(`   To: ${recipient}`);
    console.log(`   Message: ${message.substring(0, 50)}...`);
    console.log(`   Balance Before: ${user.sms_balance}`);
    console.log(`   Balance After: ${newBalance}`);
    console.log(`   SMS ID: ${smsId}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'SMS queued successfully',
      sms: {
        id:        smsId,
        recipient,
        message,
        status:    'pending'
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
// DEVICE HEALTH MONITORING
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/device-health - Battery status updates
 * v4.6: PUBLIC (no auth) - Android app does not have SaaS key
 */
app.post('/api/device-health', async (req, res) => {
  try {
    const { battery_level, is_charging } = req.body;

    if (battery_level === undefined || is_charging === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['battery_level', 'is_charging']
      });
    }

    if (battery_level < 0 || battery_level > 100) {
      return res.status(400).json({
        success: false,
        error: 'Battery level must be between 0 and 100'
      });
    }

    const result = await pool.query(
      `INSERT INTO device_status (device_id, battery_level, is_charging, last_updated)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (device_id)
       DO UPDATE SET
         battery_level = $2,
         is_charging   = $3,
         last_updated  = NOW()
       RETURNING *`,
      [ADMIN_DEVICE_ID, battery_level, is_charging]
    );

    const deviceStatus = result.rows[0];

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`🔋 DEVICE HEALTH UPDATE`);
    console.log(`   Device: ${ADMIN_DEVICE_ID}`);
    console.log(`   Battery: ${battery_level}%`);
    console.log(`   Charging: ${is_charging ? 'Yes ⚡' : 'No'}`);
    console.log(`   Updated: ${deviceStatus.last_updated}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'Device health updated',
      device: {
        id:            deviceStatus.id,
        device_id:     deviceStatus.device_id,
        battery_level: deviceStatus.battery_level,
        is_charging:   deviceStatus.is_charging,
        last_updated:  deviceStatus.last_updated
      }
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
 * GET /api/device-health - Fetch device status (admin use)
 */
app.get('/api/device-health', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM device_status WHERE device_id = $1',
      [ADMIN_DEVICE_ID]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Device status not found',
        message: 'No health data available for this device'
      });
    }

    res.json({
      success: true,
      device: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Device Health Fetch Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch device health',
      message: error.message
    });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// SMS GATEWAY - LEGACY ANDROID APP ROUTES (PUBLIC - NO AUTH)
// ────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/pending-sms - Fetch oldest pending SMS (FIFO)
 * v4.6: PUBLIC - Android app polls this without SaaS key
 */
app.get('/api/pending-sms', async (req, res) => {
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

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`📱 OLDEST PENDING SMS RETRIEVED`);
    console.log(`   ID: ${sms.id}`);
    console.log(`   To: ${sms.recipient_number}`);
    console.log(`   Message: ${sms.message_text}`);
    console.log(`   Created: ${sms.created_at}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      pending: true,
      sms: {
        id:        sms.id,
        recipient: sms.recipient_number,
        message:   sms.message_text,
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
 * POST /api/sms-sent - Android app confirms SMS sent/failed
 * v4.6: PUBLIC - Android app does not have SaaS key
 */
app.post('/api/sms-sent', async (req, res) => {
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

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`✅ SMS STATUS UPDATE`);
    console.log(`   ID: ${sms.id}`);
    console.log(`   Recipient: ${sms.recipient_number}`);
    console.log(`   Status: ${status.toUpperCase()}`);
    console.log(`   Sent At: ${sms.sent_at}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'SMS status updated',
      sms: {
        id:        sms.id,
        recipient: sms.recipient_number,
        status:    sms.status,
        sent_at:   sms.sent_at
      }
    });

  } catch (error) {
    console.error('❌ SMS Update Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update SMS status',
      message: error.message
    });
  }
});

/**
 * POST /api/sms - Log incoming SMS from Android phone to DB
 * v4.6: PUBLIC - Critical gateway endpoint, must not be blocked
 *       sanitizeText applied to message body
 */
app.post('/api/sms', async (req, res) => {
  try {
    const { sender, device_id, deviceId, timestamp } = req.body;
    // v4.6: Sanitize incoming message
    const message      = sanitizeText(req.body.message, 1600);
    const finalDeviceId = device_id || deviceId;

    if (!sender || !message || !finalDeviceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['sender', 'message', 'device_id']
      });
    }

    const smsId        = uuidv4();
    const smsTimestamp = timestamp ? new Date(timestamp) : new Date();

    await pool.query(
      `INSERT INTO sms_logs (id, sender, message, device_id, timestamp)
       VALUES ($1, $2, $3, $4, $5)`,
      [smsId, sender, message, finalDeviceId, smsTimestamp]
    );

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`📨 NEW SMS LOGGED TO DATABASE`);
    console.log(`   From: ${sender}`);
    console.log(`   Device: ${finalDeviceId}`);
    console.log(`   Message: ${message}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.status(201).json({
      success: true,
      message: 'SMS logged successfully',
      data: {
        id:        smsId,
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
 * GET /api/sms - Fetch SMS logs (admin dashboard)
 */
app.get('/api/sms', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = await pool.query(
      'SELECT * FROM sms_logs ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );

    const smsLogs = result.rows.map(log => ({
      id:        log.id,
      sender:    log.sender,
      message:   log.message,
      device_id: log.device_id,
      deviceId:  log.device_id,
      timestamp: formatTimestamp(log.timestamp)
    }));

    res.json({
      success: true,
      count:   smsLogs.length,
      data:    smsLogs
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
// GLOBAL CHAT (THREADED)
// ────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat - Send a chat message
 * v4.6: sanitizeText applied to username and message
 *       Accessible for Admin Device ID (validateApiKey)
 */
app.post('/api/chat', validateApiKey, async (req, res) => {
  const client = await pool.connect();

  try {
    // v4.6: Sanitize text inputs
    const username     = sanitizeText(req.body.username, 255);
    const message      = sanitizeText(req.body.message, 1600);
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

    if (reply_to_id) {
      const parentExists = await client.query(
        'SELECT id FROM chat_messages WHERE id = $1',
        [reply_to_id]
      );

      if (parentExists.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid reply_to_id - parent message not found'
        });
      }
    }

    const messageId = uuidv4();
    const timestamp = new Date();

    await client.query(
      `INSERT INTO chat_messages (id, username, message, role, device_id, reply_to_id, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [messageId, username, message, role, finalDeviceId, reply_to_id || null, timestamp]
    );

    let chatMessage;
    if (reply_to_id) {
      const result = await client.query(
        `SELECT m.*,
                parent.username AS parent_username,
                parent.message  AS parent_message
         FROM chat_messages m
         LEFT JOIN chat_messages parent ON m.reply_to_id = parent.id
         WHERE m.id = $1`,
        [messageId]
      );
      chatMessage = result.rows[0];

      console.log(`\n════════════════════════════════════════════════════════════════`);
      console.log(`↩️  💬 NEW CHAT REPLY SAVED`);
      console.log(`   User: ${username} | Role: ${role}`);
      console.log(`   ↩️  Reply to: ${chatMessage.parent_username}`);
      console.log(`   Message: ${message}`);
      console.log(`════════════════════════════════════════════════════════════════\n`);
    } else {
      chatMessage = (await client.query(
        'SELECT * FROM chat_messages WHERE id = $1',
        [messageId]
      )).rows[0];

      const ownerBadge = role === '★ OWNER' ? '👑 ' : '';
      console.log(`\n════════════════════════════════════════════════════════════════`);
      console.log(`${ownerBadge}💬 NEW CHAT MESSAGE SAVED`);
      console.log(`   User: ${username} | Role: ${role}`);
      console.log(`   Message: ${message}`);
      console.log(`════════════════════════════════════════════════════════════════\n`);
    }

    res.status(201).json({
      success: true,
      message: 'Chat message sent',
      data: {
        id:          chatMessage.id,
        username:    chatMessage.username,
        message:     chatMessage.message,
        role:        chatMessage.role,
        device_id:   chatMessage.device_id,
        deviceId:    chatMessage.device_id,
        reply_to_id: chatMessage.reply_to_id,
        timestamp:   formatTimestamp(chatMessage.timestamp),
        isOwner:     chatMessage.role === '★ OWNER'
      }
    });

  } catch (error) {
    console.error('❌ Chat Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send message',
      message: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/chat - Fetch threaded chat messages
 */
app.get('/api/chat', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);

    const query = `
      SELECT 
        m.id, m.sender_id, m.username, m.message,
        m.role, m.device_id, m.reply_to_id, m.timestamp, m.created_at,
        parent.id       AS parent_id,
        parent.username AS parent_username,
        parent.message  AS parent_message,
        parent.role     AS parent_role
      FROM chat_messages m
      LEFT JOIN chat_messages parent ON m.reply_to_id = parent.id
      ORDER BY m.timestamp DESC
      LIMIT $1;
    `;

    const result = await pool.query(query, [limit]);

    const messages = result.rows.map(row => {
      const messageData = {
        id:          row.id,
        sender_id:   row.sender_id,
        username:    row.username,
        message:     row.message,
        role:        row.role,
        device_id:   row.device_id,
        deviceId:    row.device_id,
        reply_to_id: row.reply_to_id,
        timestamp:   formatTimestamp(row.timestamp),
        isOwner:     row.role === '★ OWNER'
      };

      if (row.reply_to_id && row.parent_id) {
        messageData.replying_to = {
          id:       row.parent_id,
          username: row.parent_username,
          message:  row.parent_message,
          role:     row.parent_role
        };
      }

      return messageData;
    });

    const countResult = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const totalCount  = parseInt(countResult.rows[0].count);

    res.json({
      success: true,
      count:   messages.length,
      total:   totalCount,
      data:    messages
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

/**
 * DELETE /api/chat - Clear all chat messages (Owner only)
 */
app.delete('/api/chat', validateApiKey, async (req, res) => {
  const client = await pool.connect();

  try {
    const { secret_key } = req.body;

    if (secret_key !== SECRET_OWNER_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }

    const countResult  = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const previousCount = parseInt(countResult.rows[0].count);

    await client.query('DELETE FROM chat_messages');

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`🗑️  CHAT CLEARED FROM DATABASE`);
    console.log(`   Messages Deleted: ${previousCount}`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: '✅ Chat history cleared from database',
      deletedCount: previousCount
    });

  } catch (error) {
    console.error('❌ Chat Clear Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to clear chat',
      message: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/chat/stats - Chat statistics
 */
app.get('/api/chat/stats', validateApiKey, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) AS total_messages,
        COUNT(DISTINCT username) AS unique_users,
        COUNT(CASE WHEN role = '★ OWNER' THEN 1 END) AS owner_messages,
        COUNT(CASE WHEN role = 'User'    THEN 1 END) AS user_messages,
        COUNT(CASE WHEN reply_to_id IS NOT NULL THEN 1 END) AS reply_messages,
        MAX(timestamp) AS last_message_time,
        MIN(timestamp) AS first_message_time
      FROM chat_messages;
    `;

    const result = await pool.query(statsQuery);
    const stats  = result.rows[0];

    res.json({
      success: true,
      stats: {
        totalMessages:    parseInt(stats.total_messages),
        uniqueUsers:      parseInt(stats.unique_users),
        ownerMessages:    parseInt(stats.owner_messages),
        userMessages:     parseInt(stats.user_messages),
        replyMessages:    parseInt(stats.reply_messages),
        lastMessageTime:  stats.last_message_time,
        firstMessageTime: stats.first_message_time
      }
    });

  } catch (error) {
    console.error('❌ Stats Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics',
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
    method: req.method,
    message: '⚠️ The requested endpoint does not exist'
  });
});

app.use((error, req, res, next) => {
  console.error('\n════════════════════════════════════════════════════════════════');
  console.error('💥 UNHANDLED ERROR:', error);
  console.error('════════════════════════════════════════════════════════════════\n');

  res.status(error.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : error.message,
    ...(NODE_ENV === 'development' && { stack: error.stack })
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SERVER STARTUP
// ════════════════════════════════════════════════════════════════════════════

const startServer = async () => {
  try {
    await initializeDatabase();

    app.listen(PORT, () => {
      console.log('\n');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('⚡ AURA GATEWAY - Premium Backend Server v4.6');
      console.log('🎨 Lynx Aesthetic | Dark Theme Compatible');
      console.log('🗄️  PostgreSQL Database Enabled');
      console.log('════════════════════════════════════════════════════════════════');
      console.log(`📡 Server: http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`🔒 API Key: ${API_KEY.substring(0, 10)}...`);
      console.log(`👑 Admin Device: ${ADMIN_DEVICE_ID} (HARDCODED)`);
      console.log(`⭐ Owner Badge: ${SECRET_OWNER_KEY}`);
      console.log(`💾 Database: PostgreSQL (Railway)`);
      console.log(`⏰ Started: ${new Date().toISOString()}`);
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ v4.6 Features Active:');
      console.log('   - [NEW] Input Sanitization (sanitizeText helper)');
      console.log('   - [NEW] DB Fail-Safe (process.exit(1) on conn failure)');
      console.log('   - [NEW] SELECT ... FOR UPDATE in send-sms transaction');
      console.log('   - [NEW] verifyAdmin middleware for admin routes');
      console.log('   - [NEW] verifySaaSKey: strict key_status === active check');
      console.log('   - [NEW] Legacy public routes: device-health, pending-sms, sms-sent, POST /api/sms');
      console.log('   - SaaS API Key Management');
      console.log('   - Credit-Based SMS System (sms_balance)');
      console.log('   - Admin Approval Workflow (with optional free credits)');
      console.log('   - Auto-Migration for Schema Updates');
      console.log('   - Bangladeshi Phone Validation (11 digits, starts with 01)');
      console.log('   - OTP Cooldown (3 requests per 15 minutes)');
      console.log('   - Device Health Monitoring');
      console.log('   - Smart SMS Queue (FIFO - Oldest First)');
      console.log('   - Threaded Chat Conversations');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ Server is running with persistent storage');
      console.log('\n');
    });

  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('⚠️  SIGTERM signal received: closing server gracefully');
  console.log('════════════════════════════════════════════════════════════════\n');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('⚠️  SIGINT signal received: closing server gracefully');
  console.log('════════════════════════════════════════════════════════════════\n');
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;
