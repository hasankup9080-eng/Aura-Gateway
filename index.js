/**
 * ⚡ AURA GATEWAY - Premium Backend Server
 * Lynx Aesthetic | Dark Theme Compatible
 * Production-Ready for Railway Deployment
 * 
 * NOW WITH POSTGRESQL PERSISTENCE
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

// ============================================================================
// APPLICATION CONFIGURATION
// ============================================================================

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security Configuration
const API_KEY = process.env.API_KEY || 'lynx-aura-gateway-2025';
const ADMIN_DEVICE_ID = process.env.ADMIN_DEVICE_ID || 'admin-device-001';
const SECRET_OWNER_KEY = process.env.SECRET_OWNER_KEY || '★LYNX★';

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

// ============================================================================
// POSTGRESQL DATABASE CONFIGURATION
// ============================================================================

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

// ============================================================================
// DATABASE SCHEMA INITIALIZATION
// ============================================================================

/**
 * Create database tables if they don't exist
 */
const initializeDatabase = async () => {
  try {
    console.log('📊 Initializing database schema...');

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

    // Create Chat Messages Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id UUID PRIMARY KEY,
        username VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'User',
        device_id VARCHAR(255),
        timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('✅ Table "chat_messages" ready');

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sms_timestamp ON sms_logs(timestamp DESC);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chat_timestamp ON chat_messages(timestamp DESC);
    `);
    console.log('✅ Database indexes created');

    console.log('🎉 Database initialization complete!');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    throw error;
  }
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * API Key Validation Middleware
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
 * Detect if user is an OWNER
 * @param {string} deviceId - Device ID from request
 * @param {string} message - Message content
 * @param {string} secretKey - Optional secret key
 * @returns {string} - 'User' or '★ OWNER'
 */
const detectOwnerRole = (deviceId, message, secretKey) => {
  // Check if device ID matches admin device
  if (deviceId === ADMIN_DEVICE_ID) {
    return '★ OWNER';
  }
  
  // Check if secret key is provided
  if (secretKey && secretKey === SECRET_OWNER_KEY) {
    return '★ OWNER';
  }
  
  // Check if message contains secret owner key
  if (message && message.includes(SECRET_OWNER_KEY)) {
    return '★ OWNER';
  }
  
  return 'User';
};

/**
 * Format timestamp for Lynx aesthetic
 * @param {Date} date - Date object
 * @returns {string} - Formatted timestamp
 */
const formatTimestamp = (date) => {
  return date.toISOString();
};

// ============================================================================
// API ROUTES
// ============================================================================

// ----------------------------------------------------------------------------
// ROOT & HEALTH CHECK
// ----------------------------------------------------------------------------

/**
 * Root endpoint - API Information
 */
app.get('/', (req, res) => {
  res.json({
    success: true,
    app: '⚡ AURA GATEWAY',
    version: '2.0.0',
    database: 'PostgreSQL',
    theme: 'Lynx Premium',
    status: 'operational',
    endpoints: {
      sms: 'POST /api/sms - Receive and log SMS data',
      chatSend: 'POST /api/chat - Send a chat message',
      chatFetch: 'GET /api/chat - Fetch last 50 messages',
      health: 'GET /health - Server health check'
    },
    security: 'API Key required for all endpoints',
    documentation: 'Include x-api-key in headers or apiKey in request body'
  });
});

/**
 * Health Check Endpoint with Database Status
 */
app.get('/health', async (req, res) => {
  try {
    // Test database connection
    const result = await pool.query('SELECT NOW()');
    
    // Get table counts
    const smsCount = await pool.query('SELECT COUNT(*) FROM sms_logs');
    const chatCount = await pool.query('SELECT COUNT(*) FROM chat_messages');
    
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      memory: {
        smsCount: parseInt(smsCount.rows[0].count),
        chatCount: parseInt(chatCount.rows[0].count)
      },
      dbTime: result.rows[0].now
    });
  } catch (error) {
    console.error('❌ Health check failed:', error);
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ----------------------------------------------------------------------------
// SMS ENDPOINT
// ----------------------------------------------------------------------------

/**
 * POST /api/sms - Receive and log SMS data to PostgreSQL
 * 
 * Request Body:
 * {
 *   sender: string (phone number),
 *   message: string,
 *   device_id: string,
 *   timestamp?: string (optional, auto-generated if not provided)
 * }
 */
app.post('/api/sms', validateApiKey, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { sender, message, device_id, timestamp } = req.body;
    
    // Validation
    if (!sender || !message || !device_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['sender', 'message', 'device_id']
      });
    }
    
    // Create SMS entry
    const id = uuidv4();
    const smsTimestamp = timestamp ? new Date(timestamp) : new Date();
    
    // Insert into PostgreSQL
    const query = `
      INSERT INTO sms_logs (id, sender, message, device_id, timestamp)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    
    const values = [
      id,
      sender.trim(),
      message.trim(),
      device_id.trim(),
      smsTimestamp
    ];
    
    const result = await client.query(query, values);
    const smsEntry = result.rows[0];
    
    // Premium Console Logging
    console.log('📱 NEW SMS RECEIVED & SAVED TO DATABASE');
    console.log(`   ID: ${smsEntry.id}`);
    console.log(`   From: ${smsEntry.sender}`);
    console.log(`   Device: ${smsEntry.device_id}`);
    console.log(`   Message: ${smsEntry.message}`);
    console.log(`   Time: ${formatTimestamp(smsEntry.timestamp)}`);
    
    res.status(201).json({
      success: true,
      message: '✅ SMS logged successfully to database',
      data: {
        id: smsEntry.id,
        sender: smsEntry.sender,
        message: smsEntry.message,
        deviceId: smsEntry.device_id,
        timestamp: smsEntry.timestamp,
        createdAt: smsEntry.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ SMS Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to log SMS',
      message: error.message
    });
  } finally {
    client.release();
  }
});

