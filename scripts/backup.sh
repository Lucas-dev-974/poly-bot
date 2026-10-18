#!/usr/bin/env bash
# Automated backup script for Polymarket Bot
# Add to crontab: 0 3 * * * /opt/polymarket-bot/scripts/backup.sh

set -euo pipefail

PROJECT_DIR="/opt/polymarket-bot"
DATA_DIR="$PROJECT_DIR/data"
BACKUP_DIR="$DATA_DIR/backups"
RETENTION_DAYS=30

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DB_FILE="$DATA_DIR/bot-live.db"
BACKUP_FILE="$BACKUP_DIR/bot-live-$TIMESTAMP.db"

if [[ ! -f "$DB_FILE" ]]; then
    echo "ERROR: Database not found at $DB_FILE"
    exit 1
fi

# Copy with sqlite3 backup API (safe for live DB)
if command -v sqlite3 >/dev/null; then
    sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"
else
    cp "$DB_FILE" "$BACKUP_FILE"
fi

echo "Backup created: $BACKUP_FILE"

# Compress
gzip "$BACKUP_FILE"
echo "Compressed: $BACKUP_FILE.gz"

# Cleanup old backups
find "$BACKUP_DIR" -name "bot-live-*.db.gz" -mtime +$RETENTION_DAYS -delete
echo "Cleaned backups older than $RETENTION_DAYS days"

# Optional: Upload to remote (rclone, aws s3, etc.)
# rclone copy "$BACKUP_FILE.gz" remote:polymarket-backups/