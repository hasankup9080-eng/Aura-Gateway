/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ⚡ AURA GATEWAY v5.3 - OTP EMAIL DEBUGGED & HARDENED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔧 WHAT'S FIXED IN v5.3 (Email / OTP Layer):
 *
 * BUG 1 — TRANSPORTER REBUILT ON EVERY SEND (FIXED)
 *   Old: createEmailTransporter() was called inside sendOTPEmail() on every
 *        request, creating a new TCP connection each time. A missing env var
 *        returned null silently with no diagnostic.
 *   Fix: A single `emailTransporter` singleton is created once at module
 *        load and reused for every send.
 *
 * BUG 2 — NO SMTP VERIFICATION ON STARTUP (FIXED)
 *   Old: Bad credentials / wrong host only discovered on the first real send.
 *   Fix: verifyEmailTransporter() is called inside startServer(). Any SMTP
 *        auth failure is logged immediately on boot with the exact error.
 *
 * BUG 3 — OTP HAS NO EXPIRY TIMESTAMP (FIXED)
 *   Old: otp_expires_at column did not exist. The email said "expires in 15
 *        minutes" but verify-otp never checked a timestamp.
 *   Fix: New migration adds otp_expires_at TIMESTAMP to users.
 *        Signup stores NOW() + 15 min. verify-otp rejects expired codes with
 *        a clear "OTP has expired" message.
 *
 * BUG 4 — SMTP ERROR SWALLOWED SILENTLY (FIXED)
 *   Old: catch block logged raw error object — actual SMTP rejection reason
 *        (e.g. "Invalid login", "535 5.7.8 Username and Password not accepted")
 *        was invisible in Railway logs.
 *   Fix: sendOTPEmail now explicitly logs error.code, error.responseCode,
 *        error.response, and error.command. In development the API response
 *        body also includes the SMTP reason so the developer can act on it.
 *
 * BUG 5 — ONLY GMAIL HARDCODED (FIXED)
 *   Old: service: 'gmail' with GMAIL_USER/GMAIL_PASS only. Breaks on any
 *        other provider (SendGrid, Mailgun, Brevo, custom SMTP).
 *   Fix: Dual-config: checks SMTP_HOST/PORT/USER/PASS first (generic SMTP).
 *        Falls back to GMAIL_USER/GMAIL_PASS using the Gmail service preset.
 *
 * ✅ ALL v5.2 FEATURES PRESERVED (zero regression):
 *   - Global Chat (sender_role, reply_preview, replyToId, zero-credit)
 *   - Admin ★ OWNER badges, detectOwnerRole
 *   - Dual phone validation, VPN detection, IP rate limiting
 *   - Scrypt password hashing, atomic transactions
 *   - All 17+ endpoints untouched except email/OTP layer + verify-otp
 *
 * Required .env for email:
 *   Option A (Generic SMTP — recommended for Railway):
 *     SMTP_HOST=smtp.example.com
 *     SMTP_PORT=587
 *     SMTP_USER=you@example.com
 *     SMTP_PASS=yourpassword
 *     SMTP_FROM_NAME=Aura Gateway    (optional)
 *     SMTP_SECURE=false              (true only for port 465)
 *   Option B (Gmail App Password):
 *     GMAIL_USER=you@gmail.com
 *     GMAIL_PASS=xxxx xxxx xxxx xxxx (16-char app password, NOT gmail login password)
 *
 * Production-Ready | Railway Optimized | PostgreSQL
 * ═══════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool }   = require('pg');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const axios      = require('axios');
const nodemailer = require('nodemailer');
const phoneUtil  = require('google-libphonenumber').PhoneNumberUtil.getInstance();
const PNF        = require('google-libphonenumber').PhoneNumberFormat;
const jwt        = require('jsonwebtoken');

const app      = express();
const PORT     = process.env.PORT     || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ═══════════════════════════════════════════════════════════════════════════
// 🔧 CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const API_KEY          = process.env.API_KEY          || 'lynx-aura-gateway-2025';
const ADMIN_DEVICE_ID  = 'REAL-MENA-RZO5-0177';
const SECRET_OWNER_KEY = process.env.SECRET_OWNER_KEY || '★LYNX★';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'lynx-admin-2025';

// How long OTPs remain valid
const OTP_EXPIRY_MINUTES = 15;

// Rate Limiting
const RATE_LIMITS = {
  OTP_REQUESTS:          3,
  OTP_WINDOW_MINUTES:    15,
  LOGIN_ATTEMPTS:        5,
  LOGIN_WINDOW_MINUTES:  15,
  SIGNUP_PER_IP_PER_DAY: 3
};

// VPN Detection
const VPN_DETECTION = {
  enabled: process.env.VPN_DETECTION_ENABLED !== 'false',
  api:     'http://ip-api.com/json/',
  timeout: 5000
};

// ═══════════════════════════════════════════════════════════════════════════
// 📧 EMAIL — SINGLETON TRANSPORTER  (FIX: BUG 1 + BUG 5)
// ═══════════════════════════════════════════════════════════════════════════
//
// The transporter is built ONCE at module load and reused for every send.
// Priority: SMTP_HOST (generic) → GMAIL_USER (Gmail App Password fallback)

let emailTransporter = null;
let emailFromAddress = null;
const emailFromName  = process.env.SMTP_FROM_NAME || 'Aura Gateway';

const buildEmailTransporter = () => {
  // ── Option A: Generic SMTP ───────────────────────────────────────────────
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const port   = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    console.log('\n📧 EMAIL CONFIG: Generic SMTP');
    console.log(`   Host:   ${process.env.SMTP_HOST}`);
    console.log(`   Port:   ${port}  (secure: ${secure})`);
    console.log(`   User:   ${process.env.SMTP_USER}`);

    emailFromAddress = process.env.SMTP_USER;

    return nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   port,
      secure: secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000
    });
  }

  // ── Option B: Gmail App Password (legacy) ────────────────────────────────
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    console.log('\n📧 EMAIL CONFIG: Gmail (App Password)');
    console.log(`   User: ${process.env.GMAIL_USER}`);

    emailFromAddress = process.env.GMAIL_USER;

    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      },
      connectionTimeout: 10000,
      greetingTimeout:   10000,
      socketTimeout:     15000
    });
  }

  // ── No config ────────────────────────────────────────────────────────────
  console.warn('\n⚠️  ═══════════════════════════════════════════════════════════');
  console.warn('⚠️  EMAIL NOT CONFIGURED — OTP emails will NOT be sent!');
  console.warn('⚠️  Set SMTP_HOST/SMTP_USER/SMTP_PASS  OR  GMAIL_USER/GMAIL_PASS');
  console.warn('⚠️  ═══════════════════════════════════════════════════════════\n');
  return null;
};

