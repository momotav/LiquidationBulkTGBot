import { config } from './config.js';
import { logger } from './logger.js';

export class BulkAPI {
  constructor() {
    this.baseUrl = config.bulk.apiUrl;
    this.cache = new Map();
    this.cacheTimeout = 5000; // 5 seconds cache
  }

  async fetch(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    
    logger.debug(`API Request: ${options.method || 'GET'} ${url}`);
    if (options.body) {
      logger.debug(`Request body: ${options.body}`);
    }

    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      const text = await response.text();
      logger.debug(`API Response (${response.status}): ${text.substring(0, 500)}`);

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText} - ${text}`);
      }

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (error) {
      logger.error(`BULK API error (${endpoint}):`, error.message);
      throw error;
    }
  }

  // Get positions for a wallet
  async getPositions(walletAddress) {
    const cacheKey = `positions_${walletAddress}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      // Try different endpoint formats
      let response;
      let positions = [];

      // Attempt 1: POST to /positions with account in body
      try {
        response = await this.fetch('/positions', {
          method: 'POST',
          body: JSON.stringify({
            account: walletAddress,
          }),
        });
        logger.debug('Positions response (POST /positions):', JSON.stringify(response));
      } catch (e) {
        logger.debug('POST /positions failed, trying alternatives...');
      }

      // Attempt 2: GET with query parameter
      if (!response) {
        try {
          response = await this.fetch(`/positions?account=${walletAddress}`);
          logger.debug('Positions response (GET /positions?account=):', JSON.stringify(response));
        } catch (e) {
          logger.debug('GET /positions?account= failed, trying alternatives...');
        }
      }

      // Attempt 3: GET with wallet in path
      if (!response) {
        try {
          response = await this.fetch(`/positions/${walletAddress}`);
          logger.debug('Positions response (GET /positions/:wallet):', JSON.stringify(response));
        } catch (e) {
          logger.debug('GET /positions/:wallet failed');
        }
      }

      if (!response) {
        logger.error('All position fetch attempts failed');
        return [];
      }

      // Parse response - handle different possible formats
      if (Array.isArray(response)) {
        positions = response;
      } else if (response.positions) {
        positions = response.positions;
      } else if (response.data) {
        positions = Array.isArray(response.data) ? response.data : [response.data];
      } else if (response.result) {
        positions = Array.isArray(response.result) ? response.result : [response.result];
      } else if (typeof response === 'object' && response !== null) {
        // Maybe the response itself is a single position or keyed by symbol
        const keys = Object.keys(response);
        if (keys.length > 0 && keys[0].includes('-')) {
          // Keyed by symbol like { "BTC-USD": { ... } }
          positions = keys.map(symbol => ({ symbol, ...response[symbol] }));
        } else if (response.symbol || response.size || response.market) {
          // Single position object
          positions = [response];
        }
      }

      logger.info(`Found ${positions.length} positions for ${walletAddress.substring(0, 8)}...`);

      // Normalize position data
      const normalizedPositions = positions
        .filter(pos => pos && (pos.size || pos.quantity || pos.amount))
        .map(pos => ({
          symbol: pos.symbol || pos.market || pos.pair || 'UNKNOWN',
          size: parseFloat(pos.size || pos.quantity || pos.amount || 0),
          entryPrice: parseFloat(pos.entryPrice || pos.entry_price || pos.avgEntryPrice || pos.avg_entry_price || pos.averagePrice || 0),
          unrealizedPnl: parseFloat(pos.unrealizedPnl || pos.unrealized_pnl || pos.pnl || pos.uPnl || 0),
          marginUsed: parseFloat(pos.marginUsed || pos.margin_used || pos.margin || pos.collateral || 0),
          liquidationPrice: parseFloat(pos.liquidationPrice || pos.liquidation_price || pos.liqPrice || pos.liq_price || 0) || null,
          leverage: parseFloat(pos.leverage || 20),
        }));

      this.setCache(cacheKey, normalizedPositions);
      return normalizedPositions;
    } catch (error) {
      logger.error(`Failed to get positions for ${walletAddress}:`, error.message);
      return [];
    }
  }

  // Get mark price for a symbol
  async getMarkPrice(symbol) {
    const cacheKey = `markprice_${symbol}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      let response;

      // Try different endpoint formats
      try {
        response = await this.fetch(`/ticker/${symbol}`);
      } catch (e) {
        try {
          response = await this.fetch(`/ticker?symbol=${symbol}`);
        } catch (e2) {
          response = await this.fetch(`/markets/${symbol}`);
        }
      }

      logger.debug(`Mark price response for ${symbol}:`, JSON.stringify(response));

      const markPrice = parseFloat(
        response.markPrice || 
        response.mark_price || 
        response.price || 
        response.lastPrice ||
        response.last_price ||
        response.last ||
        response.mid ||
        response.midPrice ||
        0
      );

      if (markPrice > 0) {
        this.setCache(cacheKey, markPrice);
      }
      
      return markPrice;
    } catch (error) {
      logger.error(`Failed to get mark price for ${symbol}:`, error.message);
      return 0;
    }
  }

  // Cache helpers
  getFromCache(key) {
    const item = this.cache.get(key);
    if (item && Date.now() - item.timestamp < this.cacheTimeout) {
      return item.data;
    }
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  clearCache() {
    this.cache.clear();
  }
}
