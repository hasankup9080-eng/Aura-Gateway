/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚡ AURA GATEWAY v5.2 - GLOBAL CHAT UPGRADE (Telegram-Style)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🎯 WHAT'S NEW IN v5.2:
 *
 * 1. CHAT SCHEMA UPGRADE:
 *    - New column: sender_role (VARCHAR(50), default 'user')
 *    - New column: reply_preview (TEXT, nullable)
 *    - reply_to_id already existed — now validated against DB before save
 *
 * 2. ZERO-CREDIT GLOBAL CHAT:
 *    - POST /api/chat NEVER reads or writes users.credits / api_credits
 *    - Global Chat is 100% free — explicit guard added in route code
 *
 * 3. UNIFIED REPLY SYSTEM:
 *    - Accepts replyToId and senderRole from req.body
 *    - Looks up parent message, slices 100-char reply_preview, saves it
 *    - Invalid/deleted parent is silently ignored (UX-safe)
 *    - GET /api/chat returns reply_preview + sender_role on every row
 *    - COALESCE fallback so old messages still render reply context
 *
 * 4. ZERO REGRESSION:
 *    - All v5.1 features preserved (phone validation, email OTP, VPN detect)
 *    - All 17+ endpoints untouched except the 3 /api/chat handlers
 *    - Scrypt hashing, atomic transactions, rate limits all intact
 *
 * Production-Ready | Railway Optimized | PostgreSQL
 * Last Updated: 2026
 * ═══════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const nodemailer = require('nodemailer');
const phoneUtil = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const PNF = require('google-libphonenumber').PhoneNumberFormat;
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const API_KEY = process.env.API_KEY || 'lynx-aura-gateway-2025';
const ADMIN_DEVICE_ID = 'REAL-MENA-RZO5-0177';
const SECRET_OWNER_KEY = process.env.SECRET_OWNER_KEY || '★LYNX★';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lynx-admin-2025';

// Email Configuration (Gmail)
const EMAIL_CONFIG = {
  user: process.env.GMAIL_USER, // Your Gmail address
  pass: process.env.GMAIL_PASS  // Gmail App Password (not regular password)
};

// Rate Limiting Config
const RATE_LIMITS = {
  OTP_REQUESTS: 3,
  OTP_WINDOW_MINUTES: 15,
  LOGIN_ATTEMPTS: 5,
  LOGIN_WINDOW_MINUTES: 15,
  SIGNUP_PER_IP_PER_DAY: 3
};

// VPN Detection Config
const VPN_DETECTION = {
  enabled: process.env.VPN_DETECTION_ENABLED !== 'false',
  api: 'http://ip-api.com/json/',
  timeout: 5000
};

// ═══════════════════════════════════════════════════════════════════════════
// 🚦 RATE LIMITING MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IP-based signup rate limiter
 * Max 3 signups per IP per day
 */
const signupRateLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: RATE_LIMITS.SIGNUP_PER_IP_PER_DAY,
  message: {
    success: false,
    error: 'Too many signups from this IP',
    message: `Maximum ${RATE_LIMITS.SIGNUP_PER_IP_PER_DAY} account creations per day from one IP address. Please try again tomorrow.`
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log(`\n🚫 SIGNUP RATE LIMIT EXCEEDED`);
    console.log(`   IP: ${req.ip}`);
    console.log(`   Limit: ${RATE_LIMITS.SIGNUP_PER_IP_PER_DAY} signups/day`);

    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded',
      message: `Maximum ${RATE_LIMITS.SIGNUP_PER_IP_PER_DAY} account creations per day from one IP address.`,
      retry_after: '24 hours'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ VPN/PROXY DETECTION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect VPN/Proxy/Datacenter IPs and block them
 * Uses ip-api.com free API
 */
const detectVPN = async (req, res, next) => {
  if (!VPN_DETECTION.enabled) {
    return next();
  }

  try {
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

    // Skip localhost and private IPs
    if (clientIP === '::1' || clientIP === '127.0.0.1' || clientIP.startsWith('192.168.') || clientIP.startsWith('10.')) {
      console.log(`\n✅ VPN CHECK SKIPPED (Local IP): ${clientIP}`);
      return next();
    }

    console.log(`\n🔍 VPN DETECTION CHECK`);
    console.log(`   IP: ${clientIP}`);

    // Query ip-api.com
    const response = await axios.get(
      `${VPN_DETECTION.api}${clientIP}?fields=status,proxy,hosting,query`,
      { timeout: VPN_DETECTION.timeout }
    );

    const data = response.data;

    console.log(`   Status: ${data.status}`);
    console.log(`   Proxy: ${data.proxy}`);
    console.log(`   Hosting: ${data.hosting}`);

    // Block if VPN/Proxy/Datacenter detected
    if (data.proxy === true || data.hosting === true) {
      console.log(`\n🚫 VPN/PROXY DETECTED - BLOCKED`);
      console.log(`   IP: ${clientIP}`);
      console.log(`   Type: ${data.proxy ? 'Proxy/VPN' : 'Datacenter/Hosting'}`);

      return res.status(403).json({
        success: false,
        error: 'VPN/Proxy detected',
        message: '🚫 VPNs, Proxies, and Datacenter IPs are not allowed. Please use a residential IP address.',
        ip: clientIP
      });
    }

    console.log(`   ✅ Clean IP - Allowed`);
    next();

  } catch (error) {
    console.error('⚠️  VPN Detection Error:', error.message);
    // On API error, allow request (fail-open for availability)
    console.log('   ⚠️  Allowing request (VPN API unavailable)');
    next();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 📧 EMAIL CONFIGURATION (Nodemailer)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create Nodemailer transporter with Gmail
 * Uses Gmail App Password (not regular password)
 */
const createEmailTransporter = () => {
  if (!EMAIL_CONFIG.user || !EMAIL_CONFIG.pass) {
    console.warn('⚠️  Email credentials not configured. Set GMAIL_USER and GMAIL_PASS in .env');
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_CONFIG.user,
      pass: EMAIL_CONFIG.pass
    }
  });
};

/**
 * Generate professional HTML email template for OTP
 * @param {string} otp - 6-digit OTP code
 * @param {string} username - User's username
 * @returns {string} - HTML email content
 */
const generateOTPEmailHTML = (otp, username) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Aura Gateway OTP Code</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f4f4;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f4f4f4; padding: 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
          
          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">
                ⚡ Aura Gateway
              </h1>
              <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.9;">
                Secure SMS Gateway Platform
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="margin: 0 0 20px 0; color: #333333; font-size: 24px; font-weight: 600;">
                Hello, ${username}!
              </h2>
              
              <p style="margin: 0 0 20px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                Thank you for registering with <strong>Aura Gateway</strong>. To complete your registration, please use the verification code below:
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td align="center" style="background-color: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 30px;">
                    <p style="margin: 0 0 10px 0; color: #666666; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">
                      Your Verification Code
                    </p>
                    <p style="margin: 0; color: #667eea; font-size: 42px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                      ${otp}
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 15px 0; color: #666666; font-size: 14px; line-height: 1.6;">
                <strong>⏰ This code will expire in 15 minutes.</strong>
              </p>

              <p style="margin: 0 0 15px 0; color: #666666; font-size: 14px; line-height: 1.6;">
                If you didn't request this code, please ignore this email or contact our support team.
              </p>

              <!-- Warning Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 25px 0;">
                <tr>
                  <td style="background-color: #fff3cd; border-left: 4px solid #ffc107; border-radius: 4px; padding: 15px;">
                    <p style="margin: 0; color: #856404; font-size: 13px; line-height: 1.5;">
                      <strong>🔒 Security Note:</strong> Never share this code with anyone. Aura Gateway staff will never ask for your OTP code.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
              <p style="margin: 0 0 10px 0; color: #999999; font-size: 12px;">
                © 2026 Aura Gateway. All rights reserved.
              </p>
              <p style="margin: 0; color: #999999; font-size: 12px;">
                Professional SMS Gateway Platform for Businesses
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};