// Build once at module load
emailTransporter = buildEmailTransporter();

/**
 * Verify SMTP connection on server startup.  (FIX: BUG 2)
 * Logs specific error fields so credential mistakes are visible in Railway
 * logs immediately — not buried inside a failed user request.
 */
const verifyEmailTransporter = async () => {
  if (!emailTransporter) {
    console.warn('⚠️  Email transporter not initialised — skipping SMTP verify');
    return false;
  }
  try {
    await emailTransporter.verify();
    console.log('✅ SMTP connection verified — OTP emails are ready to send');
    return true;
  } catch (err) {
    console.error('\n❌ SMTP VERIFICATION FAILED');
    console.error(`   Message:      ${err.message}`);
    console.error(`   Code:         ${err.code         || 'n/a'}`);
    console.error(`   Response:     ${err.response     || 'n/a'}`);
    console.error(`   ResponseCode: ${err.responseCode || 'n/a'}`);
    console.error(`   Command:      ${err.command      || 'n/a'}`);
    console.error('   ⚠️  Server will continue but OTP emails will fail until fixed.\n');
    return false;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 📧 OTP EMAIL HTML TEMPLATE
// ═══════════════════════════════════════════════════════════════════════════

const generateOTPEmailHTML = (otp, username) => `
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
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">⚡ Aura Gateway</h1>
              <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.9;">Secure SMS Gateway Platform</p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px 30px;">
              <h2 style="margin: 0 0 20px 0; color: #333333; font-size: 24px; font-weight: 600;">Hello, ${username}!</h2>
              <p style="margin: 0 0 20px 0; color: #666666; font-size: 16px; line-height: 1.6;">
                Thank you for registering with <strong>Aura Gateway</strong>. To complete your registration, please use the verification code below:
              </p>

              <!-- OTP Box -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin: 30px 0;">
                <tr>
                  <td align="center" style="background-color: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 30px;">
                    <p style="margin: 0 0 10px 0; color: #666666; font-size: 14px; text-transform: uppercase; letter-spacing: 1px;">Your Verification Code</p>
                    <p style="margin: 0; color: #667eea; font-size: 42px; font-weight: 700; letter-spacing: 8px; font-family: 'Courier New', monospace;">${otp}</p>
                  </td>
                </tr>
              </table>

              <p style="margin: 0 0 15px 0; color: #666666; font-size: 14px; line-height: 1.6;"><strong>⏰ This code will expire in ${OTP_EXPIRY_MINUTES} minutes.</strong></p>
              <p style="margin: 0 0 15px 0; color: #666666; font-size: 14px; line-height: 1.6;">If you didn't request this code, please ignore this email or contact our support team.</p>

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
              <p style="margin: 0 0 10px 0; color: #999999; font-size: 12px;">© 2026 Aura Gateway. All rights reserved.</p>
              <p style="margin: 0; color: #999999; font-size: 12px;">Professional SMS Gateway Platform for Businesses</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

// ═══════════════════════════════════════════════════════════════════════════
// 📧 sendOTPEmail  (FIX: BUG 1 + BUG 4)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Send OTP verification email using the singleton transporter.
 * Always resolves — never throws — so the caller can inspect {success, error}.
 *
 * @param {string} email    - Recipient address
 * @param {string} otp      - 6-digit code
 * @param {string} username - Display name
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
const sendOTPEmail = async (email, otp, username) => {
  if (!emailTransporter) {
    const msg = 'Email transporter not initialised. Check SMTP_* or GMAIL_* env vars.';
    console.error(`❌ sendOTPEmail: ${msg}`);
    return { success: false, error: msg };
  }

  try {
    const info = await emailTransporter.sendMail({
      from: { name: emailFromName, address: emailFromAddress },
      to:      email,
      subject: `Your Aura Gateway Verification Code: ${otp}`,
      html:    generateOTPEmailHTML(otp, username),
      text:    `Hello ${username},\n\nYour Aura Gateway verification code is: ${otp}\n\nThis code will expire in ${OTP_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, please ignore this email.\n\nBest regards,\nAura Gateway Team`
    });

    console.log('\n📧 OTP EMAIL SENT SUCCESSFULLY');
    console.log(`   To:         ${email}`);
    console.log(`   Message ID: ${info.messageId}`);
    console.log(`   Response:   ${info.response || 'n/a'}`);

    return { success: true, error: null };

  } catch (err) {
    // BUG 4 FIX: Log every SMTP diagnostic field individually
    console.error('\n❌ OTP EMAIL SEND FAILED');
    console.error(`   To:           ${email}`);
    console.error(`   Message:      ${err.message}`);
    console.error(`   Code:         ${err.code         || 'n/a'}`);
    console.error(`   ResponseCode: ${err.responseCode || 'n/a'}`);
    console.error(`   Response:     ${err.response     || 'n/a'}`);
    console.error(`   Command:      ${err.command      || 'n/a'}`);

    const reason = err.responseCode
      ? `SMTP ${err.responseCode}: ${err.response || err.message}`
      : err.message;

    return { success: false, error: reason };
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🚦 RATE LIMITING MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

const signupRateLimiter = rateLimit({
  windowMs:       24 * 60 * 60 * 1000,
  max:            RATE_LIMITS.SIGNUP_PER_IP_PER_DAY,
  standardHeaders: true,
  legacyHeaders:   false,
  handler: (req, res) => {
    console.log(`\n🚫 SIGNUP RATE LIMIT EXCEEDED — IP: ${req.ip}`);
    res.status(429).json({
      success:     false,
      error:       'Rate limit exceeded',
      message:     `Maximum ${RATE_LIMITS.SIGNUP_PER_IP_PER_DAY} account creations per day from one IP address.`,
      retry_after: '24 hours'
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ VPN/PROXY DETECTION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

const detectVPN = async (req, res, next) => {
  if (!VPN_DETECTION.enabled) return next();

  try {
    const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

    if (clientIP === '::1' || clientIP === '127.0.0.1' ||
        clientIP.startsWith('192.168.') || clientIP.startsWith('10.')) {
      console.log(`\n✅ VPN CHECK SKIPPED (Local IP): ${clientIP}`);
      return next();
    }

    console.log(`\n🔍 VPN DETECTION — IP: ${clientIP}`);
    const response = await axios.get(
      `${VPN_DETECTION.api}${clientIP}?fields=status,proxy,hosting,query`,
      { timeout: VPN_DETECTION.timeout }
    );
    const data = response.data;
    console.log(`   Proxy: ${data.proxy} | Hosting: ${data.hosting}`);

    if (data.proxy === true || data.hosting === true) {
      console.log(`🚫 VPN/PROXY BLOCKED — IP: ${clientIP}`);
      return res.status(403).json({
        success: false,
        error:   'VPN/Proxy detected',
        message: '🚫 VPNs, Proxies, and Datacenter IPs are not allowed. Please use a residential IP address.',
        ip: clientIP
      });
    }

    console.log('   ✅ Clean IP - Allowed');
    next();
  } catch (error) {
    console.error('⚠️  VPN Detection Error:', error.message);
    console.log('   ⚠️  Allowing request (VPN API unavailable)');
    next();
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// Express Middleware
// ═══════════════════════════════════════════════════════════════════════════

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  console.log(`\n⚡ [${new Date().toISOString()}] ${req.method} ${req.path} — IP: ${req.ip || 'Unknown'}`);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════
// 🗄️ DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  ssl:                     NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max:                     20,
  idleTimeoutMillis:       30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => console.log('🔌 Database connected'));
pool.on('error',   (err) => console.error('💥 Database error:', err));

// ═══════════════════════════════════════════════════════════════════════════
// 📊 DATABASE INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

const initDatabase = async () => {
  try {
    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('📊 Initializing database schema (v5.3 OTP Hardened)...');
    console.log('════════════════════════════════════════════════════════════════\n');

    // ── Core Tables ───────────────────────────────────────────────────────

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

    // ── v5.1 Migrations ───────────────────────────────────────────────────
    console.log('\n🆕 Running v5.1 Titanium migrations...\n');

    const v51Migrations = [
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) UNIQUE;`,               'users.email'],
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;`,     'users.email_verified'],
      [`ALTER TABLE otp_requests ADD COLUMN IF NOT EXISTS email VARCHAR(255);`,               'otp_requests.email'],
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS api_key TEXT;`,                            'users.api_key'],
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS key_status TEXT DEFAULT 'pending';`,       'users.key_status'],
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;`,               'users.credits'],
      [`ALTER TABLE users ADD COLUMN IF NOT EXISTS expiry_date TIMESTAMP;`,                   'users.expiry_date'],
    ];

    for (const [sql, label] of v51Migrations) {
      try { await pool.query(sql); console.log(`✅ Migration: ${label} added/verified`); }
      catch (e) { console.log(`⚠️  Migration: ${label} error:`, e.message); }
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
      console.log('✅ Table "signup_ips" ready');
    } catch (e) { console.log('⚠️  Table "signup_ips" error:', e.message); }

    // ── v5.2 Migrations ───────────────────────────────────────────────────
    console.log('\n🆕 Running v5.2 Global Chat migrations...\n');

    const v52Migrations = [
      [`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS sender_role VARCHAR(50) DEFAULT 'user';`, 'chat_messages.sender_role'],
      [`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_preview TEXT;`,                     'chat_messages.reply_preview'],
    ];

    for (const [sql, label] of v52Migrations) {
      try { await pool.query(sql); console.log(`✅ Migration: ${label} added/verified`); }
      catch (e) { console.log(`⚠️  Migration: ${label} error:`, e.message); }
    }

    // ── v5.3 Migrations (BUG 3 FIX) ──────────────────────────────────────
    console.log('\n🆕 Running v5.3 OTP hardening migrations...\n');

    try {
      await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;`);
      console.log('✅ Migration: users.otp_expires_at added/verified');
    } catch (e) { console.log('⚠️  Migration: users.otp_expires_at error:', e.message); }

    // ── Indexes ───────────────────────────────────────────────────────────
    console.log('\n🔍 Creating indexes...\n');

    const indexes = [
      ['idx_sms_timestamp',        'sms_logs',       'timestamp DESC'],
      ['idx_chat_timestamp',       'chat_messages',  'timestamp DESC'],
      ['idx_chat_reply',           'chat_messages',  'reply_to_id'],
      ['idx_chat_sender_role',     'chat_messages',  'sender_role'],
      ['idx_outgoing_sms_status',  'outgoing_sms',   'status, created_at'],
      ['idx_users_phone',          'users',          'phone'],
      ['idx_users_email',          'users',          'email'],
      ['idx_device_status_device', 'device_status',  'device_id'],
      ['idx_otp_requests',         'otp_requests',   'phone, requested_at'],
      ['idx_otp_requests_email',   'otp_requests',   'email, requested_at'],
      ['idx_login_attempts',       'login_attempts', 'identifier, attempted_at'],
      ['idx_users_api_key',        'users',          'api_key'],
      ['idx_users_key_status',     'users',          'key_status'],
      ['idx_signup_ips_address',   'signup_ips',     'ip_address, created_at'],
      ['idx_users_otp_expires',    'users',          'otp_expires_at'],   // v5.3
    ];

    for (const [name, table, column] of indexes) {
      try { await pool.query(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column});`); console.log(`✅ Index: ${name}`); }
      catch (e) { console.log(`⚠️  Index: ${name} error:`, e.message); }
    }

    // ── Constraints ───────────────────────────────────────────────────────
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
    } catch (e) { console.log('⚠️  Constraint: users.api_key UNIQUE error:', e.message); }

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
    } catch (e) { console.log('⚠️  Constraint: users.provider CHECK error:', e.message); }

    console.log('\n════════════════════════════════════════════════════════════════');
    console.log('🎉 Database initialization complete (v5.3)!');
    console.log('════════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Database initialization failed:', error);
    throw error;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ SECURITY UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const hashPassword = (password) => {
  if (!password || typeof password !== 'string') throw new Error('Password must be a non-empty string');
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const salt = crypto.randomBytes(32);
  const hash = crypto.scryptSync(password, salt, 64);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
};

