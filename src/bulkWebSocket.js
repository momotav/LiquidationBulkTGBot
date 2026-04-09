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

    // Start ping interval to keep connection alive
    this.startPingInterval();
  }

  subscribeToMarkets() {
    const tradeChannels = this.markets.map((market) => `trade.${market}`);

    const subscribeMessage = {
      method: 'SUBSCRIBE',
      params: tradeChannels,
      id: Date.now(),
    };

    logger.info(`Subscribing to markets: ${this.markets.join(', ')}`);
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  handleMessage(rawData) {
    try {
      const data = JSON.parse(rawData.toString());

      // Handle subscription confirmation
      if (data.result !== undefined) {
        logger.debug('Subscription response:', data);
        return;
      }

      // Handle trade data
      if (data.data) {
        this.processTradeData(data.data);
      }
    } catch (error) {
      logger.error('Error parsing WebSocket message:', error.message);
      logger.debug('Raw message:', rawData.toString());
    }
  }

  processTradeData(trade) {
    // Check if this is a liquidation
    // According to docs: liq: true or reason: "liquidation"
    const isLiquidation = trade.liq === true || trade.reason === 'liquidation';

    if (isLiquidation) {
      const liquidation = {
        symbol: trade.symbol || trade.market,
        side: trade.side, // "buy" or "sell"
        price: parseFloat(trade.price),
        quantity: parseFloat(trade.quantity || trade.size || trade.qty),
        value: parseFloat(trade.price) * parseFloat(trade.quantity || trade.size || trade.qty || 0),
        taker: trade.taker, // Liquidated wallet address
        maker: trade.maker, // Counterparty wallet
        timestamp: trade.timestamp || Date.now(),
        tradeId: trade.id || trade.tradeId,
      };

      logger.liquidation(liquidation);

      // Call the callback to broadcast to Telegram
      if (this.onLiquidation) {
        this.onLiquidation(liquidation);
      }
    } else {
      logger.debug(`Trade (not liquidation): ${trade.symbol} ${trade.side} @ ${trade.price}`);
    }
  }

  handleClose(code, reason) {
    logger.warn(`WebSocket closed. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
    this.isConnected = false;
    this.stopPingInterval();
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

  startPingInterval() {
    // Send ping every 30 seconds to keep connection alive
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('Ping sent');
      }
    }, 30000);
  }

  stopPingInterval() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.stopPingInterval();
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
