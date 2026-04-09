import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { logger, formatNumber, formatNumberPrecise, shortenAddress } from './logger.js';
import { db } from './database.js';
import { BulkAPI } from './bulkApi.js';

export class TelegramBotClient {
  constructor() {
    this.bot = null;
    this.bulkApi = new BulkAPI();
    this.useDatabase = false;
    this.stats = {
      messagesSent: 0,
      liquidationsProcessed: 0,
      errors: 0,
      startTime: Date.now(),
    };
    
    // Position monitoring interval
    this.monitoringInterval = null;
  }

  async initialize() {
    try {
      this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
      
      // Try to connect to database
      this.useDatabase = await db.connect();
      
      if (this.useDatabase) {
        // Load subscriber count
        const count = await db.getSubscriberCount();
        logger.info(`📋 Database connected. ${count} subscribers loaded.`);
        
        // Start position monitoring (check every 30 seconds)
        this.startPositionMonitoring();
      }
      
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
    // /start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || null;
      const firstName = msg.from.first_name || 'User';
      
      if (this.useDatabase) {
        await db.addSubscriber(chatId, username, firstName);
      }
      
      logger.info(`New user: ${firstName} (@${username}) [${chatId}]`);

      const welcomeMessage = `
🔥 *BULK Exchange Liquidation Bot*

Welcome, ${firstName}!

*Wallet Commands:*
/wallet \`<address>\` - Connect your wallet
/walletstatus - View your positions & liquidation risk
/removewallet - Disconnect your wallet

*Alert Settings:*
/alerts - Toggle global liquidation feed on/off

*Other Commands:*
/status - Bot status
/markets - Monitored markets
/help - Help & info

📊 *Monitoring:* ${config.bulk.markets.join(', ')}
      `;

      this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    });