/**
 * Send OTP email
 * @param {string} email - Recipient email
 * @param {string} otp - 6-digit OTP
 * @param {string} username - Username
 * @returns {Promise<boolean>} - True if sent successfully
 */
const sendOTPEmail = async (email, otp, username) => {
  const transporter = createEmailTransporter();

  if (!transporter) {
    console.error('❌ Email transporter not configured');
    return false;
  }

  try {
    const mailOptions = {
      from: {
        name: 'Aura Gateway',
        address: EMAIL_CONFIG.user
      },
      to: email,
      subject: `Your Aura Gateway Verification Code: ${otp}`,
      html: generateOTPEmailHTML(otp, username),
      text: `Hello ${username},\n\nYour Aura Gateway verification code is: ${otp}\n\nThis code will expire in 15 minutes.\n\nIf you didn't request this code, please ignore this email.\n\nBest regards,\nAura Gateway Team`
    };

    const info = await transporter.sendMail(mailOptions);

    console.log(`\n📧 EMAIL SENT SUCCESSFULLY`);
    console.log(`   To: ${email}`);
    console.log(`   Message ID: ${info.messageId}`);

    return true;
  } catch (error) {
    console.error('❌ Email Send Error:', error);
    return false;
  }
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request Logging Middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`\n⚡ [${timestamp}] ${req.method} ${req.path}`);
  console.log(`   IP: ${req.ip || 'Unknown'}`);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// 🗄️ DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => console.log('🔌 Database connected'));
pool.on('error', (err) => console.error('💥 Database error:', err));

// ═══════════════════════════════════════════════════════════════════════════
// 📊 DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize database schema with v5.2 migrations
 */