const verifyPassword = (password, storedHash, storedSalt) => {
  if (!password || !storedHash || !storedSalt) return false;
  try {
    const saltBuffer       = Buffer.from(storedSalt, 'hex');
    const hashBuffer       = crypto.scryptSync(password, saltBuffer, 64);
    const storedHashBuffer = Buffer.from(storedHash, 'hex');
    return crypto.timingSafeEqual(hashBuffer, storedHashBuffer);
  } catch (e) {
    console.error('❌ Password verification error:', e);
    return false;
  }
};

const generateSaaSApiKey = () => `aura_live_${crypto.randomBytes(24).toString('hex')}`;

/**
 * Generate a cryptographically strong 6-digit OTP.
 * Uses crypto.randomInt (unbiased uniform distribution, Node >= 14.10)
 * instead of Math.random which is not cryptographically secure.
 */
const generateOTP = () => String(crypto.randomInt(100000, 1000000));

const validatePhoneAdvanced = (phone) => {
  if (!phone || typeof phone !== 'string') return { valid: false, normalized: null, error: 'Phone number is required' };

  phone = phone.replace(/[\s\-]/g, '');
  if (phone.startsWith('+880'))     phone = '0' + phone.substring(4);
  else if (phone.startsWith('880')) phone = '0' + phone.substring(3);

  if (!/^01[3-9][0-9]{8}$/.test(phone)) {
    return { valid: false, normalized: null, error: 'Invalid Bangladesh phone number. Must be 11 digits starting with 013-019 (e.g., 01712345678)' };
  }

  try {
    const phoneNumber = phoneUtil.parseAndKeepRawInput(phone, 'BD');
    if (!phoneUtil.isValidNumberForRegion(phoneNumber, 'BD')) return { valid: false, normalized: null, error: 'Phone number is not valid for Bangladesh region' };
    if (!phoneUtil.isPossibleNumber(phoneNumber))             return { valid: false, normalized: null, error: 'Phone number format is not possible' };
    return { valid: true, normalized: phone, error: null };
  } catch (e) {
    return { valid: false, normalized: null, error: `Phone validation failed: ${e.message}` };
  }
};

