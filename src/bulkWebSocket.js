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
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      logger.info('WebSocket already connected/connecting');
      return;
    }

    logger.info(`🔌 Connecting to BULK WebSocket: ${this.wsUrl}`);

    try {
      this.ws = new WebSocket(this.wsUrl, {
        handshakeTimeout: 10000,
        headers: {
          'User-Agent': 'BULK-Liquidation-Bot/1.0',
        },
      });

      this.ws.on('open', () => this.handleOpen());
      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason));
      this.ws.on('error', (error) => this.handleError(error));
      
      // BULK API requires pong response to pings
      this.ws.on('ping', () => {
        this.ws.pong();
      });
    } catch (error) {
      logger.error('Failed to create WebSocket connection:', error.message);
      this.scheduleReconnect();
    }
  }

  handleOpen() {
    logger.info('✅ WebSocket connected to BULK Exchange');
    this.isConnected = true;
    this.reconnectAttempts = 0;

    // Subscribe to trade channels
    this.subscribeToMarkets();
    
    logger.info('👀 Watching for liquidations...');
  }

  subscribeToMarkets() {
    // EXACT FORMAT FROM WORKING BULKSTATS CODE:
    // { method: 'subscribe', subscription: [{ type: 'trades', symbol: 'BTC-USD' }, ...] }
    const subscribeMessage = {
      method: 'subscribe',
      subscription: this.markets.map(symbol => ({ type: 'trades', symbol }))
    };

    logger.info(`📡 Subscribing to trades for: ${this.markets.join(', ')}`);
    this.ws.send(JSON.stringify(subscribeMessage));
  }

  handleMessage(rawData) {
    try {
      const message = JSON.parse(rawData.toString());
      
      // Ignore order book data (resting orders)
      if (Array.isArray(message) && message[0]?.status === 'resting') return;
      if (message.status === 'resting' || message.filledSize === 0) return;
      
      // ─────────────────────────────────────────────────────────
      // FORMAT 1: { type: 'trades', data: { trades: [...] } }
      // ─────────────────────────────────────────────────────────
      if (message.type === 'trades' && message.data?.trades) {
        for (const trade of message.data.trades) {
          if (trade.status === 'resting' || trade.filledSize === 0) continue;
          
          if (this.isLiquidation(trade)) {
            this.processLiquidation(trade);
          }
        }
        return;
      }
      
      // ─────────────────────────────────────────────────────────
      // FORMAT 2: { channel: 'trades', data: [...] }
      // ─────────────────────────────────────────────────────────
      if (message.channel === 'trades' && message.data) {
        const trades = Array.isArray(message.data) ? message.data : [message.data];
        
        for (const trade of trades) {
          if (this.isLiquidation(trade)) {
            this.processLiquidation(trade);
          }
        }
        return;
      }
      
      // ─────────────────────────────────────────────────────────
      // FORMAT 3: Generic trade with reason field
      // ─────────────────────────────────────────────────────────
      if (message.type === 'trades' || message.e === 'trade') {
        const trades = message.data?.trades || message.trades || [message];
        
        for (const trade of trades) {
          if (this.isLiquidation(trade)) {
            this.processLiquidation(trade);
          }
        }
        return;
      }
      
      // ─────────────────────────────────────────────────────────
      // FORMAT 4: Dedicated liquidation channel (if BULK adds one)
      // ─────────────────────────────────────────────────────────
      if (message.channel === 'liquidation' || message.channel === 'liquidations' ||
          message.type === 'liquidation' || message.type === 'liquidations') {
        
        const liquidations = message.data?.liquidations || message.data || [message];
        const liqArray = Array.isArray(liquidations) ? liquidations : [liquidations];
        
        for (const liq of liqArray) {
          this.processLiquidation(liq);
        }
        return;
      }
      
    } catch (error) {
      // Silently ignore parse errors
    }
  }

  // Check if a trade is a liquidation - check ALL possible flags
  isLiquidation(trade) {
    return (
      trade.liq === true ||                              // Primary flag
      trade.reason === 'liquidation' ||                  // Reason field
      trade.liquidation === true ||                      // Alternative flag
      trade.isLiquidation === true ||                    // Another variant
      trade.orderType === 'liquidation' ||               // Order type check
      trade.type === 'liquidation' ||                    // Type check
      (trade.reduceOnly && trade.forcedLiquidation)      // Forced liquidation
    );
  }

  processLiquidation(trade) {
    const symbol = trade.s || trade.symbol || 'UNKNOWN';
    const price = parseFloat(trade.px || trade.price || 0);
    const size = parseFloat(trade.sz || trade.size || 0);
    const value = price * Math.abs(size);
    const time = trade.time || Date.now();
    
    // BULK system liquidator wallet - this is the exchange's liquidation engine
    const LIQUIDATOR_WALLET = '9J8TUdEWrrcADK913r1Cs7DdqX63VdVU88imfDzT1ypt';
    
    // Determine who got liquidated:
    // - If taker is the liquidator → maker got liquidated
    // - If maker is the liquidator → taker got liquidated
    // - If neither is liquidator → taker got liquidated (original logic)
    let liquidatedWallet;
    let liquidatorSide; // The side the LIQUIDATED person was on
    
    if (trade.taker === LIQUIDATOR_WALLET) {
      // Liquidator is buying/selling FROM the maker → maker got liquidated
      liquidatedWallet = trade.maker;
      // If liquidator is BUYING (taker side = buy), the maker was SHORT (liquidator buying to close their short)
      // If liquidator is SELLING (taker side = sell), the maker was LONG (liquidator selling to close their long)
      const takerSide = trade.side === true || trade.side === 'B' || trade.side === 'buy' ? 'buy' : 'sell';
      liquidatorSide = takerSide === 'buy' ? 'SHORT' : 'LONG';
    } else if (trade.maker === LIQUIDATOR_WALLET) {
      // Liquidator is the maker → taker got liquidated
      liquidatedWallet = trade.taker;
      const takerSide = trade.side === true || trade.side === 'B' || trade.side === 'buy' ? 'buy' : 'sell';
      // Taker's side tells us what position they had:
      // If taker is BUYING, they were SHORT (buying to close)
      // If taker is SELLING, they were LONG (selling to close)
      liquidatorSide = takerSide === 'buy' ? 'SHORT' : 'LONG';
    } else {
      // Neither is the known liquidator - use taker as liquidated (original logic)
      liquidatedWallet = trade.taker;
      const takerSide = trade.side === true || trade.side === 'B' || trade.side === 'buy' ? 'buy' : 'sell';
      liquidatorSide = takerSide === 'buy' ? 'SHORT' : 'LONG';
    }
    
    // Skip if we couldn't determine the liquidated wallet
    if (!liquidatedWallet) {
      logger.warn('Could not determine liquidated wallet, skipping');
      return;
    }
    
    // Skip if the "liquidated" wallet is actually the liquidator (shouldn't happen but safety check)
    if (liquidatedWallet === LIQUIDATOR_WALLET) {
      logger.debug('Skipping - liquidated wallet is the system liquidator');
      return;
    }

    const liquidation = {
      symbol: symbol,
      side: trade.side,
      positionType: liquidatorSide,
      price: price,
      quantity: Math.abs(size),
      value: value,
      taker: liquidatedWallet,  // The wallet that got liquidated (renamed for compatibility)
      maker: trade.maker,
      timestamp: time,
    };

    logger.info(`🔥 LIQUIDATION: ${liquidatorSide} ${symbol} $${value.toFixed(2)} | Wallet: ${liquidatedWallet || 'unknown'}`);

    // Call the callback to broadcast to Telegram
    if (this.onLiquidation) {
      this.onLiquidation(liquidation);
    }
  }

  handleClose(code, reason) {
    logger.warn(`❌ WebSocket closed: ${code} - ${reason?.toString() || 'No reason'}`);
    this.isConnected = false;
    this.scheduleReconnect();
  }

  handleError(error) {
    logger.error('WebSocket error:', error.message);
  }

  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`❌ Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 60000);
    this.reconnectAttempts++;

    logger.info(`🔄 Reconnecting in ${delay / 1000}s... (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect() {
    if (this.ws) {
      this.ws.terminate();
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
