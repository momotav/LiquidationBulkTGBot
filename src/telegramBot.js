import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { logger, formatNumber, formatNumberPrecise, shortenAddress } from './logger.js';

export class TelegramBotClient {
  constructor() {
    this.bot = null;
    this.subscribers = new Set(); // Users who want liquidation alerts
    this.stats = {
      messagesSent: 0,
      liquidationsProcessed: 0,
      errors: 0,
      startTime: Date.now(),
    };
  }

  initialize() {
    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
      
      // Set up command handlers
      this.setupCommands();

      logger.info('✅ Telegram bot initialized');
      return true;
    } catch (error) {
      logger.error('Failed to initialize Telegram bot:', error.message);
      return false;
    }
  }

  setupCommands() {
    // /start command - Subscribe to alerts
    this.bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || msg.from.first_name || 'User';
      
      this.subscribers.add(chatId);
      logger.info(`New subscriber: ${username} (${chatId})`);

      const welcomeMessage = `
🔥 *BULK Exchange Liquidation Bot*

Welcome, ${username}! You are now subscribed to real-time liquidation alerts.

*Commands:*
/start - Subscribe to liquidation alerts
/stop - Unsubscribe from alerts
/status - Bot status and your subscription
/markets - Show monitored markets
/help - Get help and info

📊 *Monitoring:* ${config.bulk.markets.join(', ')}

You'll receive alerts whenever a position gets liquidated on BULK Exchange! 💀
      `;

      this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    });

    // /stop command - Unsubscribe
    this.bot.onText(/\/stop/, (msg) => {
      const chatId = msg.chat.id;
      
      if (this.subscribers.has(chatId)) {
        this.subscribers.delete(chatId);
        logger.info(`Unsubscribed: ${chatId}`);
        
        this.bot.sendMessage(chatId, `
✅ *Unsubscribed*

You will no longer receive liquidation alerts.

Send /start to subscribe again anytime!
        `, { parse_mode: 'Markdown' });
      } else {
        this.bot.sendMessage(chatId, `
You're not currently subscribed.

Send /start to subscribe to liquidation alerts!
        `, { parse_mode: 'Markdown' });
      }
    });

    // /status command
    this.bot.onText(/\/status/, (msg) => {
      const chatId = msg.chat.id;
      const uptime = this.getUptime();
      const isSubscribed = this.subscribers.has(chatId);

      const statusMessage = `
📊 *Bot Status*

✅ Bot: Online
⏱️ Uptime: ${uptime}

*Your Status:*
${isSubscribed ? '🔔 Subscribed to alerts' : '🔕 Not subscribed'}

*Statistics:*
👥 Active Subscribers: ${this.subscribers.size}
💀 Liquidations Processed: ${this.stats.liquidationsProcessed}
📨 Messages Sent: ${this.stats.messagesSent}

📡 Monitoring ${config.bulk.markets.length} markets
      `;

      this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    });

    // /markets command
    this.bot.onText(/\/markets/, (msg) => {
      const chatId = msg.chat.id;
      const markets = config.bulk.markets.map((m) => `• ${m}`).join('\n');

      const marketsMessage = `
📈 *Monitored Markets*

${markets}

These markets are tracked 24/7 for liquidation events on BULK Exchange.
      `;

      this.bot.sendMessage(chatId, marketsMessage, { parse_mode: 'Markdown' });
    });

    // /help command
    this.bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      const helpMessage = `
❓ *Help*

This bot monitors BULK Exchange for liquidation events and sends you real-time alerts.

*What is a liquidation?*
A liquidation occurs when a trader's position can no longer be supported by their margin. The exchange automatically closes the position.

*Understanding alerts:*
🔴 = Long position liquidated (price dropped)
🟢 = Short position liquidated (price rose)

*Size indicators:*
🐋 = $100k+ (Whale)
🦈 = $50k-$100k (Shark)
🐟 = $10k-$50k (Fish)
🦐 = Under $10k (Shrimp)

*Commands:*
/start - Subscribe to alerts
/stop - Unsubscribe
/status - Check status
/markets - View markets
/help - This message

*Links:*
• [BULK Exchange](https://alphanet.bulk.trade)
• [Explorer](https://explorer.bulk.trade)
      `;

      this.bot.sendMessage(chatId, helpMessage, { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true 
      });
    });

    // Handle errors
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error.message);
      this.stats.errors++;
    });
  }

  formatLiquidationMessage(liq) {
    // Direction: buy side means a long was liquidated, sell means short was liquidated
    const isLongLiquidated = liq.side === 'buy';
    const emoji = isLongLiquidated ? '🔴' : '🟢';
    const direction = isLongLiquidated ? 'LONG' : 'SHORT';
    const directionEmoji = isLongLiquidated ? '📉' : '📈';

    // Size emoji based on value
    let sizeEmoji = '💰';
    if (liq.value >= 100000) {
      sizeEmoji = '🐋';
    } else if (liq.value >= 50000) {
      sizeEmoji = '🦈';
    } else if (liq.value >= 10000) {
      sizeEmoji = '🐟';
    } else {
      sizeEmoji = '🦐';
    }

    // Extract token from symbol
    const token = liq.symbol.split('-')[0];

    // Format timestamp
    const time = new Date(liq.timestamp).toUTCString();

    const message = `
${emoji} *${direction} LIQUIDATED* ${directionEmoji}

${sizeEmoji} *${liq.symbol}*
━━━━━━━━━━━━━━━━━━━
💵 *Size:* $${formatNumberPrecise(liq.value)}
💲 *Price:* $${formatNumberPrecise(liq.price)}
📊 *Qty:* ${formatNumber(liq.quantity)} ${token}
━━━━━━━━━━━━━━━━━━━
👛 \`${shortenAddress(liq.taker)}\`
⏰ ${time}
`;

    return message;
  }

  async broadcastLiquidation(liq) {
    const message = this.formatLiquidationMessage(liq);
    
    this.stats.liquidationsProcessed++;

    // Send to all subscribers
    for (const chatId of this.subscribers) {
      try {
        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
        });
        this.stats.messagesSent++;
      } catch (error) {
        logger.error(`Failed to send to ${chatId}:`, error.message);
        this.stats.errors++;
        
        // Remove subscriber if blocked or chat not found
        if (error.message.includes('bot was blocked') || 
            error.message.includes('chat not found') ||
            error.message.includes('user is deactivated')) {
          this.subscribers.delete(chatId);
          logger.info(`Removed inactive subscriber: ${chatId}`);
        }
      }
    }

    logger.info(`📨 Liquidation broadcast to ${this.subscribers.size} subscribers: ${liq.symbol} $${formatNumber(liq.value)}`);
  }

  getUptime() {
    const ms = Date.now() - this.stats.startTime;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  getStats() {
    return {
      ...this.stats,
      subscribers: this.subscribers.size,
      uptime: this.getUptime(),
    };
  }

  stop() {
    if (this.bot) {
      this.bot.stopPolling();
      logger.info('Telegram bot stopped');
    }
  }
}