const validateEmail = (email) => {
  if (!email || typeof email !== 'string') return { valid: false, error: 'Email is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'Invalid email format' };
  return { valid: true, error: null };
};

const formatTimestamp = (date) => date ? date.toISOString() : null;

const detectOwnerRole = (deviceId, message, secretKey) => {
  if (deviceId  === ADMIN_DEVICE_ID)                     return '★ OWNER';
  if (secretKey && secretKey === SECRET_OWNER_KEY)        return '★ OWNER';
  if (message   && message.includes(SECRET_OWNER_KEY))   return '★ OWNER';
  return 'User';
};

// ═══════════════════════════════════════════════════════════════════════════
// 🚦 RATE LIMITING UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const checkOTPCooldown = async (identifier) => {
  const windowStart = new Date(Date.now() - RATE_LIMITS.OTP_WINDOW_MINUTES * 60 * 1000);
  const result      = await pool.query(
    `SELECT COUNT(*) as count FROM otp_requests WHERE (phone = $1 OR email = $1) AND requested_at > $2`,
    [identifier, windowStart]
  );
  return parseInt(result.rows[0].count) >= RATE_LIMITS.OTP_REQUESTS;
};

const logOTPRequest = async (client, phone, email) => {
  await client.query(`INSERT INTO otp_requests (phone, email) VALUES ($1, $2)`, [phone, email]);
};

const checkLoginRateLimit = async (identifier) => {
  const windowStart = new Date(Date.now() - RATE_LIMITS.LOGIN_WINDOW_MINUTES * 60 * 1000);
  const result      = await pool.query(
    `SELECT COUNT(*) as count FROM login_attempts WHERE identifier = $1 AND attempted_at > $2`,
    [identifier, windowStart]
  );
  return parseInt(result.rows[0].count) >= RATE_LIMITS.LOGIN_ATTEMPTS;
};

const logLoginAttempt = async (identifier) => {
  await pool.query(`INSERT INTO login_attempts (identifier) VALUES ($1)`, [identifier]);
};

const trackSignupIP = async (client, ip, userId) => {
  try {
    await client.query(`INSERT INTO signup_ips (ip_address, user_id) VALUES ($1, $2)`, [ip, userId]);
  } catch (e) { console.error('⚠️  Failed to track signup IP:', e.message); }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🔐 AUTH MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════════════

const validateApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey || req.body.apiKey;
  if (!apiKey)          return res.status(401).json({ success: false, error: 'API Key required',  message: '🔒 Please provide a valid API key' });
  if (apiKey !== API_KEY) return res.status(403).json({ success: false, error: 'Invalid API Key', message: '⚠️ Authentication failed' });
  next();
};

const verifySaaSKey = async (req, res, next) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'API Key required', message: '🔒 Please provide your SaaS API key' });
    if (!apiKey.startsWith('aura_live_')) return res.status(401).json({ success: false, error: 'Invalid API Key format', message: '⚠️ SaaS API keys must start with "aura_live_"' });

    const result = await pool.query('SELECT id, username, key_status, credits, expiry_date FROM users WHERE api_key = $1', [apiKey]);
    if (result.rows.length === 0) return res.status(403).json({ success: false, error: 'Invalid API Key', message: '⚠️ API key not found' });

    const user = result.rows[0];
    if (user.key_status === 'pending')   return res.status(403).json({ success: false, error: 'Account pending',       message: '⏳ Your account is pending admin approval' });
    if (user.key_status === 'suspended') return res.status(403).json({ success: false, error: 'Account suspended',     message: '🚫 Your account has been suspended' });
    if (user.credits <= 0)               return res.status(403).json({ success: false, error: 'Insufficient credits',  message: '💳 You have 0 credits remaining', credits: user.credits });
    if (user.expiry_date && new Date(user.expiry_date) < new Date()) {
      return res.status(403).json({ success: false, error: 'API key expired', message: '⏰ Your API key has expired' });
    }
    req.saasUser = user;
    next();
  } catch (error) {
    console.error('❌ SaaS Key Verification Error:', error);
    res.status(500).json({ success: false, error: 'Verification failed', message: error.message });
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 🌐 ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// ── Root & Health ─────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    success:  true,
    app:      '⚡ AURA GATEWAY',
    version:  '5.3.0 OTP Hardened',
    database: 'PostgreSQL',
    status:   'operational',
    features: {
      advanced_phone_validation: true,
      email_otp_system:          true,
      otp_expiry_enforced:       true,
      smtp_dual_config:          true,
      smtp_startup_verify:       true,
      vpn_proxy_detection:       true,
      ip_rate_limiting:          true,
      anti_spam:                 true,
      saas_api_management:       true,
      credit_system:             true,
      password_auth:             true,
      chat_system:               true,
      chat_reply_system:         true,
      chat_zero_credit:          true,
      device_health:             true
    }
  });
});

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ success: true, status: 'healthy', database: 'connected', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ success: false, status: 'unhealthy', database: 'disconnected', error: error.message });
  }
});

// ── 🔐 SIGNUP ─────────────────────────────────────────────────────────────

/**
 * POST /api/signup
 *
 * v5.3 fixes applied here:
 *  • Uses singleton emailTransporter (BUG 1)
 *  • Stores otp_expires_at (BUG 3)
 *  • sendOTPEmail returns {success,error} — SMTP reason surfaced in dev (BUG 4)
 *  • OTP generated via crypto.randomInt (stronger entropy)
 */
