import { config } from './config.js';
import { logger } from './logger.js';

export class BulkAPI {
  constructor() {
    // Base URL: https://exchange-api.bulk.trade/api/v1
    this.baseUrl = config.bulk.apiUrl || 'https://exchange-api.bulk.trade/api/v1';
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
      logger.debug(`API Response (${response.status}): ${text.substring(0, 1000)}`);

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

  /**
   * Get full account data including positions
   * POST /account with { type: "fullAccount", user: "wallet_address" }
   * 
   * Response format (from docs):
   * [{ "fullAccount": { margin: {...}, positions: [...], openOrders: [...], leverageSettings: [...] } }]
   */
  async getFullAccount(walletAddress) {
    const cacheKey = `fullAccount_${walletAddress}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.fetch('/account', {
        method: 'POST',
        body: JSON.stringify({
          type: 'fullAccount',
          user: walletAddress,
        }),
      });

      logger.debug('Full account response:', JSON.stringify(response));

      // Response is array: [{ "fullAccount": {...} }]
      let accountData = null;
      
      if (Array.isArray(response) && response.length > 0) {
        // Find the fullAccount object in the array
        const fullAccountObj = response.find(item => item.fullAccount);
        if (fullAccountObj) {
          accountData = fullAccountObj.fullAccount;
        }
      } else if (response.fullAccount) {
        accountData = response.fullAccount;
      } else if (response.margin || response.positions) {
        // Direct format
        accountData = response;
      }

      if (accountData) {
        this.setCache(cacheKey, accountData);
      }

      return accountData;
    } catch (error) {
      logger.error(`Failed to get full account for ${walletAddress}:`, error.message);
      return null;
    }
  }

  /**
   * Get positions for a wallet
   * Uses fullAccount query and extracts positions array
   */
  async getPositions(walletAddress) {
    const cacheKey = `positions_${walletAddress}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const accountData = await this.getFullAccount(walletAddress);
      
      if (!accountData) {
        logger.warn(`No account data found for ${walletAddress}`);
        return [];
      }

      const positions = accountData.positions || [];
      
      logger.info(`Found ${positions.length} positions for ${walletAddress.substring(0, 8)}...`);

      // Normalize position data according to docs:
      // Fields: symbol, size, price, fairPrice, notional, realizedPnl, unrealizedPnl,
      //         leverage, liquidationPrice, fees, funding, maintenanceMargin, lambda, riskAllocation, allocMargin
      const normalizedPositions = positions
        .filter(pos => pos && pos.size && pos.size !== 0)
        .map(pos => ({
          symbol: pos.symbol,
          size: parseFloat(pos.size || 0),
          entryPrice: parseFloat(pos.price || 0),  // VWAP entry price
          markPrice: parseFloat(pos.fairPrice || 0),  // Current fair/mark price
          notional: parseFloat(pos.notional || 0),
          unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
          realizedPnl: parseFloat(pos.realizedPnl || 0),
          leverage: parseFloat(pos.leverage || 1),
          liquidationPrice: parseFloat(pos.liquidationPrice || 0),
          maintenanceMargin: parseFloat(pos.maintenanceMargin || 0),
          fees: parseFloat(pos.fees || 0),
          funding: parseFloat(pos.funding || 0),
        }));

      this.setCache(cacheKey, normalizedPositions);
      return normalizedPositions;
    } catch (error) {
      logger.error(`Failed to get positions for ${walletAddress}:`, error.message);
      return [];
    }
  }

  /**
   * Get mark price for a symbol
   * GET /ticker/{symbol}
   */
  async getMarkPrice(symbol) {
    const cacheKey = `markprice_${symbol}`;
    const cached = this.getFromCache(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.fetch(`/ticker/${symbol}`);
      
      logger.debug(`Mark price response for ${symbol}:`, JSON.stringify(response));

      // From docs: markPrice field in response
      const markPrice = parseFloat(
        response.markPrice || 
        response.lastPrice ||
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

  /**
   * Get margin info for a wallet
   */
  async getMarginInfo(walletAddress) {
    try {
      const accountData = await this.getFullAccount(walletAddress);
      return accountData?.margin || null;
    } catch (error) {
      logger.error(`Failed to get margin info:`, error.message);
      return null;
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
