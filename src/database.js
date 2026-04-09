import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

class Database {
  constructor() {
    this.pool = null;
    this.alertCache = new Map(); // In-memory cache for alert timestamps
  }

  async connect() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      logger.warn('DATABASE_URL not set - running without database');
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });

      await this.pool.query('SELECT NOW()');
      logger.info('✅ Connected to PostgreSQL');

      await this.initTables();
      return true;
    } catch (error) {
      logger.error('Failed to connect to PostgreSQL:', error.message);
      return false;
    }
  }

  async initTables() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        chat_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        wallet_address VARCHAR(255),
        global_alerts BOOLEAN DEFAULT TRUE,
        alert_threshold DECIMAL DEFAULT 5.0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_users_global_alerts ON users(global_alerts);
    `;

    try {
      await this.pool.query(createTableQuery);
      logger.info('✅ Database tables initialized');
    } catch (error) {
      logger.error('Failed to create tables:', error.message);
      throw error;
    }
  }

  // Add or update subscriber
  async addSubscriber(chatId, username, firstName) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        `INSERT INTO users (chat_id, username, first_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (chat_id) 
         DO UPDATE SET username = $2, first_name = $3, updated_at = NOW()`,
        [chatId, username, firstName]
      );
      return true;
    } catch (error) {
      logger.error('Failed to add subscriber:', error.message);
      return false;
    }
  }

  // Remove subscriber
  async removeSubscriber(chatId) {
    if (!this.pool) return false;

    try {
      await this.pool.query('DELETE FROM users WHERE chat_id = $1', [chatId]);
      return true;
    } catch (error) {
      logger.error('Failed to remove subscriber:', error.message);
      return false;
    }
  }

  // Get user by chat ID
  async getUser(chatId) {
    if (!this.pool) return null;

    try {
      const result = await this.pool.query(
        'SELECT * FROM users WHERE chat_id = $1',
        [chatId]
      );
      return result.rows[0] || null;
    } catch (error) {
      logger.error('Failed to get user:', error.message);
      return null;
    }
  }

  // Get all users
  async getAllUsers() {
    if (!this.pool) return [];

    try {
      const result = await this.pool.query('SELECT * FROM users');
      return result.rows;
    } catch (error) {
      logger.error('Failed to get all users:', error.message);
      return [];
    }
  }

  // Get users with wallets connected
  async getUsersWithWallets() {
    if (!this.pool) return [];

    try {
      const result = await this.pool.query(
        'SELECT * FROM users WHERE wallet_address IS NOT NULL'
      );
      return result.rows;
    } catch (error) {
      logger.error('Failed to get users with wallets:', error.message);
      return [];
    }
  }

  // Set user wallet
  async setUserWallet(chatId, walletAddress) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        `UPDATE users SET wallet_address = $2, updated_at = NOW() WHERE chat_id = $1`,
        [chatId, walletAddress]
      );
      return true;
    } catch (error) {
      logger.error('Failed to set user wallet:', error.message);
      return false;
    }
  }

  // Remove user wallet
  async removeUserWallet(chatId) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        `UPDATE users SET wallet_address = NULL, updated_at = NOW() WHERE chat_id = $1`,
        [chatId]
      );
      return true;
    } catch (error) {
      logger.error('Failed to remove user wallet:', error.message);
      return false;
    }
  }

  // Set global alerts preference
  async setGlobalAlerts(chatId, enabled) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        `UPDATE users SET global_alerts = $2, updated_at = NOW() WHERE chat_id = $1`,
        [chatId, enabled]
      );
      return true;
    } catch (error) {
      logger.error('Failed to set global alerts:', error.message);
      return false;
    }
  }

  // Get subscriber count
  async getSubscriberCount() {
    if (!this.pool) return 0;

    try {
      const result = await this.pool.query('SELECT COUNT(*) FROM users');
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error('Failed to get subscriber count:', error.message);
      return 0;
    }
  }

  // Alert caching (in-memory to prevent spam)
  async getLastAlert(key) {
    return this.alertCache.get(key) || null;
  }

  async setLastAlert(key, timestamp) {
    this.alertCache.set(key, timestamp);
    
    // Clean old entries (older than 10 minutes)
    const tenMinutesAgo = Date.now() - 600000;
    for (const [k, v] of this.alertCache.entries()) {
      if (v < tenMinutesAgo) {
        this.alertCache.delete(k);
      }
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      logger.info('Database connection closed');
    }
  }
}

export const db = new Database();