app.post('/api/signup', signupRateLimiter, detectVPN, async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, phone, email, payment_number, provider, password } = req.body;

    if (!username || !phone || !email || !payment_number || !provider) {
      return res.status(400).json({ success: false, error: 'Missing required fields', required: ['username', 'phone', 'email', 'payment_number', 'provider'] });
    }

    const emailValidation = validateEmail(email);
    if (!emailValidation.valid) return res.status(400).json({ success: false, error: 'Invalid email', message: emailValidation.error });

    const phoneValidation = validatePhoneAdvanced(phone);
    if (!phoneValidation.valid) {
      console.log(`\n⚠️  PHONE VALIDATION FAILED — Input: ${phone} | Error: ${phoneValidation.error}`);
      return res.status(400).json({ success: false, error: 'Invalid phone number', message: phoneValidation.error, examples: ['01712345678', '01812345678', '01912345678'] });
    }
    const normalizedPhone = phoneValidation.normalized;

    const paymentValidation = validatePhoneAdvanced(payment_number);
    if (!paymentValidation.valid) return res.status(400).json({ success: false, error: 'Invalid payment number', message: paymentValidation.error });
    const normalizedPayment = paymentValidation.normalized;

    if (!['bKash', 'Nagad', 'Rocket'].includes(provider)) {
      return res.status(400).json({ success: false, error: 'Invalid payment provider', allowed: ['bKash', 'Nagad', 'Rocket'] });
    }

    // Rate limit
    if (await checkOTPCooldown(email)) {
      return res.status(429).json({ success: false, error: 'Too many OTP requests', message: `Max ${RATE_LIMITS.OTP_REQUESTS} OTP requests per ${RATE_LIMITS.OTP_WINDOW_MINUTES} min`, cooldown: `${RATE_LIMITS.OTP_WINDOW_MINUTES} minutes` });
    }

    // Uniqueness
    if ((await pool.query('SELECT id FROM users WHERE username = $1', [username])).rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Username already exists', message: `The username "${username}" is already taken.` });
    }
    if ((await pool.query('SELECT id FROM users WHERE phone = $1', [normalizedPhone])).rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Phone number already registered', message: `The phone number ${normalizedPhone} is already registered.` });
    }
    if ((await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])).rows.length > 0) {
      return res.status(409).json({ success: false, error: 'Email already registered', message: `The email ${email} is already registered.` });
    }

    // Transaction
    await client.query('BEGIN');
    try {
      // BUG 3 FIX: OTP expiry stored in DB
      const otpCode      = generateOTP();
      const otpExpiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
      const userId       = uuidv4();
      const saasApiKey   = generateSaaSApiKey();

      let passwordHash = null;
      let passwordSalt = null;
      if (password) {
        try {
          const hashed = hashPassword(password);
          passwordHash = hashed.hash;
          passwordSalt = hashed.salt;
        } catch (e) {
          await client.query('ROLLBACK');
          return res.status(400).json({ success: false, error: 'Invalid password', message: e.message });
        }
      }

      await client.query(
        `INSERT INTO users (
           id, username, phone, email, payment_number, provider,
           password_hash, password_salt,
           otp_code, otp_expires_at,
           is_verified, email_verified,
           api_key, key_status, credits
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,false,$11,'pending',0)`,
        [userId, username, normalizedPhone, email.toLowerCase(), normalizedPayment, provider,
         passwordHash, passwordSalt, otpCode, otpExpiresAt, saasApiKey]
      );

      // BUG 1 + 4 FIX: singleton transport, full error surfaced
      const emailResult = await sendOTPEmail(email, otpCode, username);
      if (!emailResult.success) {
        await client.query('ROLLBACK');
        console.error(`❌ OTP email failed for ${email}: ${emailResult.error}`);
        return res.status(500).json({
          success: false,
          error:   'Failed to send OTP email',
          message: 'Email service is currently unavailable. Please try again later.',
          ...(NODE_ENV === 'development' && { smtp_error: emailResult.error })
        });
      }

      await logOTPRequest(client, normalizedPhone, email);
      await trackSignupIP(client, req.ip || 'unknown', userId);
      await client.query('COMMIT');

      console.log(`\n════════════════════════════════════════════════════════════════`);
      console.log(`👤 NEW USER SIGNUP (v5.3)`);
      console.log(`   Username:    ${username}`);
      console.log(`   Phone:       ${normalizedPhone} ✓`);
      console.log(`   Email:       ${email} ✓ (OTP sent)`);
      console.log(`   OTP Expires: ${otpExpiresAt.toISOString()}`);
      console.log(`   API Key:     ${saasApiKey.substring(0, 30)}...`);
      console.log(`   IP:          ${req.ip || 'unknown'}`);
      console.log(`════════════════════════════════════════════════════════════════\n`);

      return res.status(201).json({
        success:        true,
        message:        'User registered successfully. OTP sent to your email.',
        user: { id: userId, username, phone: normalizedPhone, email: email.toLowerCase(), api_key: saasApiKey, key_status: 'pending', credits: 0 },
        otp_sent:       true,
        otp_method:     'email',
        otp_expires_in: `${OTP_EXPIRY_MINUTES} minutes`,
        next_step:      'Check your email for the OTP code, then call POST /api/verify-otp'
      });

    } catch (transactionError) {
      await client.query('ROLLBACK');
      throw transactionError;
    }

  } catch (error) {
    console.error('❌ Signup Error:', error);
    if (error.code === '23505') {
      if (error.constraint === 'users_username_key') return res.status(409).json({ success: false, error: 'Username already exists' });
      if (error.constraint === 'users_phone_key')    return res.status(409).json({ success: false, error: 'Phone already registered' });
      if (error.constraint === 'users_email_key')    return res.status(409).json({ success: false, error: 'Email already registered' });
    }
    res.status(500).json({ success: false, error: 'Signup failed', message: error.message });
  } finally {
    client.release();
  }
});

// ── 🔐 VERIFY OTP  (BUG 3 FIX: checks otp_expires_at) ────────────────────

