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
    
    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
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
      const response = await this.fetch('/positions', {
        method: 'POST',
        body: JSON.stringify({
          account: walletAddress,
        }),
      });

      // Parse response - adjust based on actual API response format
      const positions = response.positions || response.data || response || [];
      
      // Normalize position data
      const normalizedPositions = positions.map(pos => ({
        symbol: pos.symbol || pos.market,
        size: parseFloat(pos.size || pos.quantity || 0),
        entryPrice: parseFloat(pos.entryPrice || pos.entry_price || pos.avgEntryPrice || 0),
        unrealizedPnl: parseFloat(pos.unrealizedPnl || pos.unrealized_pnl || pos.pnl || 0),
        marginUsed: parseFloat(pos.marginUsed || pos.margin_used || pos.margin || 0),
        liquidationPrice: pos.liquidationPrice || pos.liquidation_price || pos.liqPrice || null,
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
      const response = await this.fetch(`/ticker/${symbol}`);
      
      const markPrice = parseFloat(
        response.markPrice || 
        response.mark_price || 
        response.price || 
        response.lastPrice ||
        0
      );

      this.setCache(cacheKey, markPrice);
      return markPrice;
    } catch (error) {
      logger.error(`Failed to get mark price for ${symbol}:`, error.message);
      return 0;
    }
  }

  // Get all tickers
  async getAllTickers() {
    const cacheKey = 'all_tickers';
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.fetch('/tickers');
      this.setCache(cacheKey, response);
      return response;
    } catch (error) {
      logger.error('Failed to get tickers:', error.message);
      return {};
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