const initDatabase = async () => {
  try {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('📊 Initializing database schema (v5.2 Global Chat Upgrade)...');
    console.log('════════════════════════════════════════════════════════════════\n');

    // CREATE TABLES (existing tables — unchanged)
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        phone VARCHAR(20) NOT NULL UNIQUE,
        payment_number VARCHAR(20) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        password_hash TEXT,
        password_salt TEXT,
        otp_code VARCHAR(6),
        is_verified BOOLEAN DEFAULT FALSE,
        device_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "users" ready');

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS device_status (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        device_id VARCHAR(255) NOT NULL UNIQUE,
        battery_level INTEGER,
        is_charging BOOLEAN DEFAULT FALSE,
        last_updated TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "device_status" ready');

    // ── chat_messages: base table (reply_to_id already existed in v5.1)
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS otp_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        phone VARCHAR(20) NOT NULL,
        requested_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "otp_requests" ready');

    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_attempts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        identifier VARCHAR(255) NOT NULL,
        attempted_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "login_attempts" ready');

    // ─────────────────────────────────────────────────────────────────────
    // 🆕 V5.1 MIGRATIONS: Email & IP Tracking (preserved)
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🆕 Running v5.1 Titanium migrations...\n');

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;`);
      console.log('✅ Migration: users.email added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.email error:', error.message);
    }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;`);
      console.log('✅ Migration: users.email_verified added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.email_verified error:', error.message);
    }

    try {
      await pool.query(`ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS email VARCHAR(255);`);
      console.log('✅ Migration: otp_requests.email added/verified');
    } catch (error) {
      console.log('⚠️  Migration: otp_requests.email error:', error.message);
    }

    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS signup_ips (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          ip_address VARCHAR(45) NOT NULL,
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);
      console.log('✅ Table "signup_ips" ready (IP tracking)');
    } catch (error) {
      console.log('⚠️  Table "signup_ips" error:', error.message);
    }

    // V5.0 migrations (preserve existing)
    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;`);
      console.log('✅ Migration: users.api_key (TEXT) added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.api_key error:', error.message);
    }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS key_status TEXT DEFAULT 'pending';`);
      console.log('✅ Migration: users.key_status added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.key_status error:', error.message);
    }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;`);
      console.log('✅ Migration: users.credits added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.credits error:', error.message);
    }

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMP;`);
      console.log('✅ Migration: users.expiry_date added/verified');
    } catch (error) {
      console.log('⚠️  Migration: users.expiry_date error:', error.message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // 🆕 V5.2 MIGRATIONS: Global Chat Upgrade (NEW)
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🆕 Running v5.2 Global Chat migrations...\n');

    // NEW: sender_role — lowercase API-friendly role ('owner', 'admin', 'user')
    try {
      await pool.query(`
        ALTER TABLE chat_messages
          ADD COLUMN IF NOT EXISTS sender_role VARCHAR(50) DEFAULT 'user';
      `);
      console.log('✅ Migration: chat_messages.sender_role added/verified');
    } catch (error) {
      console.log('⚠️  Migration: chat_messages.sender_role error:', error.message);
    }

    // NEW: reply_preview — pre-computed 100-char snippet of the parent message
    try {
      await pool.query(`
        ALTER TABLE chat_messages
          ADD COLUMN IF NOT EXISTS reply_preview TEXT;
      `);
      console.log('✅ Migration: chat_messages.reply_preview added/verified');
    } catch (error) {
      console.log('⚠️  Migration: chat_messages.reply_preview error:', error.message);
    }

    // ─────────────────────────────────────────────────────────────────────
    // INDEXES & CONSTRAINTS
    // ─────────────────────────────────────────────────────────────────────

    console.log('\n🔍 Creating indexes...\n');

    const indexes = [
      ['idx_sms_timestamp',        'sms_logs',        'timestamp DESC'],
      ['idx_chat_timestamp',       'chat_messages',   'timestamp DESC'],
      ['idx_chat_reply',           'chat_messages',   'reply_to_id'],
      ['idx_chat_sender_role',     'chat_messages',   'sender_role'],       // NEW v5.2
      ['idx_outgoing_sms_status',  'outgoing_sms',    'status, created_at'],
      ['idx_users_phone',          'users',           'phone'],
      ['idx_users_email',          'users',           'email'],
      ['idx_device_status_device', 'device_status',   'device_id'],
      ['idx_otp_requests',         'otp_requests',    'phone, requested_at'],
      ['idx_otp_requests_email',   'otp_requests',    'email, requested_at'],
      ['idx_login_attempts',       'login_attempts',  'identifier, attempted_at'],
      ['idx_users_api_key',        'users',           'api_key'],
      ['idx_users_key_status',     'users',           'key_status'],
      ['idx_signup_ips_address',   'signup_ips',      'ip_address, created_at']
    ];

    for (const [name, table, column] of indexes) {
      try {
        await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column});`);
        console.log(`✅ Index: ${name}`);
      } catch (error) {
        console.log(`⚠️  Index: ${name} error:`, error.message);
      }
    }

    // Constraints
    try {
      await pool.query(`
        DO $$ 
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_api_key_unique') THEN
            ALTER TABLE users ADD CONSTRAINT users_api_key_unique UNIQUE (api_key);
          END IF;
        END $$;
      `);
      console.log('✅ Constraint: users.api_key UNIQUE verified');
    } catch (error) {
      console.log('⚠️  Constraint: users.api_key UNIQUE error:', error.message);
    }

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
      console.log('✅ Constraint: users.provider CHECK verified');
    } catch (error) {
      console.log('⚠️  Constraint: users.provider CHECK error:', error.message);
    }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('🎉 Database initialization complete (v5.2)!');
    console.log('════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Database initialization failed:', error);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ SECURITY UTILITIES (v5.1 Enhanced — unchanged)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hash password using scrypt
 */
const hashPassword = (password) => {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  if (password.length < 6) {
    throw new Error('Password must be at least 6 characters');
  }

  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 64);

  return {
    hash: hash.toString('hex'),
    salt: salt.toString('hex')
  };
};

/**
 * Verify password
 */
const verifyPassword = (password, storedHash, storedSalt) => {
  if (!password || !storedHash || !storedSalt) {
    return false;
  }

  try {
    const saltBuffer = Buffer.from(storedSalt, 'hex');
    const hashBuffer = crypto.scryptSync(password, saltBuffer, 64);
    const storedHashBuffer = Buffer.from(storedHash, 'hex');

    return crypto.timingSafeEqual(hashBuffer, storedHashBuffer);
  } catch (error) {
    console.error('❌ Password verification error:', error);
    return false;
  }
};

/**
 * Generate SaaS API Key
 */
const generateSaaSApiKey = () => {
  const randomHex = crypto.randomBytes(24).toString('hex');
  return `aura_live_${randomHex}`;
};

/**
 * Generate 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * TASK 1: Advanced Phone Validation with Dual Checks
 * Method 1: Strict BD Regex - /^01[3-9][0-9]{8}$/
 * Method 2: Google Libphonenumber validation
 *
 * @param {string} phone - Phone number to validate
 * @returns {Object} - {valid: boolean, normalized: string|null, error: string|null}
 */
const validatePhoneAdvanced = (phone) => {
  if (!phone || typeof phone !== 'string') {
    return {
      valid: false,
      normalized: null,
      error: 'Phone number is required'
    };
  }

  // Remove whitespace and dashes
  phone = phone.replace(/[\s\-]/g, '');

  // Normalize to 01XXXXXXXXX format
  if (phone.startsWith('+880')) {
    phone = '0' + phone.substring(4);
  } else if (phone.startsWith('880')) {
    phone = '0' + phone.substring(3);
  }

  // ─────────────────────────────────────────────────────────────────────
  // CHECK 1: Strict Bangladesh Regex
  // Must be exactly 11 digits starting with 013, 014, 015, 016, 017, 018, or 019
  // ─────────────────────────────────────────────────────────────────────
  const strictBDRegex = /^01[3-9][0-9]{8}$/;

  if (!strictBDRegex.test(phone)) {
    return {
      valid: false,
      normalized: null,
      error: 'Invalid Bangladesh phone number. Must be 11 digits starting with 013-019 (e.g., 01712345678)'
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // CHECK 2: Google Libphonenumber Validation
  // ─────────────────────────────────────────────────────────────────────
  try {
    const phoneNumber = phoneUtil.parseAndKeepRawInput(phone, 'BD');

    // Check if valid for Bangladesh
    if (!phoneUtil.isValidNumberForRegion(phoneNumber, 'BD')) {
      return {
        valid: false,
        normalized: null,
        error: 'Phone number is not valid for Bangladesh region'
      };
    }

    // Check if possible number
    if (!phoneUtil.isPossibleNumber(phoneNumber)) {
      return {
        valid: false,
        normalized: null,
        error: 'Phone number format is not possible'
      };
    }

    // Both checks passed
    return {
      valid: true,
      normalized: phone,
      error: null
    };

  } catch (error) {
    return {
      valid: false,
      normalized: null,
      error: `Phone validation failed: ${error.message}`
    };
  }
};

/**
 * Validate email format
 */
const validateEmail = (email) => {
  if (!email || typeof email !== 'string') {
    return { valid: false, error: 'Email is required' };
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { valid: false, error: 'Invalid email format' };
  }

  return { valid: true, error: null };
};

/**
 * Format timestamp
 */
const formatTimestamp = (date) => {
  return date ? date.toISOString() : null;
};

/**
 * Detect if user is an OWNER
 */
const detectOwnerRole = (deviceId, message, secretKey) => {
  if (deviceId === ADMIN_DEVICE_ID) return '★ OWNER';
  if (secretKey && secretKey === SECRET_OWNER_KEY) return '★ OWNER';
  if (message && message.includes(SECRET_OWNER_KEY)) return '★ OWNER';
  return 'User';
};

// ═══════════════════════════════════════════════════════════════════════════
// 🚦 RATE LIMITING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check OTP request cooldown
 */
const checkOTPCooldown = async (identifier) => {
  const windowStart = new Date(Date.now() - RATE_LIMITS.OTP_WINDOW_MINUTES * 60 * 1000);

  const result = await pool.query(
    `SELECT COUNT(*) as count FROM otp_requests 
     WHERE (phone = $1 OR email = $1) AND requested_at > $2`,
    [identifier, windowStart]
  );

  return parseInt(result.rows[0].count) >= RATE_LIMITS.OTP_REQUESTS;
};

/**
 * Log OTP request
 */
const logOTPRequest = async (client, phone, email) => {
  await client.query(
    `INSERT INTO otp_requests (phone, email) VALUES ($1, $2)`,
    [phone, email]
  );
};

/**
 * Check login attempt rate limit
 */
const checkLoginRateLimit = async (identifier) => {
  const windowStart = new Date(Date.now() - RATE_LIMITS.LOGIN_WINDOW_MINUTES * 60 * 1000);

  const result = await pool.query(
    `SELECT COUNT(*) as count FROM login_attempts 
     WHERE identifier = $1 AND attempted_at > $2`,
    [identifier, windowStart]
  );

  return parseInt(result.rows[0].count) >= RATE_LIMITS.LOGIN_ATTEMPTS;
};

/**
 * Log login attempt
 */
const logLoginAttempt = async (identifier) => {
  await pool.query(
    `INSERT INTO login_attempts (identifier) VALUES ($1)`,
    [identifier]
  );
};

/**
 * Track signup IP
 */
const trackSignupIP = async (client, ip, userId) => {
  try {
    await client.query(
      `INSERT INTO signup_ips (ip_address, user_id) VALUES ($1, $2)`,
      [ip, userId]
    );
  } catch (error) {
    console.error('⚠️  Failed to track signup IP:', error.message);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 AUTHENTICATION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate admin API key
 */
const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;

  if (!apiKey) {
    return res.status(401).json({
      success: false,
      error: 'API Key required',
      message: '🔒 Please provide a valid API key'
    });
  }

  if (apiKey !== API_KEY) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API Key',
      message: '⚠️ Authentication failed'
    });
  }

  next();
};

/**
 * Verify SaaS user API key
 */
const verifySaaSKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'API Key required',
        message: '🔒 Please provide your SaaS API key'
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
        message: '⚠️ API key not found'
      });
    }

    const user = result.rows[0];

    if (user.key_status === 'pending') {
      return res.status(403).json({
        success: false,
        error: 'Account pending',
        message: '⏳ Your account is pending admin approval'
      });
    }

    if (user.key_status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Account suspended',
        message: '🚫 Your account has been suspended'
      });
    }

    if (user.credits <= 0) {
      return res.status(403).json({
        success: false,
        error: 'Insufficient credits',
        message: '💳 You have 0 credits remaining',
        credits: user.credits
      });
    }

    if (user.expiry_date && new Date(user.expiry_date) < new Date()) {
      return res.status(403).json({
        success: false,
        error: 'API key expired',
        message: '⏰ Your API key has expired'
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

// ═══════════════════════════════════════════════════════════════════════════
// 🌐 API ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────
// ROOT & HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    success: true,
    app: '⚡ AURA GATEWAY',
    version: '5.2.0 Global Chat',
    database: 'PostgreSQL',
    status: 'operational',
    features: {
      advanced_phone_validation: true,
      email_otp_system: true,
      vpn_proxy_detection: true,
      ip_rate_limiting: true,
      anti_spam: true,
      saas_api_management: true,
      credit_system: true,
      password_auth: true,
      chat_system: true,
      chat_reply_system: true,
      chat_zero_credit: true,
      device_health: true
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

// ─────────────────────────────────────────────────────────────────────────
// 🔐 AUTHENTICATION ROUTES (v5.1 Military-Grade — unchanged)
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /api/signup - User Registration (v5.1 Titanium)
 *
 * - TASK 1: Dual phone validation (Strict Regex + Libphonenumber)
 * - TASK 2: Email OTP system (Nodemailer with HTML template)
 * - TASK 3: IP rate limiting (3/day) + VPN detection
 */
app.post('/api/signup', signupRateLimiter, detectVPN, async (req, res) => {
  const client = await pool.connect();

  try {
    const { username, phone, email, payment_number, provider, password } = req.body;

    // ─────────────────────────────────────────────────────────────────────
    // INPUT VALIDATION
    // ─────────────────────────────────────────────────────────────────────

    if (!username || !phone || !email || !payment_number || !provider) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'phone', 'email', 'payment_number', 'provider']
      });
    }

    // Validate email (TASK 2)
    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid email',
        message: emailValidation.error
      });
    }

    // TASK 1: Advanced phone validation (Dual checks)
    const phoneValidation = validatePhoneAdvanced(phone);
    if (!phoneValidation.valid) {
      console.log(`\n⚠️  PHONE VALIDATION FAILED (DUAL CHECK)`);
      console.log(`   Input: ${phone}`);
      console.log(`   Error: ${phoneValidation.error}`);

      return res.status(400).json({
        success: false,
        error: 'Invalid phone number',
        message: phoneValidation.error,
        examples: ['01712345678', '01812345678', '01912345678']
      });
    }

    const normalizedPhone = phoneValidation.normalized;

    // Validate payment number
    const paymentValidation = validatePhoneAdvanced(payment_number);
    if (!paymentValidation.valid) {
      console.log(`\n⚠️  PAYMENT NUMBER VALIDATION FAILED`);
      console.log(`   Input: ${payment_number}`);

      return res.status(400).json({
        success: false,
        error: 'Invalid payment number',
        message: paymentValidation.error
      });
    }

    const normalizedPayment = paymentValidation.normalized;

    // Validate provider
    if (!['bKash', 'Nagad', 'Rocket'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payment provider',
        allowed: ['bKash', 'Nagad', 'Rocket']
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // RATE LIMIT CHECK (Phone/Email based)
    // ─────────────────────────────────────────────────────────────────────

    const isCooldownActive = await checkOTPCooldown(email);
    if (isCooldownActive) {
      console.log(`\n🚫 OTP COOLDOWN ACTIVE`);
      console.log(`   Email: ${email}`);

      return res.status(429).json({
        success: false,
        error: 'Too many OTP requests',
        message: `You can only request OTP ${RATE_LIMITS.OTP_REQUESTS} times per ${RATE_LIMITS.OTP_WINDOW_MINUTES} minutes`,
        cooldown: `${RATE_LIMITS.OTP_WINDOW_MINUTES} minutes`
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // PRE-INSERT UNIQUENESS CHECKS
    // ─────────────────────────────────────────────────────────────────────

    // Check username uniqueness
    const usernameCheck = await pool.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (usernameCheck.rows.length > 0) {
      console.log(`\n⚠️  DUPLICATE USERNAME`);
      console.log(`   Username: ${username}`);

      return res.status(409).json({
        success: false,
        error: 'Username already exists',
        message: `The username "${username}" is already taken.`
      });
    }

    // Check phone uniqueness
    const phoneCheck = await pool.query(
      'SELECT id FROM users WHERE phone = $1',
      [normalizedPhone]
    );

    if (phoneCheck.rows.length > 0) {
      console.log(`\n⚠️  DUPLICATE PHONE`);
      console.log(`   Phone: ${normalizedPhone}`);

      return res.status(409).json({
        success: false,
        error: 'Phone number already registered',
        message: `The phone number ${normalizedPhone} is already registered.`
      });
    }

    // Check email uniqueness (TASK 2)
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (emailCheck.rows.length > 0) {
      console.log(`\n⚠️  DUPLICATE EMAIL`);
      console.log(`   Email: ${email}`);

      return res.status(409).json({
        success: false,
        error: 'Email already registered',
        message: `The email ${email} is already registered.`
      });
    }

    // ─────────────────────────────────────────────────────────────────────
    // START TRANSACTION
    // ─────────────────────────────────────────────────────────────────────

    await client.query('BEGIN');

    try {
      // Generate credentials
      const otpCode = generateOTP();
      const userId = uuidv4();
      const saasApiKey = generateSaaSApiKey();

      // Hash password if provided
      let passwordHash = null;
      let passwordSalt = null;
      if (password) {
        try {
          const hashed = hashPassword(password);
          passwordHash = hashed.hash;
          passwordSalt = hashed.salt;
        } catch (error) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            success: false,
            error: 'Invalid password',
            message: error.message
          });
        }
      }

      // Insert user (with email)
      await client.query(
        `INSERT INTO users (
          id, username, phone, email, payment_number, provider, 
          password_hash, password_salt,
          otp_code, is_verified, email_verified,
          api_key, key_status, credits
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, false, $10, 'pending', 0)`,
        [
          userId, username, normalizedPhone, email.toLowerCase(), normalizedPayment, provider,
          passwordHash, passwordSalt,
          otpCode,
          saasApiKey
        ]
      );

      // TASK 2: Send OTP via Email (not SMS)
      const emailSent = await sendOTPEmail(email, otpCode, username);

      if (!emailSent) {
        await client.query('ROLLBACK');
        return res.status(500).json({
          success: false,
          error: 'Failed to send OTP email',
          message: 'Email service is currently unavailable. Please try again later.'
        });
      }

      // Log OTP request (with email)
      await logOTPRequest(client, normalizedPhone, email);

      // TASK 3: Track signup IP
      const clientIP = req.ip || 'unknown';
      await trackSignupIP(client, clientIP, userId);

      // Commit transaction
      await client.query('COMMIT');

      console.log(`\n════════════════════════════════════════════════════════════════`);
      console.log(`👤 NEW USER SIGNUP (v5.1 Titanium - Military-Grade)`);
      console.log(`   Username: ${username}`);
      console.log(`   Phone: ${normalizedPhone} ✓ (Dual validated)`);
      console.log(`   Email: ${email} ✓ (OTP sent)`);
      console.log(`   Payment: ${normalizedPayment} (${provider}) ✓`);
      console.log(`   OTP: ${otpCode} (sent to email)`);
      console.log(`   🔑 API Key: ${saasApiKey.substring(0, 30)}...`);
      console.log(`   📍 IP: ${clientIP} (tracked & VPN-checked)`);
      console.log(`   Status: PENDING`);
      console.log(`════════════════════════════════════════════════════════════════\n`);

      res.status(201).json({
        success: true,
        message: 'User registered successfully. OTP sent to your email.',
        user: {
          id: userId,
          username,
          phone: normalizedPhone,
          email: email.toLowerCase(),
          api_key: saasApiKey,
          key_status: 'pending',
          credits: 0
        },
        otp_sent: true,
        otp_method: 'email',
        next_step: 'Check your email for the OTP code, then verify'
      });

    } catch (transactionError) {
      await client.query('ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('❌ Signup Error:', error);

    // Handle specific database errors
    if (error.code === '23505') {
      if (error.constraint === 'users_username_key') {
        return res.status(409).json({
          success: false,
          error: 'Username already exists'
        });
      }
      if (error.constraint === 'users_phone_key') {
        return res.status(409).json({
          success: false,
          error: 'Phone already registered'
        });
      }
      if (error.constraint === 'users_email_key') {
        return res.status(409).json({
          success: false,
          error: 'Email already registered'
        });
      }
    }

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
 * POST /api/verify-otp - Verify OTP code (email-based)
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
       SET is_verified = true, email_verified = true, otp_code = NULL
       WHERE username = $1 AND otp_code = $2 AND is_verified = false
       RETURNING id, username, phone, email`,
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
    console.log(`✅ OTP VERIFICATION SUCCESS (Email)`);
    console.log(`   User: ${user.username}`);
    console.log(`   Phone: ${user.phone}`);
    console.log(`   Email: ${user.email} ✓ verified`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    res.json({
      success: true,
      message: 'Account verified successfully',
      user: {
        id: user.id,
        username: user.username,
        phone: user.phone,
        email: user.email
      }
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

/**
 * POST /api/login - User & Admin login (v5.1 Titanium)
 * Properly distinguishes between Regular Users and Admins.
 * Regular users → DB lookup + scrypt verify → JWT with role 'User'
 * Admin         → env-var check             → JWT with role 'Admin' / '★ OWNER'
 */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, device_id, deviceId } = req.body;
    const finalDeviceId = device_id || deviceId;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Missing required fields', required: ['username', 'password'] });
    }

    const rateLimitExceeded = await checkLoginRateLimit(username);
    if (rateLimitExceeded) {
      return res.status(429).json({ success: false, error: 'Too many login attempts', message: 'Rate limit exceeded' });
    }
    await logLoginAttempt(username);

    // ── STEP 1: Try user login first ──────────────────────────────────────
    const userResult = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_verified = true',
      [username]
    );

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      if (user.password_hash && user.password_salt) {
        const passwordValid = verifyPassword(password, user.password_hash, user.password_salt);
        if (passwordValid) {
          console.log(`\n✅ USER LOGIN SUCCESSFUL\n   Username: ${username}`);
          const token = jwt.sign(
            { id: user.id, username: user.username, role: 'User' },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
          );
          return res.json({
            success: true,
            message: 'Login successful',
            token,
            user: { id: user.id, username: user.username, phone: user.phone, email: user.email, api_key: user.api_key }
          });
        }
      }
      // User found but password wrong
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // ── STEP 2: No verified user found → check admin credentials ──────────
    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    if (username === ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      console.log(`\n✅ ADMIN LOGIN SUCCESSFUL\n   Username: ${username}`);
      const adminRole = finalDeviceId === (process.env.ADMIN_DEVICE_ID || ADMIN_DEVICE_ID) ? '★ OWNER' : 'Admin';
      const token = jwt.sign(
        { username: username, role: adminRole },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      );
      return res.json({ success: true, message: 'Login successful', token, apiKey: process.env.API_KEY || API_KEY, role: adminRole });
    }

    // Neither matched
    return res.status(401).json({ success: false, error: 'Invalid credentials or unverified account' });

  } catch (error) {
    console.error('❌ Login Error:', error);
    res.status(500).json({ success: false, error: 'Login failed', message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 👥 USER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

/**
 * GET /api/users - Fetch all users (admin only)
 */
app.get('/api/users', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        id, username, phone, email, email_verified, payment_number, provider,
        is_verified,
        api_key, key_status, credits, expiry_date,
        created_at
      FROM users
      ORDER BY created_at DESC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      users: result.rows.map(user => ({
        ...user,
        expiry_date: formatTimestamp(user.expiry_date),
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
app.get('/api/me', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'API Key required'
      });
    }

    const result = await pool.query(
      `SELECT 
        id, username, phone, email, email_verified, payment_number, provider,
        is_verified, api_key, key_status, credits, expiry_date, created_at
       FROM users WHERE api_key = $1`,
      [apiKey]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Invalid API key'
      });
    }

    const user = result.rows[0];
    res.json({
      success: true,
      user: {
        ...user,
        expiry_date: formatTimestamp(user.expiry_date),
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

// ─────────────────────────────────────────────────────────────────────────
// 🔑 ADMIN SAAS MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/approve - Approve/suspend user API keys
 */
app.post('/api/admin/approve', validateApiKey, async (req, res) => {
  try {
    const { user_id, status } = req.body;

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
       SET key_status = $1
       WHERE id = $2
       RETURNING id, username, api_key, key_status, credits`,
      [status, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: `User API key ${status}`,
      user: result.rows[0]
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
 */
app.post('/api/admin/renew', validateApiKey, async (req, res) => {
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
    newExpiryDate.setDate(newExpiryDate.getDate() + days);

    const result = await pool.query(
      `UPDATE users 
       SET credits = credits + $1, expiry_date = $2
       WHERE id = $3
       RETURNING id, username, api_key, key_status, credits, expiry_date`,
      [credits, newExpiryDate, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      message: `Added ${credits} credits and extended expiry by ${days} days`,
      user: {
        ...result.rows[0],
        expiry_date: formatTimestamp(result.rows[0].expiry_date)
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

// ─────────────────────────────────────────────────────────────────────────
// 📊 ADMIN STATS & LOGS (Lovable Frontend Support)
// ─────────────────────────────────────────────────────────────────────────

/**
 * GET /api/admin/stats - Basic platform stats for dashboard
 */
app.get('/api/admin/stats', validateApiKey, async (req, res) => {
  try {
    const [usersResult, creditsResult] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT COALESCE(SUM(credits), 0) AS total FROM users')
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers: parseInt(usersResult.rows[0].total),
        totalCredits: parseInt(creditsResult.rows[0].total),
        activeConnections: pool.totalCount,
        status: 'operational',
        version: '5.2.0 Global Chat'
      }
    });
  } catch (error) {
    console.error('❌ Admin Stats Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stats',
      message: error.message
    });
  }
});

/**
 * GET /api/admin/logs - Return activity logs (stub for frontend)
 */
app.get('/api/admin/logs', validateApiKey, async (req, res) => {
  try {
    res.json({
      success: true,
      count: 0,
      logs: []
    });
  } catch (error) {
    console.error('❌ Admin Logs Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch logs',
      message: error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 📱 SMS GATEWAY (All existing routes preserved — unchanged)
// ─────────────────────────────────────────────────────────────────────────

app.get('/api/pending-sms', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM outgoing_sms WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        pending: false,
        message: 'No pending SMS'
      });
    }

    res.json({
      success: true,
      pending: true,
      sms: {
        id: result.rows[0].id,
        recipient: result.rows[0].recipient_number,
        message: result.rows[0].message_text,
        created_at: result.rows[0].created_at
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

app.post('/api/sms-sent', validateApiKey, async (req, res) => {
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
      `UPDATE outgoing_sms SET status = $1, sent_at = NOW() WHERE id = $2 RETURNING *`,
      [status, sms_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'SMS not found'
      });
    }

    res.json({
      success: true,
      message: 'SMS status updated',
      sms: result.rows[0]
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

app.post('/api/send-sms', verifySaaSKey, async (req, res) => {
  const client = await pool.connect();

  try {
    const { recipient, message } = req.body;
    const user = req.saasUser;

    if (!recipient || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['recipient', 'message']
      });
    }

    const phoneValidation = validatePhoneAdvanced(recipient);
    if (!phoneValidation.valid) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipient phone number',
        message: phoneValidation.error
      });
    }

    await client.query('BEGIN');

    const updateResult = await client.query(
      `UPDATE users SET credits = credits - 1 WHERE id = $1 RETURNING credits`,
      [user.id]
    );

    const newCredits = updateResult.rows[0].credits;

    const smsId = uuidv4();
    await client.query(
      `INSERT INTO outgoing_sms (id, recipient_number, message_text, status) VALUES ($1, $2, $3, 'pending')`,
      [smsId, phoneValidation.normalized, message]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'SMS queued successfully',
      sms: {
        id: smsId,
        recipient: phoneValidation.normalized,
        message,
        status: 'pending'
      },
      credits_remaining: newCredits
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

app.post('/api/sms', validateApiKey, async (req, res) => {
  try {
    const { sender, message, device_id, deviceId, timestamp } = req.body;
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
      `INSERT INTO sms_logs (id, sender, message, device_id, timestamp) VALUES ($1, $2, $3, $4, $5)`,
      [smsId, sender, message, finalDeviceId, smsTimestamp]
    );

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

app.get('/api/sms', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);

    const result = await pool.query(
      'SELECT * FROM sms_logs ORDER BY timestamp DESC LIMIT $1',
      [limit]
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(log => ({
        id: log.id,
        sender: log.sender,
        message: log.message,
        device_id: log.device_id,
        timestamp: formatTimestamp(log.timestamp)
      }))
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

// ─────────────────────────────────────────────────────────────────────────
// 💬 CHAT SYSTEM — v5.2 GLOBAL CHAT UPGRADE
// ─────────────────────────────────────────────────────────────────────────
//
// What changed vs v5.1:
//
//  POST /api/chat
//  ┌────────────────────────┬───────────────────────────────────────────┐
//  │ replyToId (body)       │ NEW — UUID of the message being replied to│
//  │ senderRole (body)      │ NEW — optional role hint from client      │
//  │ reply_preview (DB col) │ NEW — auto 100-char snippet of parent msg │
//  │ sender_role (DB col)   │ NEW — lowercase API-friendly role string  │
//  │ credits / api_credits  │ NOT TOUCHED — zero-credit guaranteed      │
//  │ reply_to_id (DB col)   │ EXISTING — now validated against DB first │
//  └────────────────────────┴───────────────────────────────────────────┘
//
//  GET /api/chat
//  ┌────────────────────────┬───────────────────────────────────────────┐
//  │ reply_preview          │ NEW — returned from DB (pre-computed)     │
//  │ sender_role            │ NEW — returned on every message object    │
//  │ replying_to.preview    │ NEW — replaces replying_to.message        │
//  └────────────────────────┴───────────────────────────────────────────┘
//
//  DELETE /api/chat — UNCHANGED
// ─────────────────────────────────────────────────────────────────────────

/**
 * POST /api/chat — Send a Global Chat Message
 *
 * Accepted req.body fields:
 *   username   {string}  required  — display name
 *   message    {string}  required  — message body
 *   device_id  {string}  optional  — device identifier (also accepts deviceId)
 *   secret_key {string}  optional  — owner secret to elevate role to ★ OWNER
 *   replyToId  {string}  optional  — UUID of the message being replied to
 *   senderRole {string}  optional  — caller-supplied role label
 *
 * ⚠️  ZERO-CREDIT GUARANTEE:
 *   This route NEVER reads or writes the users.credits / api_credits column.
 *   Global Chat is 100% free. No verifySaaSKey middleware is applied here.
 */
app.post('/api/chat', validateApiKey, async (req, res) => {
  // Acquire a single DB client for the entire request (atomic read + write).
  const client = await pool.connect();

  try {
    // ── 1. Parse & normalise incoming fields ──────────────────────────────
    const {
      username,
      message,
      device_id,
      deviceId,       // legacy alias — kept for backward compat
      secret_key,
      replyToId,      // NEW v5.2: UUID of the parent message
      senderRole,     // NEW v5.2: optional role hint from client
    } = req.body;

    // Support both device_id and the legacy deviceId key.
    const finalDeviceId = device_id || deviceId || null;

    // ── 2. Input validation ───────────────────────────────────────────────
    if (!username || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'message'],
      });
    }

    if (typeof message !== 'string' || message.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Message must be a non-empty string',
      });
    }

    // ── 3. ZERO-CREDIT GUARD ──────────────────────────────────────────────
    // Global Chat is 100% free. We explicitly do NOT query or update the
    // users table here. The users.credits / api_credits column is never
    // touched inside this route. If you ever add billing logic above this
    // file, ensure this route remains excluded from any credit deduction.

    // ── 4. Determine display role ─────────────────────────────────────────
    // Owner check always wins. Otherwise use caller-supplied senderRole or
    // default to 'user'.
    const ownerRoleCheck = detectOwnerRole(finalDeviceId, message, secret_key);
    const isOwner = ownerRoleCheck === '★ OWNER';

    // Display role: shown in the UI (e.g. '★ OWNER', 'Admin', 'user')
    const finalRole = isOwner
      ? '★ OWNER'
      : (senderRole && typeof senderRole === 'string'
          ? senderRole.trim().substring(0, 50)
          : 'user');

    // API role: lowercase, machine-friendly ('owner', 'admin', 'user', etc.)
    const finalSenderRole = isOwner
      ? 'owner'
      : (senderRole && typeof senderRole === 'string'
          ? senderRole.toLowerCase().trim().substring(0, 50)
          : 'user');

    // ── 5. Reply preview logic ────────────────────────────────────────────
    // If replyToId is provided, look up the parent message and extract a
    // short snippet (≤100 chars) to store as reply_preview.
    // Storing it avoids a JOIN on every GET request (performance win).
    let resolvedReplyToId      = null;
    let resolvedReplyPreview   = null;
    let resolvedReplyUsername  = null;

    if (replyToId) {
      const parentResult = await client.query(
        `SELECT id, username, message FROM chat_messages WHERE id = $1 LIMIT 1`,
        [replyToId]
      );

      if (parentResult.rows.length > 0) {
        const parent = parentResult.rows[0];

        // Confirm UUID is valid (row found) before storing.
        resolvedReplyToId = parent.id;

        // Slice a safe 100-character snippet; strip newlines for clean bubbles.
        const rawText = (parent.message || '').replace(/\r?\n/g, ' ').trim();
        resolvedReplyPreview = rawText.length > 100
          ? rawText.substring(0, 100) + '…'
          : rawText;

        resolvedReplyUsername = parent.username;
      } else {
        // Parent message not found — silently ignore the reply reference
        // rather than rejecting the whole message. This keeps UX smooth
        // when the parent was deleted between client fetch and send.
        console.warn(`⚠️  Chat reply: parent message ${replyToId} not found — ignoring reply ref`);
      }
    }

    // ── 6. Insert new message ─────────────────────────────────────────────
    const messageId = uuidv4();
    const timestamp = new Date();

    await client.query(
      `INSERT INTO chat_messages
         (id, username, message, role, sender_role, device_id,
          reply_to_id, reply_preview, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        messageId,
        username.trim().substring(0, 255),  // sanitise length
        message.trim(),
        finalRole,
        finalSenderRole,
        finalDeviceId,
        resolvedReplyToId,    // null if no valid replyToId supplied
        resolvedReplyPreview, // null if not a reply
        timestamp,
      ]
    );

    // ── 7. Fetch the saved row to return a canonical response ─────────────
    const saved = (
      await client.query(
        `SELECT id, username, message, role, sender_role,
                device_id, reply_to_id, reply_preview, timestamp
         FROM chat_messages WHERE id = $1`,
        [messageId]
      )
    ).rows[0];

    console.log(`\n💬 CHAT MESSAGE SENT`);
    console.log(`   User: ${saved.username} (${finalSenderRole})`);
    console.log(`   Reply to: ${resolvedReplyToId || 'none'}`);

    // ── 8. Return response ────────────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: 'Chat message sent',
      data: {
        id:            saved.id,
        username:      saved.username,
        message:       saved.message,
        role:          saved.role,          // display role ('★ OWNER', 'user', etc.)
        sender_role:   saved.sender_role,   // NEW: API-friendly role ('owner', 'admin', 'user')
        device_id:     saved.device_id,
        reply_to_id:   saved.reply_to_id,   // UUID of parent message or null
        reply_preview: saved.reply_preview, // NEW: 100-char snippet or null
        // Include reply author info in the response when applicable
        ...(resolvedReplyToId && {
          replying_to: {
            username: resolvedReplyUsername,
            preview:  resolvedReplyPreview,
          },
        }),
        timestamp: formatTimestamp(saved.timestamp),
        isOwner:   saved.role === '★ OWNER',
      },
    });

  } catch (error) {
    console.error('❌ Chat Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to send message',
      message: error.message,
    });
  } finally {
    // Always release the client back to the pool.
    client.release();
  }
});

/**
 * GET /api/chat — Fetch Recent Global Chat Messages
 *
 * Query params:
 *   limit {number} optional — max messages to return (1–50, default 50)
 *
 * v5.2 upgrade: Returns reply_preview from DB instead of doing a full JOIN.
 * The LEFT JOIN is kept as a backward-compatible fallback to populate
 * parent_username for messages sent before the v5.2 migration.
 */
app.get('/api/chat', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);

    const result = await pool.query(
      `SELECT
         m.id,
         m.username,
         m.message,
         m.role,
         m.sender_role,
         m.device_id,
         m.reply_to_id,
         m.reply_preview,
         m.timestamp,
         parent.username AS parent_username,
         -- Fallback: if reply_preview not yet populated (pre-v5.2 row),
         -- pull a snippet directly from the parent row.
         COALESCE(m.reply_preview, LEFT(parent.message, 100)) AS resolved_preview
       FROM chat_messages m
       LEFT JOIN chat_messages parent ON m.reply_to_id = parent.id
       ORDER BY m.timestamp DESC
       LIMIT $1`,
      [limit]
    );

    return res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(row => ({
        id:            row.id,
        username:      row.username,
        message:       row.message,
        role:          row.role,
        sender_role:   row.sender_role || 'user',     // NEW v5.2
        device_id:     row.device_id,
        reply_to_id:   row.reply_to_id,
        reply_preview: row.resolved_preview || null,  // NEW v5.2
        timestamp:     formatTimestamp(row.timestamp),
        isOwner:       row.role === '★ OWNER',
        // Nested reply context when the message is a reply
        ...(row.reply_to_id && {
          replying_to: {
            username: row.parent_username,
            preview:  row.resolved_preview,
          },
        }),
      })),
    });

  } catch (error) {
    console.error('❌ Chat Fetch Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch chat messages',
      message: error.message,
    });
  }
});

