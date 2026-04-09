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
    this.pingInterval = null;
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
    // According to BULK API docs:
    // { "method": "subscribe", "subscription": [{ "type": "trades", "symbol": "BTC-USD" }] }
    const subscriptions = this.markets.map((market) => ({
      type: 'trades',
      symbol: market
    }));

    const subscribeMessage = {
      method: 'subscribe',
      subscription: subscriptions
    };

    logger.info(`Subscribing to markets: ${this.markets.join(', ')}`);
    logger.debug('Subscribe message:', JSON.stringify(subscribeMessage));
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  handleMessage(rawData) {
    try {
      const data = JSON.parse(rawData.toString());
      
      logger.debug('WS message:', JSON.stringify(data).substring(0, 500));

      // Handle subscription confirmation
      // Response: { "type": "subscriptionResponse", "topics": ["trades.BTC-USD", ...] }
      if (data.type === 'subscriptionResponse') {
        logger.info(`✅ Subscribed to: ${data.topics?.join(', ')}`);
        return;
      }

      // Handle trade data
      // Format: { "type": "trades", "data": { "trades": [...] }, "topic": "trades.BTC-USD" }
      if (data.type === 'trades' && data.data?.trades) {
        for (const trade of data.data.trades) {
          this.processTradeData(trade, data.topic);
        }
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error.message);
      logger.debug('Raw message:', rawData.toString().substring(0, 500));
    }
  }

  processTradeData(trade, topic) {
    // According to BULK API docs, trade fields:
    // s: symbol, px: price, sz: size, time: timestamp, side: true=buy/false=sell
    // reason: optional - "liquidation" or "adl" (only present if not normal trade)
    // liq: optional - true if liquidation
    
    const isLiquidation = trade.liq === true || trade.reason === 'liquidation';

    if (isLiquidation) {
      // Extract symbol from topic (e.g., "trades.BTC-USD" -> "BTC-USD")
      const symbol = trade.s || topic?.replace('trades.', '') || 'UNKNOWN';
      
      const liquidation = {
        symbol: symbol,
        side: trade.side === true ? 'buy' : 'sell', // true = taker bought (short liquidated), false = taker sold (long liquidated)
        price: parseFloat(trade.px || trade.price || 0),
        quantity: parseFloat(trade.sz || trade.size || trade.qty || 0),
        value: 0,
        taker: trade.taker,
        maker: trade.maker,
        timestamp: trade.time || Date.now(),
      };
      
      // Calculate value
      liquidation.value = liquidation.price * liquidation.quantity;

      logger.info(`🔴 LIQUIDATION DETECTED: ${symbol} ${liquidation.side} $${liquidation.value.toFixed(2)}`);
      logger.liquidation(liquidation);

      // Call the callback to broadcast to Telegram
      if (this.onLiquidation) {
        this.onLiquidation(liquidation);
      }
    } else {
      // Normal trade - just debug log
      const symbol = trade.s || topic?.replace('trades.', '') || '?';
      const side = trade.side === true ? 'BUY' : 'SELL';
      logger.debug(`Trade: ${symbol} ${side} ${trade.sz} @ ${trade.px}`);
    }
  }

  handleClose(code, reason) {
    logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    this.isConnected = false;
    this.scheduleReconnect();
  }

  handleError(error) {
    logger.error('WebSocket error:', error.message);
    // Don't reconnect here, the close event will handle it
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
