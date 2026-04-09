import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { BulkWebSocket } from './bulkWebSocket.js';
import { TelegramBotClient } from './telegramBot.js';

// ASCII art banner
const banner = `
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   ██████╗ ██╗   ██╗██╗     ██╗  ██╗    ██╗     ██╗ ██████╗   ║
║   ██╔══██╗██║   ██║██║     ██║ ██╔╝    ██║     ██║██╔═══██╗  ║
║   ██████╔╝██║   ██║██║     █████╔╝     ██║     ██║██║   ██║  ║
║   ██╔══██╗██║   ██║██║     ██╔═██╗     ██║     ██║██║▄▄ ██║  ║
║   ██████╔╝╚██████╔╝███████╗██║  ██╗    ███████╗██║╚██████╔╝  ║
║   ╚═════╝  ╚═════╝ ╚══════╝╚═╝  ╚═╝    ╚══════╝╚═╝ ╚══▀▀═╝   ║
║                                                              ║
║              BULK Exchange Liquidation Bot                   ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`;

class BulkLiquidationBot {
  constructor() {
    this.telegramBot = null;
    this.bulkWs = null;
  }

  async start() {
    console.log(banner);

    // Validate configuration
    validateConfig();

    logger.info('Starting BULK Liquidation Bot...');
    logger.info(`Markets: ${config.bulk.markets.join(', ')}`);

    // Initialize Telegram bot
    this.telegramBot = new TelegramBotClient();
    const telegramInitialized = await this.telegramBot.initialize();

    if (!telegramInitialized) {
      logger.error('Failed to initialize Telegram bot. Exiting.');
      process.exit(1);
    }

    // Initialize BULK WebSocket with liquidation callback
    this.bulkWs = new BulkWebSocket((liquidation) => {
      this.handleLiquidation(liquidation);
    });

    // Connect to BULK Exchange
    this.bulkWs.connect();

    // Set up graceful shutdown
    this.setupShutdownHandlers();

    logger.info('🎯 Bot is now running and monitoring for liquidations...');
  }

  handleLiquidation(liquidation) {
    // Broadcast to Telegram channel
    this.telegramBot.broadcastLiquidation(liquidation);
  }

  setupShutdownHandlers() {
    const shutdown = async (signal) => {
      logger.info(`\n${signal} received. Shutting down gracefully...`);

      // Disconnect WebSocket
      if (this.bulkWs) {
        this.bulkWs.disconnect();
      }

      // Stop Telegram bot and close database
      if (this.telegramBot) {
        const stats = await this.telegramBot.getStats();
        logger.info('Final Statistics:');
        logger.info(`  - Uptime: ${stats.uptime}`);
        logger.info(`  - Storage: ${stats.storageType}`);
        logger.info(`  - Subscribers: ${stats.subscribers}`);
        logger.info(`  - Messages Sent: ${stats.messagesSent}`);
        logger.info(`  - Liquidations Processed: ${stats.liquidationsProcessed}`);
        logger.info(`  - Errors: ${stats.errors}`);
        
        await this.telegramBot.stop();
      }

      logger.info('Goodbye! 👋');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception:', error);
      shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
  }
}

// Start the bot
const bot = new BulkLiquidationBot();
bot.start().catch((error) => {
  logger.error('Failed to start bot:', error);
  process.exit(1);
});
