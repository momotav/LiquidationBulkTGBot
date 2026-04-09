import { config } from './config.js';

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel = LOG_LEVELS[config.logLevel] || LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

export const logger = {
  debug: (...args) => {
    if (currentLevel <= LOG_LEVELS.debug) {
      console.log(`[${formatTimestamp()}] [DEBUG]`, ...args);
    }
  },

  info: (...args) => {
    if (currentLevel <= LOG_LEVELS.info) {
      console.log(`[${formatTimestamp()}] [INFO]`, ...args);
    }
  },

  warn: (...args) => {
    if (currentLevel <= LOG_LEVELS.warn) {
      console.warn(`[${formatTimestamp()}] [WARN]`, ...args);
    }
  },

  error: (...args) => {
    if (currentLevel <= LOG_LEVELS.error) {
      console.error(`[${formatTimestamp()}] [ERROR]`, ...args);
    }
  },

  liquidation: (liq) => {
    const direction = liq.side === 'buy' ? 'LONG' : 'SHORT';
    console.log(
      `[${formatTimestamp()}] [LIQUIDATION] ${direction} ${liq.symbol} | ` +
        `Size: $${formatNumber(liq.value)} | Price: $${formatNumber(liq.price)} | ` +
        `Wallet: ${shortenAddress(liq.taker)}`
    );
  },
};

// Helper functions
export function formatNumber(num) {
  if (num === null || num === undefined) return '0';
  
  const n = parseFloat(num);
  
  if (n >= 1_000_000) {
    return (n / 1_000_000).toFixed(2) + 'M';
  } else if (n >= 1_000) {
    return (n / 1_000).toFixed(2) + 'K';
  } else if (n >= 1) {
    return n.toFixed(2);
  } else {
    return n.toFixed(4);
  }
}

export function formatNumberPrecise(num) {
  if (num === null || num === undefined) return '0';
  return parseFloat(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function shortenAddress(address) {
  if (!address) return 'Unknown';
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
