import WebSocket from 'ws';
import { config } from './config.js';
import { logger } from './logger.js';

export class BulkWebSocket {
  constructor(onLiquidation) {
    this.wsUrl = config.bulk.wsUrl;
    this.markets = config.bulk.markets;
    this.onLiquidation = onLiquidation;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.isConnected = false;
  }

  connect() {
    logger.info(`Connecting to BULK WebSocket: ${this.wsUrl}`);

    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));
      this.ws.on('error', (error) => this.handleError(error));
      
      // Handle ping/pong (server sends ping every 30s, we must respond with pong)
      this.ws.on('ping', () => {
        this.ws.pong();
        logger.debug('Received ping, sent pong');
      });
    } catch (error) {
      logger.error('Failed to create WebSocket connection:', error.message);
      this.scheduleReconnect();
    }
  }

  handleOpen() {
    logger.info('✅ Connected to BULK WebSocket');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Subscribe to trade channels for all supported markets
    this.subscribeToMarkets();
  }

  subscribeToMarkets() {
    // Format: trade.BTC-USD, trade.ETH-USD, etc.
    const streams = this.markets.map((market) => `trade.${market}`);

    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: streams,
      id: Date.now()
    };

    logger.info(`Subscribing to: ${streams.join(', ')}`);
    logger.debug('Subscribe message:', JSON.stringify(subscribeMessage));
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  handleMessage(rawData) {
    try {
      const msg = JSON.parse(rawData.toString());
      
      logger.debug('WS message:', JSON.stringify(msg).substring(0, 500));

      // Skip subscription confirmations and other non-trade messages
      if (!msg.data || !msg.data.price) {
        // Could be subscription response
        if (msg.result !== undefined || msg.id) {
          logger.info('Subscription confirmed');
        }
        return;
      }

      const trade = msg.data;
      this.processTradeData(trade);
      
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error.message);
      logger.debug('Raw message:', rawData.toString().substring(0, 500));
    }
  }

  processTradeData(trade) {
    // Check for liquidation
    // Primary: trade.liq === true
    // Backup: trade.reason === 'liquidation'
    const isLiquidation = trade.liq === true || trade.reason === 'liquidation';

    if (isLiquidation) {
      // TAKER = the wallet that got liquidated
      // MAKER = just someone who had a resting order (ignore)
      
      // Determine position type from side:
      // side="sell" → LONG liquidated (forced to sell their long)
      // side="buy"  → SHORT liquidated (forced to buy back their short)
      const positionType = trade.side === 'sell' ? 'LONG' : 'SHORT';
      
      const price = parseFloat(trade.price || 0);
      const quantity = parseFloat(trade.quantity || trade.size || trade.sz || 0);
      const valueUsd = price * quantity;

      const liquidation = {
        symbol: trade.symbol,
        side: trade.side,                    // "buy" or "sell"
        positionType: positionType,          // "LONG" or "SHORT"
        price: price,
        quantity: quantity,
        value: valueUsd,
        taker: trade.taker,                  // LIQUIDATED WALLET
        maker: trade.maker,                  // Counterparty (ignore)
        timestamp: trade.timestamp || Date.now(),
      };

      logger.info(`🔥 LIQUIDATION: ${positionType} ${trade.symbol} $${valueUsd.toFixed(2)} | Wallet: ${trade.taker?.substring(0, 8)}...`);

      // Call the callback to broadcast to Telegram
      if (this.onLiquidation) {
        this.onLiquidation(liquidation);
      }
    } else {
      // Normal trade - just debug log
      logger.debug(`Trade: ${trade.symbol} ${trade.side} ${trade.quantity || trade.size} @ ${trade.price}`);
    }
  }

  handleClose(code, reason) {
    logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    this.isConnected = false;
    this.scheduleReconnect();
  }

  handleError(error) {
    logger.error('WebSocket error:', error.message);
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    logger.info(`Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    logger.info('Disconnected from BULK WebSocket');
  }

  getStatus() {
    return {
      connected: this.isConnected,
      url: this.wsUrl,
      markets: this.markets,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}