/**
 * GET /api/sms - Retrieve all SMS messages from database
 */
app.get('/api/sms', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
    
    const query = `
      SELECT id, sender, message, device_id, timestamp, created_at
      FROM sms_logs
      ORDER BY timestamp DESC
      LIMIT $1;
    `;
    
    const result = await pool.query(query, [limit]);
    
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(row => ({
        id: row.id,
        sender: row.sender,
        message: row.message,
        deviceId: row.device_id,
        timestamp: row.timestamp,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('❌ SMS Fetch Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch SMS messages',
      message: error.message
    });
  }
});

// ----------------------------------------------------------------------------
// PREMIUM GLOBAL CHAT ENDPOINTS
// ----------------------------------------------------------------------------

/**
 * POST /api/chat - Send a chat message and save to PostgreSQL
 * 
 * Request Body:
 * {
 *   username: string,
 *   message: string,
 *   device_id?: string (snake_case - preferred),
 *   deviceId?: string (camelCase - also accepted),
 *   secret_key?: string (optional, for owner verification)
 * }
 */
app.post('/api/chat', validateApiKey, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { username, message, device_id, deviceId, secret_key } = req.body;
    
    // Validation
    if (!username || !message) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields',
        required: ['username', 'message']
      });
    }
    
    // Accept both device_id (snake_case) and deviceId (camelCase) with fallback
    const final_device_id = device_id || deviceId || 'unknown';
    
    // Detect owner role
    const role = detectOwnerRole(final_device_id, message, secret_key);
    
    // Create chat message
    const id = uuidv4();
    const timestamp = new Date();
    
    // Insert into PostgreSQL
    const query = `
      INSERT INTO chat_messages (id, username, message, role, device_id, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    
    const values = [
      id,
      username.trim(),
      message.trim(),
      role,
      final_device_id,
      timestamp
    ];
    
    const result = await client.query(query, values);
    const chatMessage = result.rows[0];
    
    // Premium Console Logging
    const roleIcon = role === '★ OWNER' ? '👑' : '💬';
    console.log(`${roleIcon} NEW CHAT MESSAGE SAVED TO DATABASE`);
    console.log(`   User: ${chatMessage.username}`);
    console.log(`   Role: ${chatMessage.role}`);
    console.log(`   Device: ${chatMessage.device_id}`);
    console.log(`   Message: ${chatMessage.message}`);
    console.log(`   Time: ${formatTimestamp(chatMessage.timestamp)}`);
    
    res.status(201).json({
      success: true,
      message: '✅ Message sent successfully',
      data: {
        id: chatMessage.id,
        username: chatMessage.username,
        message: chatMessage.message,
        role: chatMessage.role,
        device_id: chatMessage.device_id,
        deviceId: chatMessage.device_id, // Return both formats for compatibility
        timestamp: formatTimestamp(chatMessage.timestamp),
        isOwner: chatMessage.role === '★ OWNER'
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
 * GET /api/chat - Fetch last 50 chat messages from PostgreSQL
 * 
 * Query Parameters:
 * - limit (optional): Number of messages to fetch (max 50)
 */
app.get('/api/chat', validateApiKey, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);
    
    // Query last N messages, ordered by timestamp descending
    const query = `
      SELECT id, username, message, role, device_id, timestamp, created_at
      FROM chat_messages
      ORDER BY timestamp DESC
      LIMIT $1;
    `;
    
    const result = await pool.query(query, [limit]);
    
    // Messages are already in DESC order, but we might want to reverse for display
    const messages = result.rows.map(row => ({
      id: row.id,
      username: row.username,
      message: row.message,
      role: row.role,
      device_id: row.device_id,
      deviceId: row.device_id, // Return both formats for compatibility
      timestamp: formatTimestamp(row.timestamp),
      isOwner: row.role === '★ OWNER'
    }));
    
    // Get total message count
    const countResult = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const totalCount = parseInt(countResult.rows[0].count);
    
    res.json({
      success: true,
      count: messages.length,
      total: totalCount,
      data: messages
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
 * DELETE /api/chat - Clear all chat messages from database (Admin only)
 */
app.delete('/api/chat', validateApiKey, async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { secret_key } = req.body;
    
    // Verify admin access
    if (secret_key !== SECRET_OWNER_KEY) {
      return res.status(403).json({
        success: false,
        error: 'Admin access required'
      });
    }
    
    // Get count before deletion
    const countResult = await pool.query('SELECT COUNT(*) FROM chat_messages');
    const previousCount = parseInt(countResult.rows[0].count);
    
    // Delete all messages
    await client.query('DELETE FROM chat_messages');
    
    console.log(`🗑️  CHAT CLEARED FROM DATABASE - ${previousCount} messages deleted`);
    
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
 * GET /api/chat/stats - Get chat statistics (optional bonus endpoint)
 */
app.get('/api/chat/stats', validateApiKey, async (req, res) => {
  try {
    const statsQuery = `
      SELECT 
        COUNT(*) as total_messages,
        COUNT(DISTINCT username) as unique_users,
        COUNT(CASE WHEN role = '★ OWNER' THEN 1 END) as owner_messages,
        COUNT(CASE WHEN role = 'User' THEN 1 END) as user_messages,
        MAX(timestamp) as last_message_time,
        MIN(timestamp) as first_message_time
      FROM chat_messages;
    `;
    
    const result = await pool.query(statsQuery);
    const stats = result.rows[0];
    
    res.json({
      success: true,
      stats: {
        totalMessages: parseInt(stats.total_messages),
        uniqueUsers: parseInt(stats.unique_users),
        ownerMessages: parseInt(stats.owner_messages),
        userMessages: parseInt(stats.user_messages),
        lastMessageTime: stats.last_message_time,
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

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * 404 Handler
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.path,
    method: req.method,
    message: '⚠️ The requested endpoint does not exist'
  });
});

/**
 * Global Error Handler
 */
app.use((error, req, res, next) => {
  console.error('💥 UNHANDLED ERROR:', error);
  
  res.status(error.status || 500).json({
    success: false,
    error: NODE_ENV === 'production' ? 'Internal server error' : error.message,
    ...(NODE_ENV === 'development' && { stack: error.stack })
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * Start the server
 */
const startServer = async () => {
  try {
    // Initialize database schema
    await initializeDatabase();
    
    // Start listening
    app.listen(PORT, () => {
      console.log('\n');
      console.log('═══════════════════════════════════════════════════');
      console.log('⚡ AURA GATEWAY - Premium Backend Server v2.0');
      console.log('🎨 Lynx Aesthetic | Dark Theme Compatible');
      console.log('🗄️  PostgreSQL Database Enabled');
      console.log('═══════════════════════════════════════════════════');
      console.log(`📡 Server: http://localhost:${PORT}`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`🔒 API Key: ${API_KEY.substring(0, 10)}...`);
      console.log(`👑 Admin Device: ${ADMIN_DEVICE_ID}`);
      console.log(`💾 Database: PostgreSQL (Railway)`);
      console.log(`⏰ Started: ${new Date().toISOString()}`);
      console.log('═══════════════════════════════════════════════════');
      console.log('✅ Server is running with persistent storage');
      console.log('\n');
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('⚠️  SIGTERM signal received: closing server gracefully');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('⚠️  SIGINT signal received: closing server gracefully');
  await pool.end();
  process.exit(0);
});

// Start the server
startServer();

// Export for testing
module.exports = app;
