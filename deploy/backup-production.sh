#!/usr/bin/env bash
# Back up the persistent bot and n8n state without exposing contents in logs.
# Usage: bash deploy/backup-production.sh [/secure/backup/directory]

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BACKUP_ROOT="${1:-/var/backups/whatsapp-transaction-agent}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_ROOT/$STAMP"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not available to this user." >&2
  exit 1
fi

mkdir -p "$TARGET"
chmod 700 "$BACKUP_ROOT" "$TARGET"
umask 077

docker compose -f compose.production.yml exec -T bot \
  tar -czf - -C /app auth data > "$TARGET/bot-auth-and-data.tar.gz"
docker compose -f compose.production.yml exec -T n8n \
  tar -czf - -C /home/node .n8n > "$TARGET/n8n-data.tar.gz"

for archive in "$TARGET"/*.tar.gz; do
  [[ -s "$archive" ]] || { echo "ERROR: empty backup archive: $archive" >&2; exit 1; }
  tar -tzf "$archive" >/dev/null
done

echo "Backup created: $TARGET"
echo "Protect this directory; it contains WhatsApp session state and encrypted n8n credentials."
