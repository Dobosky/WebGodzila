# 🦎 GODZILLA DOWNTREND — Full Web App

Bot runs 24/7 on Railway. You control it from your phone browser anywhere.

---

## DEPLOY TO RAILWAY (FREE)

### Step 1 — Push to GitHub
1. Create a free GitHub account at github.com
2. Create a new repository called `godzilla-bot`
3. Upload all files in this folder to that repo

### Step 2 — Deploy on Railway
1. Go to railway.app → sign up free with GitHub
2. Click "New Project" → "Deploy from GitHub repo"
3. Select your `godzilla-bot` repo
4. Railway auto-detects Node.js and deploys

### Step 3 — Set Environment Variables (optional)
In Railway dashboard → your project → Variables tab.
You can set defaults here, or just configure everything from the dashboard UI.

| Variable | Description |
|----------|-------------|
| `DERIV_TOKEN` | Your Deriv API token |
| `PORT` | Leave blank (Railway sets this) |
| `TELE_TOKEN` | Telegram bot token |
| `TELE_CHAT_ID` | Your Telegram chat ID |

### Step 4 — Access your dashboard
Railway gives you a URL like `https://godzilla-bot.up.railway.app`
Open that URL on your phone — that's your full dashboard.

---

## HOW IT WORKS
- Bot engine runs on Railway server 24/7
- You open the URL on your phone to see the dashboard
- Change market, command, stake, settings — press Start
- Bot trades automatically
- Telegram alerts every trade
- If your phone goes offline — bot keeps running on the server

---

## FEATURES
- Full dashboard with chart, trade log, settings
- Live P&L, win rate, trade history
- Resistance levels shown on chart
- Loss cooldown timer with skip button
- Consecutive loss stop with manual restart
- Telegram alerts for every event
- Change any setting without restarting server

---

## GET DERIV TOKEN
1. Login deriv.com → Settings → API Token
2. Create with "Trade" permission
3. Enter in Settings tab of dashboard

## GET TELEGRAM ALERTS
1. Message @BotFather → /newbot → copy token
2. Message @userinfobot → copy your ID
3. Press START on your new bot
4. Enter both in Settings tab
