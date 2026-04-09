import dotenv from 'dotenv';

dotenv.config();

export const config = {
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
  },
  bulk: {
    wsUrl: process.env.BULK_WS_URL || 'wss://exchange-ws1.bulk.trade',
    apiUrl: process.env.BULK_API_URL || 'https://exchange-api.bulk.trade/api/v1',
    markets: (process.env.SUPPORTED_MARKETS || 'BTC-USD,ETH-USD,SOL-USD,GOLD-USD,XRP-USD').split(','),
  },
  alerts: {
    defaultThreshold: parseFloat(process.env.DEFAULT_ALERT_THRESHOLD || '5'),
  },
  logLevel: process.env.LOG_LEVEL || 'info',
};

// Validate required configuration
export function validateConfig() {
  const errors = [];

  if (!config.telegram.botToken || config.telegram.botToken === 'your_bot_token_here') {
    errors.push('TELEGRAM_BOT_TOKEN is required');
  }

  if (errors.length > 0) {
    console.error('❌ Configuration errors:');
    errors.forEach((err) => console.error(`   - ${err}`));
    console.error('\n📝 Please copy .env.example to .env and fill in your values');
    process.exit(1);
  }

  console.log('✅ Configuration validated');
}
