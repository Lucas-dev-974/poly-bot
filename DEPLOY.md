# VPS Deployment Guide — Polymarket Reverse Arbitrage Bot

## Overview

Two deployment modes:

| Mode | Best for | Complexity |
|------|----------|------------|
| **Docker + Nginx (recommended)** | Production, easy updates, SSL auto-renewal | Medium |
| **Systemd + manual Nginx** | Bare metal, custom hardening, no Docker overhead | Low |

---

## Prerequisites (VPS)

- **OS**: Ubuntu 22.04+ / Debian 12+ (systemd, apt)
- **CPU**: 2+ vCPU (bot + dashboard + Nginx)
- **RAM**: 2 GB minimum (4 GB recommended)
- **Disk**: 10 GB+ (SQLite + logs + Docker images)
- **Ports**: 80, 443 (inbound), 3105 (local only)
- **Domain**: A record pointing to VPS IP (for Let's Encrypt)

---

## Option A — Docker + Nginx (Recommended, with domain)

### 1. Server Setup

```bash
# Update & install Docker
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git curl

# Add your user to docker group
sudo usermod -aG docker $USER
newgrp docker  # or logout/login

# Create deploy directory
sudo mkdir -p /opt/polymarket-bot
sudo chown $USER:$USER /opt/polymarket-bot
cd /opt/polymarket-bot
```

### 2. Clone & Configure

```bash
# Clone repo
git clone https://github.com/Lucas-dev-974/poly-bot.git .
# OR if private: git clone git@github.com:Lucas-dev-974/poly-bot.git .

# Copy env template and EDIT with your secrets
cp .env.prod.example .env.prod
# nano .env.prod  ← REQUIRED: fill PRIVATE_KEY, FUNDER_ADDRESS, etc.

# First-run: copy example bot settings (or configure via dashboard later)
mkdir -p data
cp bot-settings.example.json data/bot-settings.json
```

### 3. SSL Certificate (Let's Encrypt)

```bash
# Get initial cert (replace your-domain.com)
DOMAIN="your-domain.com"
sudo mkdir -p certbot/conf certbot/www
docker run --rm -it \
  -v $(pwd)/certbot/conf:/etc/letsencrypt \
  -v $(pwd)/certbot/www:/var/www/certbot \
  certbot/certbot certonly --webroot \
  -w /var/www/certbot -d $DOMAIN \
  --email your@email.com --agree-tos --no-eff-email

# Update nginx/nginx.conf with your domain:
# ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
# ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
```

### 4. Deploy

```bash
# Make deploy script executable
chmod +x deploy.sh

# Deploy production (with domain + SSL)
./deploy.sh prod
```

### 5. Verify

```bash
# Check status
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# View logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f bot

# Dashboard should be at https://your-domain.com
```

---

## Option A-bis — Docker only (no domain, direct IP access)

**Use this if you don't have a domain** — exposes dashboard directly on port 3105.

### 1. Server Setup (same)

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-plugin git curl
sudo usermod -aG docker $USER
newgrp docker
sudo mkdir -p /opt/polymarket-bot
sudo chown $USER:$USER /opt/polymarket-bot
cd /opt/polymarket-bot
```

### 2. Clone & Configure (same)

```bash
git clone https://github.com/Lucas-dev-974/poly-bot.git .
cp .env.prod.example .env.prod
nano .env.prod  # ← REQUIRED: fill PRIVATE_KEY, FUNDER_ADDRESS, READONLY_LIVE=false
mkdir -p data
cp bot-settings.example.json data/bot-settings.json
```

### 3. Deploy (no SSL, no Nginx)

```bash
chmod +x deploy.sh
./deploy.sh no-domain
```

### 4. Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.no-domain.yml ps

# Dashboard at http://YOUR_VPS_IP:3105
curl -f http://YOUR_VPS_IP:3105/
```

### 5. Firewall (open port 3105)

```bash
sudo ufw allow 3105/tcp
sudo ufw enable
```

> **Security note**: Without HTTPS, credentials sent to dashboard are in cleartext.
> For production, use a domain + Option A (Nginx + Let's Encrypt).
> Or restrict access via SSH tunnel: `ssh -L 3105:localhost:3105 user@vps-ip`

### 6. Updates

```bash
cd /opt/polymarket-bot
./deploy.sh prod  # pulls latest, rebuilds, restarts
```

---

## Option B — Systemd (Bare Metal)

### 1. Server Setup

```bash
sudo apt update && sudo apt install -y nodejs npm nginx certbot python3-certbot-nginx git

# Node 22+ required
node --version  # should be v22.x

# Create bot user
sudo useradd -r -s /bin/bash -m -d /opt/polymarket-bot botuser
sudo mkdir -p /opt/polymarket-bot
sudo chown botuser:botuser /opt/polymarket-bot
```

### 2. Deploy Code

```bash
sudo -u botuser bash -c '
  cd /opt/polymarket-bot
  git clone https://github.com/Lucas-dev-974/poly-bot.git .
  cp .env.prod.example .env.prod
  # EDIT .env.prod with secrets!
  mkdir -p data
  cp bot-settings.example.json data/bot-settings.json
  npm ci --omit=dev
  npm run build
  npm run build:dashboard
'
```

### 3. Install Systemd Service

```bash
sudo cp polymarket-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now polymarket-bot
sudo systemctl status polymarket-bot
```

### 4. Configure Nginx

```bash
# Copy nginx config
sudo cp nginx/nginx.conf /etc/nginx/nginx.conf
# Edit domain in nginx.conf
sudo nginx -t
sudo systemctl reload nginx
```

### 5. SSL with Certbot

```bash
sudo certbot --nginx -d your-domain.com
# Auto-renewal: certbot adds systemd timer automatically
```

---

## Configuration Checklist

### Required in `.env.prod`

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | EOA private key (0x...) | `0xabc...` |
| `FUNDER_ADDRESS` | Deposit wallet (V2 POLY_1271) | `0xdef...` |
| `SIGNATURE_TYPE` | Wallet signature type | `3` |
| `READONLY_LIVE` | `false` for live trading | `false` |

### Optional (Relayer / Auto-redeem)

| Variable | Description |
|----------|-------------|
| `BUILDER_API_KEY` | From polymarket.com/settings?tab=builder |
| `BUILDER_SECRET` | Base64 |
| `BUILDER_PASSPHRASE` | Hex |
| `AUTO_REDEEM_WINNERS` | `true` to auto-redeem |
| `RELAYER_API_KEY` | Dedicated unlimited quota key |

### Strategy Settings

Managed via **Dashboard → Configuration** (writes to `data/bot-settings.json`).
On first deploy, copy `bot-settings.example.json` to `data/bot-settings.json` or configure via UI after startup.

---

## Monitoring & Logs

### Docker

```bash
# Live logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f bot

# Health
curl -f https://your-domain.com/health

# Container stats
docker stats polymarket-bot
```

### Systemd

```bash
# Logs
sudo journalctl -u polymarket-bot -f

# Status
sudo systemctl status polymarket-bot

# Restart
sudo systemctl restart polymarket-bot
```

---

## Backup Strategy

### SQLite Database

```bash
# Docker
docker compose exec bot cp /app/data/bot-live.db /app/data/backup-$(date +%F).db

# Systemd
sudo -u botuser cp /opt/polymarket-bot/data/bot-live.db /opt/polymarket-bot/data/backup-$(date +%F).db
```

### Automated Daily Backup (cron)

```bash
# Add to crontab (sudo crontab -e)
0 3 * * * /opt/polymarket-bot/scripts/backup.sh >> /var/log/polymarket-backup.log 2>&1
```

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| Bot won't start | `docker logs polymarket-bot` or `journalctl -u polymarket-bot -n 100` |
| Dashboard not loading | Nginx config + SSL cert paths; `curl -I http://localhost:3105/` |
| CLOB auth errors | `PRIVATE_KEY` format (0x...), `FUNDER_ADDRESS` matches deposit wallet |
| "Quota exceeded" relayer | Add `RELAYER_API_KEY` + `RELAYER_API_KEY_ADDRESS` |
| SQLite locked | Only ONE bot instance per DB; check for stale processes |
| High memory | Reduce `MARKET_SNAPSHOT_RETENTION_DAYS`, check for memory leaks |

---

## Security Notes

- **Never commit `.env.prod`** — use `.env.prod.example` in repo
- **Firewall**: Only open 80/443; 3105 bound to 127.0.0.1
- **Fail2ban**: Add for SSH + Nginx
- **Updates**: `apt update && apt upgrade -y` weekly; `docker image prune -a` monthly
- **Keys**: Rotate `PRIVATE_KEY` / `CLOB_*` periodically; use hardware wallet if possible

---

## File Structure on VPS

```
/opt/polymarket-bot/
├── .env.prod                 # Secrets (gitignored)
├── data/
│   ├── bot-live.db           # SQLite (persistent)
│   ├── bot-settings.json     # Strategy config (dashboard writes here)
│   └── backup-*.db           # Manual backups
├── certbot/
│   ├── conf/                 # Let's Encrypt certs
│   └── www/                  # ACME challenge
├── nginx/
│   └── nginx.conf            # Reverse proxy config
├── docker-compose.yml
├── docker-compose.prod.yml
├── deploy.sh
├── dist/                     # Built backend (Docker copies)
└── dist/dashboard/public/    # Built frontend (served by backend)
```

---

## Quick Commands Reference

```bash
# Deploy/update
cd /opt/polymarket-bot && ./deploy.sh prod

# Logs
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f

# Shell into bot
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec bot sh

# Backup DB
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec bot cp /app/data/bot-live.db /app/data/backup-$(date +%F).db

# View bot settings
cat data/bot-settings.json

# Restart only bot
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart bot

# Full restart
docker compose -f docker-compose.yml -f docker-compose.prod.yml down && ./deploy.sh prod
```