    // /wallet command - Add wallet
    this.bot.onText(/\/wallet(?:\s+(.+))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const walletAddress = match[1]?.trim();

      if (!walletAddress) {
        this.bot.sendMessage(chatId, `
📝 *Connect Your Wallet*

Usage: \`/wallet <your_wallet_address>\`

Example:
\`/wallet 7xK9f2AbCdEf123456789...\`

Once connected, you'll receive:
• ⚠️ Alerts when close to liquidation
• 💀 Notification if you get liquidated
        `, { parse_mode: 'Markdown' });
        return;
      }

      // Validate wallet format (basic check - Solana addresses are 32-44 chars)
      if (walletAddress.length < 32 || walletAddress.length > 50) {
        this.bot.sendMessage(chatId, `
❌ *Invalid Wallet Address*

Please enter a valid Solana wallet address.
        `, { parse_mode: 'Markdown' });
        return;
      }

      if (this.useDatabase) {
        await db.setUserWallet(chatId, walletAddress);
      }

      logger.info(`Wallet connected: ${chatId} -> ${shortenAddress(walletAddress)}`);

      this.bot.sendMessage(chatId, `
✅ *Wallet Connected!*

📍 \`${shortenAddress(walletAddress)}\`

You will now receive:
• ⚠️ Alerts when within 5% of liquidation
• 💀 Notification if your position gets liquidated

Use /walletstatus to check your positions anytime.
      `, { parse_mode: 'Markdown' });
    });

    // /walletstatus command - Check positions
    this.bot.onText(/\/walletstatus/, async (msg) => {
      const chatId = msg.chat.id;

      if (!this.useDatabase) {
        this.bot.sendMessage(chatId, '❌ Database not available.');
        return;
      }

      const user = await db.getUser(chatId);

      if (!user || !user.wallet_address) {
        this.bot.sendMessage(chatId, `
❌ *No Wallet Connected*

Use /wallet \`<address>\` to connect your wallet first.
        `, { parse_mode: 'Markdown' });
        return;
      }

      // Send "loading" message
      const loadingMsg = await this.bot.sendMessage(chatId, '🔄 Fetching your positions...');

      try {
        const positions = await this.bulkApi.getPositions(user.wallet_address);

        if (!positions || positions.length === 0) {
          await this.bot.editMessageText(`
📊 *Wallet Status*

📍 \`${shortenAddress(user.wallet_address)}\`

No open positions found.
          `, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
            parse_mode: 'Markdown'
          });
          return;
        }

        // Build positions message
        let positionsText = '';

        for (const pos of positions) {
          // Use markPrice from position data (fairPrice), fallback to fetching if not available
          const markPrice = pos.markPrice || await this.bulkApi.getMarkPrice(pos.symbol);
          const risk = this.calculateLiquidationRisk(pos, markPrice);
          
          const direction = pos.size > 0 ? '🟢 LONG' : '🔴 SHORT';
          const riskEmoji = risk.distancePercent < 5 ? '🚨' : risk.distancePercent < 10 ? '⚠️' : '✅';
          // Use notional from API if available, otherwise calculate
          const notionalValue = pos.notional || Math.abs(pos.size) * markPrice;

          positionsText += `
*${pos.symbol}* ${direction}
━━━━━━━━━━━━━━━━━━━
📊 Size: ${formatNumber(Math.abs(pos.size))} (${formatNumberPrecise(notionalValue)} USD)
💲 Entry: $${formatNumberPrecise(pos.entryPrice)}
📍 Mark: $${formatNumberPrecise(markPrice)}
🎯 Liq Price: $${formatNumberPrecise(pos.liquidationPrice || risk.liquidationPrice)}
${riskEmoji} Distance: *${risk.distancePercent.toFixed(2)}%*
💰 uPnL: ${pos.unrealizedPnl >= 0 ? '+' : ''}$${formatNumberPrecise(pos.unrealizedPnl)}

`;
        }

        await this.bot.editMessageText(`
📊 *Wallet Status*

📍 \`${shortenAddress(user.wallet_address)}\`

${positionsText}
_Updated: ${new Date().toUTCString()}_
        `, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown'
        });

      } catch (error) {
        logger.error('Error fetching positions:', error.message);
        await this.bot.editMessageText(`
❌ *Error Fetching Positions*

Could not retrieve position data. Please try again later.

Error: ${error.message}
        `, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'Markdown'
        });
      }
    });

    // /removewallet command
    this.bot.onText(/\/removewallet/, async (msg) => {
      const chatId = msg.chat.id;

      if (this.useDatabase) {
        await db.removeUserWallet(chatId);
      }

      this.bot.sendMessage(chatId, `
✅ *Wallet Disconnected*

You will no longer receive personal liquidation alerts.

Use /wallet \`<address>\` to connect a new wallet.
      `, { parse_mode: 'Markdown' });
    });

    // /alerts command - Toggle global alerts
    this.bot.onText(/\/alerts(?:\s+(on|off))?/, async (msg, match) => {
      const chatId = msg.chat.id;
      const setting = match[1]?.toLowerCase();

      if (!this.useDatabase) {
        this.bot.sendMessage(chatId, '❌ Database not available.');
        return;
      }

      const user = await db.getUser(chatId);
      const currentSetting = user?.global_alerts ?? true;

      if (!setting) {
        // Show current status
        const statusEmoji = currentSetting ? '🔔' : '🔕';
        this.bot.sendMessage(chatId, `
*Global Liquidation Alerts*

${statusEmoji} Currently: *${currentSetting ? 'ON' : 'OFF'}*

• \`/alerts on\` - Receive ALL liquidation alerts
• \`/alerts off\` - Only receive YOUR wallet alerts

${!user?.wallet_address ? '⚠️ _No wallet connected. Use /wallet to track your positions._' : ''}
        `, { parse_mode: 'Markdown' });
        return;
      }

      const newSetting = setting === 'on';
      await db.setGlobalAlerts(chatId, newSetting);

      const emoji = newSetting ? '🔔' : '🔕';
      this.bot.sendMessage(chatId, `
${emoji} *Global Alerts: ${newSetting ? 'ON' : 'OFF'}*

${newSetting 
  ? 'You will receive alerts for ALL liquidations on BULK Exchange.' 
  : 'You will only receive alerts for YOUR wallet (if connected).'}
      `, { parse_mode: 'Markdown' });
    });

    // /status command
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      const uptime = this.getUptime();
      
      let userStatus = '';
      if (this.useDatabase) {
        const user = await db.getUser(chatId);
        if (user) {
          userStatus = `
*Your Settings:*
📍 Wallet: ${user.wallet_address ? `\`${shortenAddress(user.wallet_address)}\`` : 'Not connected'}
🔔 Global Alerts: ${user.global_alerts ? 'ON' : 'OFF'}
`;
        }
      }

      const subscriberCount = this.useDatabase ? await db.getSubscriberCount() : 0;

      const statusMessage = `
📊 *Bot Status*

✅ Bot: Online
⏱️ Uptime: ${uptime}
💾 Database: ${this.useDatabase ? 'Connected' : 'Not available'}

*Statistics:*
👥 Total Users: ${subscriberCount}
💀 Liquidations Tracked: ${this.stats.liquidationsProcessed}
📨 Messages Sent: ${this.stats.messagesSent}
${userStatus}
📡 Monitoring ${config.bulk.markets.length} markets
      `;

      this.bot.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
    });

    // /markets command
    this.bot.onText(/\/markets/, (msg) => {
      const chatId = msg.chat.id;
      const markets = config.bulk.markets.map((m) => `• ${m}`).join('\n');

      this.bot.sendMessage(chatId, `
📈 *Monitored Markets*

${markets}

These markets are tracked 24/7 for liquidation events.
      `, { parse_mode: 'Markdown' });
    });

    // /help command
    this.bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      this.bot.sendMessage(chatId, `
❓ *Help*

*What does this bot do?*
Monitors BULK Exchange for liquidations and alerts you in real-time.

*Wallet Tracking:*
Connect your wallet to get personal alerts when YOUR positions are at risk.

• /wallet \`<address>\` - Connect wallet
• /walletstatus - Check your positions
• /removewallet - Disconnect wallet

*Alert Types:*

🔴 *LONG LIQUIDATED* - Someone's long got liquidated (price dropped)
🟢 *SHORT LIQUIDATED* - Someone's short got liquidated (price rose)

⚠️ *LIQUIDATION WARNING* - Your position is within 5% of liquidation price

*Size Indicators:*
🐋 = $100k+ (Whale)
🦈 = $50k-$100k 
🐟 = $10k-$50k
🦐 = Under $10k

*Links:*
• [BULK Exchange](https://alphanet.bulk.trade)
• [Explorer](https://explorer.bulk.trade)
      `, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // Handle errors
    this.bot.on('polling_error', (error) => {
      logger.error('Telegram polling error:', error.message);
      this.stats.errors++;
    });
  }

  // Calculate liquidation risk
  calculateLiquidationRisk(position, markPrice) {
    const { entryPrice, size, liquidationPrice } = position;
    
    // If no liquidation price provided, estimate it
    let liqPrice = liquidationPrice;
    if (!liqPrice) {
      // Rough estimate based on 20x leverage, 0.5% maintenance margin
      const isLong = size > 0;
      const maintenanceMargin = 0.005; // 0.5%
      if (isLong) {
        liqPrice = entryPrice * (1 - (1/20) + maintenanceMargin);
      } else {
        liqPrice = entryPrice * (1 + (1/20) - maintenanceMargin);
      }
    }
    
    const isLong = size > 0;
    const distancePercent = isLong
      ? ((markPrice - liqPrice) / markPrice) * 100
      : ((liqPrice - markPrice) / markPrice) * 100;
    
    return {
      liquidationPrice: liqPrice,
      currentPrice: markPrice,
      distancePercent: Math.max(0, distancePercent),
      isAtRisk: distancePercent < 5
    };
  }

  // Start position monitoring loop
  startPositionMonitoring() {
    // Check positions every 30 seconds
    this.monitoringInterval = setInterval(async () => {
      await this.checkAllUserPositions();
    }, 30000);

    logger.info('📡 Position monitoring started (30s interval)');
  }

  // Check all user positions for liquidation risk
  async checkAllUserPositions() {
    if (!this.useDatabase) return;

    try {
      const usersWithWallets = await db.getUsersWithWallets();

      for (const user of usersWithWallets) {
        try {
          const positions = await this.bulkApi.getPositions(user.wallet_address);
          
          if (!positions || positions.length === 0) continue;

          for (const pos of positions) {
            const markPrice = await this.bulkApi.getMarkPrice(pos.symbol);
            const risk = this.calculateLiquidationRisk(pos, markPrice);

            // Alert if within 5% of liquidation
            if (risk.isAtRisk) {
              // Check if we already alerted recently (prevent spam)
              const alertKey = `${user.chat_id}_${pos.symbol}`;
              const lastAlert = await db.getLastAlert(alertKey);
              const now = Date.now();

              // Only alert once per 5 minutes per position
              if (!lastAlert || (now - lastAlert) > 300000) {
                await this.sendLiquidationWarning(user.chat_id, pos, markPrice, risk);
                await db.setLastAlert(alertKey, now);
              }
            }
          }
        } catch (error) {
          logger.error(`Error checking positions for ${user.chat_id}:`, error.message);
        }
      }
    } catch (error) {
      logger.error('Error in position monitoring:', error.message);
    }
  }

  // Send liquidation warning to user
  async sendLiquidationWarning(chatId, position, markPrice, risk) {
    const direction = position.size > 0 ? 'LONG' : 'SHORT';
    const notionalValue = Math.abs(position.size) * markPrice;

    const message = `
⚠️🚨 *LIQUIDATION WARNING* 🚨⚠️

Your *${position.symbol}* ${direction} is at risk!

━━━━━━━━━━━━━━━━━━━
📊 Size: $${formatNumberPrecise(notionalValue)}
💲 Entry: $${formatNumberPrecise(position.entryPrice)}
📍 Current: $${formatNumberPrecise(markPrice)}
🎯 Liq Price: $${formatNumberPrecise(risk.liquidationPrice)}
━━━━━━━━━━━━━━━━━━━

🔥 *Only ${risk.distancePercent.toFixed(2)}% away from liquidation!*

Consider adding margin or reducing position size.
    `;

    try {
      await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      this.stats.messagesSent++;
      logger.info(`⚠️ Liquidation warning sent to ${chatId} for ${position.symbol}`);
    } catch (error) {
      logger.error(`Failed to send warning to ${chatId}:`, error.message);
    }
  }

  // Format liquidation message
  formatLiquidationMessage(liq) {
    const isLongLiquidated = liq.side === 'buy';
    const emoji = isLongLiquidated ? '🔴' : '🟢';
    const direction = isLongLiquidated ? 'LONG' : 'SHORT';
    const directionEmoji = isLongLiquidated ? '📉' : '📈';

    let sizeEmoji = '💰';
    if (liq.value >= 100000) sizeEmoji = '🐋';
    else if (liq.value >= 50000) sizeEmoji = '🦈';
    else if (liq.value >= 10000) sizeEmoji = '🐟';
    else sizeEmoji = '🦐';

    const token = liq.symbol.split('-')[0];
    const time = new Date(liq.timestamp).toUTCString();

    return `
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
  }

  // Broadcast liquidation to relevant users
  async broadcastLiquidation(liq) {
    if (!this.useDatabase) return;

    this.stats.liquidationsProcessed++;

    const message = this.formatLiquidationMessage(liq);

    // Get all users
    const allUsers = await db.getAllUsers();

    for (const user of allUsers) {
      try {
        // Check if this is the user's wallet
        const isOwnWallet = user.wallet_address && 
          user.wallet_address.toLowerCase() === liq.taker?.toLowerCase();

        if (isOwnWallet) {
          // Always notify if it's their own liquidation
          const ownMessage = `
💀🚨 *YOUR POSITION WAS LIQUIDATED* 🚨💀

${message}

😔 Sorry for your loss. Consider using tighter risk management next time.
          `;
          await this.bot.sendMessage(user.chat_id, ownMessage, { parse_mode: 'Markdown' });
          this.stats.messagesSent++;
        } else if (user.global_alerts) {
          // Send global alert only if enabled
          await this.bot.sendMessage(user.chat_id, message, { parse_mode: 'Markdown' });
          this.stats.messagesSent++;
        }
      } catch (error) {
        logger.error(`Failed to send to ${user.chat_id}:`, error.message);
        
        if (error.message.includes('bot was blocked') || 
            error.message.includes('chat not found')) {
          await db.removeSubscriber(user.chat_id);
        }
      }
    }

    logger.info(`📨 Liquidation broadcast: ${liq.symbol} $${formatNumber(liq.value)}`);
  }

  getUptime() {
    const ms = Date.now() - this.stats.startTime;
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  async stop() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    if (this.bot) {
      this.bot.stopPolling();
    }
    await db.close();
    logger.info('Telegram bot stopped');
  }
}
