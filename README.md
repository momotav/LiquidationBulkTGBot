# BULK Exchange Liquidation Bot 🔥

A Telegram bot that sends real-time liquidation alerts from [BULK Exchange](https://alphanet.bulk.trade) directly to subscribers.

## Features

- 🔴🟢 **Real-time liquidation alerts** - Long and short liquidations
- 🐋 **Size indicators** - Whale, Shark, Fish, Shrimp based on size
- 📊 **Multiple markets** - BTC, ETH, SOL, GOLD, XRP
- 📈 **Bot commands** - `/start`, `/stop`, `/status`, `/markets`, `/help`
- 🔄 **Auto-reconnect** - Resilient WebSocket connection

---

## 🚀 Deploy to Railway (No Terminal Required!)

### Step 1: Create Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g., "BULK Liquidations")
4. Choose a username (e.g., "bulk_liq_bot")
5. **Copy the token** - looks like `1234567890:ABCdefGHIjklMNOpqrsTUVwxyz`

### Step 2: Upload to GitHub

1. Go to [github.com/new](https://github.com/new)
2. Name it `bulk-liquidation-bot`
3. Keep it **Private** (recommended)
4. Click **Create repository**
5. Click **"uploading an existing file"**
6. Drag & drop all the files from this zip
7. Click **Commit changes**

### Step 3: Deploy on Railway

1. Go to [railway.app](https://railway.app) and sign in
2. Click **New Project**
3. Select **Deploy from GitHub repo**
4. Choose your `bulk-liquidation-bot` repository
5. Railway will auto-detect and start building

### Step 4: Add Environment Variable

1. In Railway, click on your service
2. Go to **Variables** tab
3. Click **+ New Variable**
4. Add:
   - **Name:** `TELEGRAM_BOT_TOKEN`
   - **Value:** Your bot token from Step 1
5. Railway will auto-redeploy

### Step 5: Done! 🎉

1. Open Telegram
2. Find your bot (search the username you created)
3. Send `/start`
4. You're now subscribed to liquidation alerts!

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Subscribe to liquidation alerts |
| `/stop` | Unsubscribe from alerts |
| `/status` | Bot status and your subscription |
| `/markets` | Show monitored markets |
| `/help` | Help and information |

## Alert Format

```
🔴 LONG LIQUIDATED 📉

🐋 BTC-USD
━━━━━━━━━━━━━━━━━━━
💵 Size: $125,430.00
💲 Price: $67,250.00
📊 Qty: 1.87K BTC
━━━━━━━━━━━━━━━━━━━
👛 ABC123...XYZ9
⏰ Fri, 10 Apr 2026 12:00:00 GMT
```

### Size Indicators

| Emoji | Size |
|-------|------|
| 🐋 | $100k+ |
| 🦈 | $50k-$100k |
| 🐟 | $10k-$50k |
| 🦐 | < $10k |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Your bot token from BotFather |
| `SUPPORTED_MARKETS` | ❌ | Comma-separated (default: `BTC-USD,ETH-USD,SOL-USD,GOLD-USD,XRP-USD`) |
| `LOG_LEVEL` | ❌ | `debug`, `info`, `warn`, `error` (default: `info`) |

---

## Links

- 🌐 [BULK Exchange](https://alphanet.bulk.trade)
- 🔍 [Explorer](https://explorer.bulk.trade)
- 📚 [API Docs](https://exchange-api.bulk.trade)
