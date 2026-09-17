#!/usr/bin/env bash
# Validate the production Compose configuration without printing secrets.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

COMPOSE_FILE="compose.production.yml"
ENV_FILES=(deploy/env/bot.env deploy/env/ocr.env deploy/env/n8n.env)

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is not installed or not available to this user." >&2
  exit 1
fi

for file in "${ENV_FILES[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "ERROR: missing $file; copy its .example file and fill it on the Droplet." >&2
    exit 1
  fi
  if [[ "$(stat -c '%a' "$file")" != "600" ]]; then
    echo "ERROR: $file must have mode 600." >&2
    exit 1
  fi
done

read_env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$file"
}

require_env_value() {
  local file="$1"
  local key="$2"
  local value
  value="$(read_env_value "$file" "$key")"
  if [[ -z "$value" ]]; then
    echo "ERROR: $key is empty in $file." >&2
    exit 1
  fi
}

require_env_value deploy/env/bot.env WHATSAPP_ALLOWED_GROUP_JIDS
require_env_value deploy/env/bot.env N8N_WEBHOOK_TOKEN
require_env_value deploy/env/ocr.env STRIPE_SECRET_KEY
require_env_value deploy/env/ocr.env STRIPE_SERVICE_TOKEN
require_env_value deploy/env/n8n.env N8N_ENCRYPTION_KEY

if [[ "$(read_env_value deploy/env/ocr.env STRIPE_MODE)" != "live" ]]; then
  echo "ERROR: deploy/env/ocr.env must explicitly set STRIPE_MODE=live for this production stack." >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" config --quiet

echo "Production configuration: PASS"
echo "Secrets: present and not displayed"
echo "Compose file: valid"
echo "Next: docker compose -f $COMPOSE_FILE build && docker compose -f $COMPOSE_FILE up -d"