/**
 * POST /api/verify-otp
 * v5.3: Returns specific errors for wrong code vs expired code.
 */
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { username, otp_code } = req.body;
    if (!username || !otp_code) {
      return res.status(400).json({ success: false, error: 'Missing required fields', required: ['username', 'otp_code'] });
    }

    // Fetch user with expiry fields
    const userResult = await pool.query(
      `SELECT id, username, phone, email, otp_code, otp_expires_at, is_verified FROM users WHERE username = $1`,
      [username]
    );

    if (userResult.rows.length === 0) return res.status(400).json({ success: false, error: 'User not found' });

    const user = userResult.rows[0];

    if (user.is_verified) return res.status(400).json({ success: false, error: 'Account is already verified' });

    if (user.otp_code !== otp_code) return res.status(400).json({ success: false, error: 'Invalid OTP code' });

    // BUG 3 FIX: Enforce expiry
    if (user.otp_expires_at && new Date(user.otp_expires_at) < new Date()) {
      return res.status(400).json({
        success: false,
        error:   'OTP has expired',
        message: `Your OTP expired after ${OTP_EXPIRY_MINUTES} minutes. Please sign up again to receive a new code.`
      });
    }

    // Mark verified, clear OTP fields
    const result = await pool.query(
      `UPDATE users SET is_verified = true, email_verified = true, otp_code = NULL, otp_expires_at = NULL
       WHERE id = $1 RETURNING id, username, phone, email`,
      [user.id]
    );
    const verified = result.rows[0];

    console.log(`\n════════════════════════════════════════════════════════════════`);
    console.log(`✅ OTP VERIFICATION SUCCESS`);
    console.log(`   User:  ${verified.username}`);
    console.log(`   Email: ${verified.email} ✓ verified`);
    console.log(`════════════════════════════════════════════════════════════════\n`);

    return res.json({
      success: true,
      message: 'Account verified successfully',
      user: { id: verified.id, username: verified.username, phone: verified.phone, email: verified.email }
    });

  } catch (error) {
    console.error('❌ OTP Verification Error:', error);
    res.status(500).json({ success: false, error: 'Verification failed', message: error.message });
  }
});

// ── 🔐 LOGIN ──────────────────────────────────────────────────────────────

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, device_id, deviceId } = req.body;
    const finalDeviceId = device_id || deviceId;

    if (!username || !password) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['username', 'password'] });

    if (await checkLoginRateLimit(username)) return res.status(429).json({ success: false, error: 'Too many login attempts', message: 'Rate limit exceeded' });
    await logLoginAttempt(username);

    const userResult = await pool.query('SELECT * FROM users WHERE username = $1 AND is_verified = true', [username]);

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      if (user.password_hash && user.password_salt && verifyPassword(password, user.password_hash, user.password_salt)) {
        console.log(`\n✅ USER LOGIN — ${username}`);
        const token = jwt.sign({ id: user.id, username: user.username, role: 'User' }, process.env.JWT_SECRET, { expiresIn: '1h' });
        return res.json({ success: true, message: 'Login successful', token, user: { id: user.id, username: user.username, phone: user.phone, email: user.email, api_key: user.api_key } });
      }
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
    if (username === ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      console.log(`\n✅ ADMIN LOGIN — ${username}`);
      const adminRole = finalDeviceId === (process.env.ADMIN_DEVICE_ID || ADMIN_DEVICE_ID) ? '★ OWNER' : 'Admin';
      const token     = jwt.sign({ username, role: adminRole }, process.env.JWT_SECRET, { expiresIn: '1h' });
      return res.json({ success: true, message: 'Login successful', token, apiKey: process.env.API_KEY || API_KEY, role: adminRole });
    }

    return res.status(401).json({ success: false, error: 'Invalid credentials or unverified account' });

  } catch (error) {
    console.error('❌ Login Error:', error);
    res.status(500).json({ success: false, error: 'Login failed', message: error.message });
  }
});

// ── 👥 USER MANAGEMENT ────────────────────────────────────────────────────

app.get('/api/users', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, username, phone, email, email_verified, payment_number, provider, is_verified, api_key, key_status, credits, expiry_date, created_at FROM users ORDER BY created_at DESC`);
    res.json({ success: true, count: result.rows.length, users: result.rows.map(u => ({ ...u, expiry_date: formatTimestamp(u.expiry_date), created_at: formatTimestamp(u.created_at) })) });
  } catch (error) {
    console.error('❌ User List Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch users', message: error.message });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.status(401).json({ success: false, error: 'API Key required' });

    const result = await pool.query(`SELECT id, username, phone, email, email_verified, payment_number, provider, is_verified, api_key, key_status, credits, expiry_date, created_at FROM users WHERE api_key = $1`, [apiKey]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Invalid API key' });

    const user = result.rows[0];
    res.json({ success: true, user: { ...user, expiry_date: formatTimestamp(user.expiry_date), created_at: formatTimestamp(user.created_at) } });
  } catch (error) {
    console.error('❌ Get Profile Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch profile', message: error.message });
  }
});

// ── 🔑 ADMIN SAAS MANAGEMENT ──────────────────────────────────────────────

app.post('/api/admin/approve', validateApiKey, async (req, res) => {
  try {
    const { user_id, status } = req.body;
    if (!user_id || !status) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['user_id', 'status'] });
    if (!['active', 'suspended', 'pending'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status', allowed: ['active', 'suspended', 'pending'] });

    const result = await pool.query(`UPDATE users SET key_status = $1 WHERE id = $2 RETURNING id, username, api_key, key_status, credits`, [status, user_id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: `User API key ${status}`, user: result.rows[0] });
  } catch (error) {
    console.error('❌ Admin Approve Error:', error);
    res.status(500).json({ success: false, error: 'Approval failed', message: error.message });
  }
});

app.post('/api/admin/renew', validateApiKey, async (req, res) => {
  try {
    const { user_id, credits, days } = req.body;
    if (!user_id || credits === undefined || days === undefined) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['user_id', 'credits', 'days'] });

    const newExpiryDate = new Date();
    newExpiryDate.setDate(newExpiryDate.getDate() + days);

    const result = await pool.query(`UPDATE users SET credits = credits + $1, expiry_date = $2 WHERE id = $3 RETURNING id, username, api_key, key_status, credits, expiry_date`, [credits, newExpiryDate, user_id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'User not found' });
    res.json({ success: true, message: `Added ${credits} credits and extended expiry by ${days} days`, user: { ...result.rows[0], expiry_date: formatTimestamp(result.rows[0].expiry_date) } });
  } catch (error) {
    console.error('❌ Admin Renew Error:', error);
    res.status(500).json({ success: false, error: 'Renewal failed', message: error.message });
  }
});

// ── 📊 ADMIN STATS & LOGS ─────────────────────────────────────────────────

app.get('/api/admin/stats', validateApiKey, async (req, res) => {
  try {
    const [usersResult, creditsResult] = await Promise.all([
      pool.query('SELECT COUNT(*) AS total FROM users'),
      pool.query('SELECT COALESCE(SUM(credits), 0) AS total FROM users')
    ]);
    res.json({ success: true, stats: { totalUsers: parseInt(usersResult.rows[0].total), totalCredits: parseInt(creditsResult.rows[0].total), activeConnections: pool.totalCount, status: 'operational', version: '5.3.0 OTP Hardened' } });
  } catch (error) {
    console.error('❌ Admin Stats Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch stats', message: error.message });
  }
});

app.get('/api/admin/logs', validateApiKey, async (req, res) => {
  try { res.json({ success: true, count: 0, logs: [] }); }
  catch (error) { res.status(500).json({ success: false, error: 'Failed to fetch logs', message: error.message }); }
});

// ── 📱 SMS GATEWAY ────────────────────────────────────────────────────────

app.get('/api/pending-sms', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM outgoing_sms WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`);
    if (result.rows.length === 0) return res.json({ success: true, pending: false, message: 'No pending SMS' });
    res.json({ success: true, pending: true, sms: { id: result.rows[0].id, recipient: result.rows[0].recipient_number, message: result.rows[0].message_text, created_at: result.rows[0].created_at } });
  } catch (error) {
    console.error('❌ Pending SMS Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch pending SMS', message: error.message });
  }
});

