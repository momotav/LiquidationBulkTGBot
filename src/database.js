import pg from 'pg';
import { logger } from './logger.js';

const { Pool } = pg;

class Database {
  constructor() {
    this.pool = null;
  }

  async connect() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      logger.warn('DATABASE_URL not set - using in-memory storage (subscribers will be lost on restart)');
      return false;
    }

    try {
      this.pool = new Pool({
        connectionString,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      });

      // Test connection
      await this.pool.query('SELECT NOW()');
      logger.info('✅ Connected to PostgreSQL');

      // Create tables
      await this.initTables();
      return true;
    } catch (error) {
      logger.error('Failed to connect to PostgreSQL:', error.message);
      return false;
    }
  }

  async initTables() {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS subscribers (
        chat_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        subscribed_at TIMESTAMP DEFAULT NOW(),
        is_active BOOLEAN DEFAULT TRUE
      );

      CREATE INDEX IF NOT EXISTS idx_subscribers_active ON subscribers(is_active);
    `;

    try {
      await this.pool.query(createTableQuery);
      logger.info('✅ Database tables initialized');
    } catch (error) {
      logger.error('Failed to create tables:', error.message);
      throw error;
    }
  }

  async addSubscriber(chatId, username, firstName) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        `INSERT INTO subscribers (chat_id, username, first_name, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (chat_id) 
         DO UPDATE SET is_active = TRUE, username = $2, first_name = $3`,
        [chatId, username, firstName]
      );
      return true;
    } catch (error) {
      logger.error('Failed to add subscriber:', error.message);
      return false;
    }
  }

  async removeSubscriber(chatId) {
    if (!this.pool) return false;

    try {
      await this.pool.query(
        'UPDATE subscribers SET is_active = FALSE WHERE chat_id = $1',
        [chatId]
      );
      return true;
    } catch (error) {
      logger.error('Failed to remove subscriber:', error.message);
      return false;
    }
  }

  async isSubscribed(chatId) {
    if (!this.pool) return false;

    try {
      const result = await this.pool.query(
        'SELECT is_active FROM subscribers WHERE chat_id = $1',
        [chatId]
      );
      return result.rows.length > 0 && result.rows[0].is_active;
    } catch (error) {
      logger.error('Failed to check subscription:', error.message);
      return false;
    }
  }

  async getActiveSubscribers() {
    if (!this.pool) return [];

    try {
      const result = await this.pool.query(
        'SELECT chat_id FROM subscribers WHERE is_active = TRUE'
      );
      return result.rows.map(row => row.chat_id);
    } catch (error) {
      logger.error('Failed to get subscribers:', error.message);
      return [];
    }
  }

  async getSubscriberCount() {
    if (!this.pool) return 0;

    try {
      const result = await this.pool.query(
        'SELECT COUNT(*) FROM subscribers WHERE is_active = TRUE'
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error) {
      logger.error('Failed to get subscriber count:', error.message);
      return 0;
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