/**
 * DELETE /api/chat — Clear All Chat History (Owner Only)
 * Unchanged from v5.1.
 */
app.delete('/api/chat', validateApiKey, async (req, res) => {
  try {
    const { secret_key } = req.body;

    if (secret_key !== SECRET_OWNER_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required',
      });
    }

    const countResult = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const previousCount = parseInt(countResult.rows[0].count);

    await pool.query('DELETE FROM chat_messages');

    return res.json({
      success: true,
      message: 'Chat history cleared',
      deletedCount: previousCount,
    });

  } catch (error) {
    console.error('❌ Chat Clear Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to clear chat',
      message: error.message,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// 🔋 DEVICE HEALTH (All existing routes preserved — unchanged)
// ─────────────────────────────────────────────────────────────────────────

app.post('/api/device-health', validateApiKey, async (req, res) => {
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
       DO UPDATE SET battery_level = $2, is_charging = $3, last_updated = NOW()
       RETURNING *`,
      [ADMIN_DEVICE_ID, battery_level, is_charging]
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

app.get('/api/device-health', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM device_status WHERE device_id = $1',
      [ADMIN_DEVICE_ID]
    );

    // Always return 200 — include DB data when available, base status otherwise
    res.json({
      success: true,
      status: 'online',
      message: 'Device is healthy',
      device: result.rows.length > 0 ? result.rows[0] : null
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

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// 🚀 SERVER STARTUP
// ═══════════════════════════════════════════════════════════════════════════

const startServer = async () => {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log('\n════════════════════════════════════════════════════════════════');
      console.log('⚡ AURA GATEWAY v5.2 - GLOBAL CHAT UPGRADE');
      console.log('════════════════════════════════════════════════════════════════');
      console.log(`📡 Server: http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`💾 Database: PostgreSQL (Railway)`);
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ v5.1 Titanium Features (preserved):');
      console.log('   - Dual phone validation (Regex + Libphonenumber) ✓');
      console.log('   - Email OTP system (Nodemailer + HTML) ✓');
      console.log('   - IP rate limiting (3/day) + VPN detection ✓');
      console.log('   - All v5.0 features preserved (zero regression) ✓');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('🆕 v5.2 Global Chat Features:');
      console.log('   - sender_role column (VARCHAR) ✓');
      console.log('   - reply_preview column (TEXT) ✓');
      console.log('   - Unified reply system with DB-validated replyToId ✓');
      console.log('   - Zero-credit guarantee on POST /api/chat ✓');
      console.log('   - senderRole accepted from req.body ✓');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ Server ready');
      console.log('════════════════════════════════════════════════════════════════\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => {
  console.log('\n⚠️  SIGTERM received: closing gracefully\n');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⚠️  SIGINT received: closing gracefully\n');
  await pool.end();
  process.exit(0);
});

startServer();

module.exports = app;