app.post('/api/sms-sent', validateApiKey, async (req, res) => {
  try {
    const { sms_id, status } = req.body;
    if (!sms_id || !status) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['sms_id', 'status'] });
    if (!['sent', 'failed'].includes(status)) return res.status(400).json({ success: false, error: 'Invalid status', allowed: ['sent', 'failed'] });

    const result = await pool.query(`UPDATE outgoing_sms SET status = $1, sent_at = NOW() WHERE id = $2 RETURNING *`, [status, sms_id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'SMS not found' });
    res.json({ success: true, message: 'SMS status updated', sms: result.rows[0] });
  } catch (error) {
    console.error('❌ SMS Update Error:', error);
    res.status(500).json({ success: false, error: 'Failed to update SMS status', message: error.message });
  }
});

app.post('/api/send-sms', verifySaaSKey, async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipient, message } = req.body;
    const user = req.saasUser;
    if (!recipient || !message) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['recipient', 'message'] });

    const phoneValidation = validatePhoneAdvanced(recipient);
    if (!phoneValidation.valid) return res.status(400).json({ success: false, error: 'Invalid recipient phone number', message: phoneValidation.error });

    await client.query('BEGIN');
    const updateResult = await client.query(`UPDATE users SET credits = credits - 1 WHERE id = $1 RETURNING credits`, [user.id]);
    const smsId = uuidv4();
    await client.query(`INSERT INTO outgoing_sms (id, recipient_number, message_text, status) VALUES ($1, $2, $3, 'pending')`, [smsId, phoneValidation.normalized, message]);
    await client.query('COMMIT');

    res.json({ success: true, message: 'SMS queued successfully', sms: { id: smsId, recipient: phoneValidation.normalized, message, status: 'pending' }, credits_remaining: updateResult.rows[0].credits });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Send SMS Error:', error);
    res.status(500).json({ success: false, error: 'Failed to send SMS', message: error.message });
  } finally { client.release(); }
});

app.post('/api/sms', validateApiKey, async (req, res) => {
  try {
    const { sender, message, device_id, deviceId, timestamp } = req.body;
    const finalDeviceId = device_id || deviceId;
    if (!sender || !message || !finalDeviceId) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['sender', 'message', 'device_id'] });

    const smsId        = uuidv4();
    const smsTimestamp = timestamp ? new Date(timestamp) : new Date();
    await pool.query(`INSERT INTO sms_logs (id, sender, message, device_id, timestamp) VALUES ($1, $2, $3, $4, $5)`, [smsId, sender, message, finalDeviceId, smsTimestamp]);

    res.status(201).json({ success: true, message: 'SMS logged successfully', data: { id: smsId, sender, message, device_id: finalDeviceId, timestamp: formatTimestamp(smsTimestamp) } });
  } catch (error) {
    console.error('❌ SMS Logging Error:', error);
    res.status(500).json({ success: false, error: 'Failed to log SMS', message: error.message });
  }
});

app.get('/api/sms', validateApiKey, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
    const result = await pool.query('SELECT * FROM sms_logs ORDER BY timestamp DESC LIMIT $1', [limit]);
    res.json({ success: true, count: result.rows.length, data: result.rows.map(log => ({ id: log.id, sender: log.sender, message: log.message, device_id: log.device_id, timestamp: formatTimestamp(log.timestamp) })) });
  } catch (error) {
    console.error('❌ SMS Fetch Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch SMS logs', message: error.message });
  }
});

// ── 💬 CHAT SYSTEM — v5.2 (zero-credit, reply preview, sender_role) ───────
//
// ⚠️  ZERO-CREDIT GUARANTEE:
//   POST /api/chat uses validateApiKey only (NOT verifySaaSKey).
//   users.credits is NEVER read or written inside this route.

app.post('/api/chat', validateApiKey, async (req, res) => {
  const client = await pool.connect();
  try {
    const { username, message, device_id, deviceId, secret_key, replyToId, senderRole } = req.body;
    const finalDeviceId = device_id || deviceId || null;

    if (!username || !message) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['username', 'message'] });
    if (typeof message !== 'string' || message.trim().length === 0) return res.status(400).json({ success: false, error: 'Message must be a non-empty string' });

    const ownerRoleCheck  = detectOwnerRole(finalDeviceId, message, secret_key);
    const isOwner         = ownerRoleCheck === '★ OWNER';
    const finalRole       = isOwner ? '★ OWNER' : (senderRole && typeof senderRole === 'string' ? senderRole.trim().substring(0, 50) : 'user');
    const finalSenderRole = isOwner ? 'owner'   : (senderRole && typeof senderRole === 'string' ? senderRole.toLowerCase().trim().substring(0, 50) : 'user');

    let resolvedReplyToId     = null;
    let resolvedReplyPreview  = null;
    let resolvedReplyUsername = null;

    if (replyToId) {
      const parentResult = await client.query(`SELECT id, username, message FROM chat_messages WHERE id = $1 LIMIT 1`, [replyToId]);
      if (parentResult.rows.length > 0) {
        const parent          = parentResult.rows[0];
        resolvedReplyToId     = parent.id;
        const rawText         = (parent.message || '').replace(/\r?\n/g, ' ').trim();
        resolvedReplyPreview  = rawText.length > 100 ? rawText.substring(0, 100) + '…' : rawText;
        resolvedReplyUsername = parent.username;
      } else {
        console.warn(`⚠️  Chat reply: parent ${replyToId} not found — ignoring`);
      }
    }

    const messageId = uuidv4();
    const timestamp = new Date();

    await client.query(
      `INSERT INTO chat_messages (id, username, message, role, sender_role, device_id, reply_to_id, reply_preview, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [messageId, username.trim().substring(0, 255), message.trim(), finalRole, finalSenderRole, finalDeviceId, resolvedReplyToId, resolvedReplyPreview, timestamp]
    );

    const saved = (await client.query(
      `SELECT id, username, message, role, sender_role, device_id, reply_to_id, reply_preview, timestamp FROM chat_messages WHERE id = $1`,
      [messageId]
    )).rows[0];

    console.log(`\n💬 CHAT — ${saved.username} (${finalSenderRole}) | reply: ${resolvedReplyToId || 'none'}`);

    return res.status(201).json({
      success: true, message: 'Chat message sent',
      data: {
        id:            saved.id,
        username:      saved.username,
        message:       saved.message,
        role:          saved.role,
        sender_role:   saved.sender_role,
        device_id:     saved.device_id,
        reply_to_id:   saved.reply_to_id,
        reply_preview: saved.reply_preview,
        ...(resolvedReplyToId && { replying_to: { username: resolvedReplyUsername, preview: resolvedReplyPreview } }),
        timestamp: formatTimestamp(saved.timestamp),
        isOwner:   saved.role === '★ OWNER',
      }
    });

  } catch (error) {
    console.error('❌ Chat Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to send message', message: error.message });
  } finally { client.release(); }
});

app.get('/api/chat', validateApiKey, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 50);
    const result = await pool.query(
      `SELECT m.id, m.username, m.message, m.role, m.sender_role, m.device_id,
              m.reply_to_id, m.reply_preview, m.timestamp,
              parent.username AS parent_username,
              COALESCE(m.reply_preview, LEFT(parent.message, 100)) AS resolved_preview
       FROM chat_messages m
       LEFT JOIN chat_messages parent ON m.reply_to_id = parent.id
       ORDER BY m.timestamp DESC LIMIT $1`,
      [limit]
    );

    return res.json({
      success: true,
      count:   result.rows.length,
      data: result.rows.map(row => ({
        id:            row.id,
        username:      row.username,
        message:       row.message,
        role:          row.role,
        sender_role:   row.sender_role || 'user',
        device_id:     row.device_id,
        reply_to_id:   row.reply_to_id,
        reply_preview: row.resolved_preview || null,
        timestamp:     formatTimestamp(row.timestamp),
        isOwner:       row.role === '★ OWNER',
        ...(row.reply_to_id && { replying_to: { username: row.parent_username, preview: row.resolved_preview } }),
      }))
    });
  } catch (error) {
    console.error('❌ Chat Fetch Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to fetch chat messages', message: error.message });
  }
});

app.delete('/api/chat', validateApiKey, async (req, res) => {
  try {
    const { secret_key } = req.body;
    if (secret_key !== SECRET_OWNER_KEY) return res.status(403).json({ success: false, error: 'Admin access required' });

    const countResult   = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const previousCount = parseInt(countResult.rows[0].count);
    await pool.query('DELETE FROM chat_messages');

    return res.json({ success: true, message: 'Chat history cleared', deletedCount: previousCount });
  } catch (error) {
    console.error('❌ Chat Clear Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to clear chat', message: error.message });
  }
});

// ── 🔋 DEVICE HEALTH ──────────────────────────────────────────────────────

app.post('/api/device-health', validateApiKey, async (req, res) => {
  try {
    const { battery_level, is_charging } = req.body;
    if (battery_level === undefined || is_charging === undefined) return res.status(400).json({ success: false, error: 'Missing required fields', required: ['battery_level', 'is_charging'] });
    if (battery_level < 0 || battery_level > 100) return res.status(400).json({ success: false, error: 'Battery level must be between 0 and 100' });

    const result = await pool.query(
      `INSERT INTO device_status (device_id, battery_level, is_charging, last_updated) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (device_id) DO UPDATE SET battery_level = $2, is_charging = $3, last_updated = NOW() RETURNING *`,
      [ADMIN_DEVICE_ID, battery_level, is_charging]
    );
    res.json({ success: true, message: 'Device health updated', device: result.rows[0] });
  } catch (error) {
    console.error('❌ Device Health Error:', error);
    res.status(500).json({ success: false, error: 'Failed to update device health', message: error.message });
  }
});

app.get('/api/device-health', validateApiKey, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM device_status WHERE device_id = $1', [ADMIN_DEVICE_ID]);
    res.json({ success: true, status: 'online', message: 'Device is healthy', device: result.rows.length > 0 ? result.rows[0] : null });
  } catch (error) {
    console.error('❌ Device Health Fetch Error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch device health', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found', path: req.path, method: req.method });
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
    await verifyEmailTransporter(); // BUG 2 FIX: validate SMTP on boot

    app.listen(PORT, () => {
      console.log('\n════════════════════════════════════════════════════════════════');
      console.log('⚡ AURA GATEWAY v5.3 - OTP EMAIL DEBUGGED & HARDENED');
      console.log('════════════════════════════════════════════════════════════════');
      console.log(`📡 Server:      http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`💾 Database:    PostgreSQL (Railway)`);
      console.log('════════════════════════════════════════════════════════════════');
      console.log('✅ v5.1 + v5.2 features preserved:');
      console.log('   - Dual phone validation, VPN detection, IP rate limiting ✓');
      console.log('   - Global Chat (sender_role, reply_preview, zero-credit) ✓');
      console.log('   - Admin ★ OWNER badges, scrypt hashing, atomic txns ✓');
      console.log('════════════════════════════════════════════════════════════════');
      console.log('🔧 v5.3 Email/OTP fixes:');
      console.log('   - BUG 1 FIXED: Singleton SMTP transporter (no rebuild per send)');
      console.log('   - BUG 2 FIXED: SMTP verified on startup (fail-fast on bad creds)');
      console.log('   - BUG 3 FIXED: otp_expires_at stored & enforced in verify-otp');
      console.log('   - BUG 4 FIXED: Full SMTP error details logged (code/response/cmd)');
      console.log('   - BUG 5 FIXED: Dual config — generic SMTP + Gmail App Password');
      console.log('════════════════════════════════════════════════════════════════\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

process.on('SIGTERM', async () => { console.log('\n⚠️  SIGTERM — closing gracefully\n'); await pool.end(); process.exit(0); });
process.on('SIGINT',  async () => { console.log('\n⚠️  SIGINT  — closing gracefully\n'); await pool.end(); process.exit(0); });

startServer();

module.exports = app;
