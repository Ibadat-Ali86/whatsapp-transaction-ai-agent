# DigitalOcean single-Droplet deployment

This runbook describes the first production-shaped deployment for one Baileys
WhatsApp session, one n8n instance, and one OCR/Stripe service. It does not
create a managed database. The queue and duplicate ledger are persisted in
Docker volumes and must be backed up.

## Sizing

Use the 2 GB RAM plan for a low-volume pilot. The 2 vCPU / 2 GB plan is the
safer choice when several groups may send screenshots in bursts. Keep
`PROCESSING_QUEUE_CONCURRENCY=1` until peak throughput is measured. A 1 GB
Droplet is not recommended for this three-service stack.

## 1. Prepare Ubuntu

Use an Ubuntu LTS Droplet with an SSH key and a non-root deployment user. On
the Droplet, install Docker Engine and the Compose plugin using Docker's
official Ubuntu instructions. Do not install n8n globally on the host.

```bash
git clone https://github.com/Ibadat-Ali86/whatsapp-transaction-ai-agent.git
cd whatsapp-transaction-ai-agent
mkdir -p deploy/env
cp deploy/env/bot.env.example deploy/env/bot.env
cp deploy/env/ocr.env.example deploy/env/ocr.env
cp deploy/env/n8n.env.example deploy/env/n8n.env
chmod 600 deploy/env/*.env
```

## 2. Create secrets on the Droplet

Generate values locally on the Droplet or through an approved secret manager;
never put them in Git, workflow exports, WhatsApp, or normal chat logs.

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Place one generated value in `N8N_ENCRYPTION_KEY` in `deploy/env/n8n.env`.
Place the other in both `N8N_WEBHOOK_TOKEN` in `bot.env` and the n8n webhook
Header Auth credential. Generate a separate token for `STRIPE_SERVICE_TOKEN`
in `ocr.env` and the n8n `OCR service Stripe verifier auth` credential.

Put the approved restricted live Stripe secret only in `ocr.env`. The bot and
n8n containers must never receive `STRIPE_SECRET_KEY`.

## 3. Configure group and Stripe settings

Edit only the environment files on the Droplet:

- `bot.env`: exact comma-separated `WHATSAPP_ALLOWED_GROUP_JIDS`, n8n token,
  and queue settings.
- `ocr.env`: Stripe live mode, restricted read-only secret, Stripe service
  token, and approved AI provider settings.
- `n8n.env`: n8n encryption key and editor URL settings.

The production Compose file overrides service URLs to use Docker DNS:
`http://ocr:8000` and `http://n8n:5678`. Do not use `localhost` between
containers.

## 4. Build and start

Run these commands from the repository root:

```bash
docker compose -f compose.production.yml config
docker compose -f compose.production.yml build
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml ps
```

`config` must complete without errors. Do not paste its output if it contains
expanded secret values. The n8n editor is bound to `127.0.0.1` only; OCR has
no public host port.

## 5. Configure n8n through an SSH tunnel

From your workstation, open an SSH tunnel:

```bash
ssh -N -L 5678:127.0.0.1:5678 deploy-user@DROPLET_IP
```

Open `http://127.0.0.1:5678`, create the n8n owner account, and import
`n8n/workflows/whatsapp-screenshot-processor_v2_docker_20260915.json`.
Configure the two Header Auth credentials, save the workflow, and activate
it. The workflow must remain inactive until the credentials and internal URLs
are verified.

## 6. Verify private service connectivity

```bash
docker compose -f compose.production.yml exec bot node -e "fetch('http://ocr:8000/health/ready').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
docker compose -f compose.production.yml exec bot node -e "fetch('http://n8n:5678/healthz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
docker compose -f compose.production.yml logs --tail=100 bot ocr n8n
```

Then link Baileys through the QR flow shown by the bot container:

```bash
docker compose -f compose.production.yml logs -f bot
```

Use one dedicated pilot group first. Send one approved test screenshot, then
test a duplicate, a missing caption, an ambiguous match, and a temporary
service failure. Confirm the queue log messages, final reaction, retry, and
dead-letter behavior.

## Security and operations

- Allow SSH only from trusted IPs in the DigitalOcean Cloud Firewall.
- Do not expose ports 8000 or 5678 publicly.
- Expose 80/443 only after configuring a TLS reverse proxy for the n8n editor.
- Enable Droplet backups and monitoring; test restoring auth, queue, duplicate,
  and n8n volumes before production use.
- Run exactly one bot container for the WhatsApp auth volume.
- Keep the bot container as the only process using its auth and data volumes;
  the application PID lock also prevents a second bot process inside the same
  deployment from contending for the session.
- Keep live Stripe mode restricted to approved groups and read-only keys.
- Disable Groq fallback if client policy does not permit images to leave the
  Droplet.

## Rollback

```bash
docker compose -f compose.production.yml stop bot
git switch --detach <known-good-commit>
docker compose -f compose.production.yml build bot
docker compose -f compose.production.yml up -d bot
```

Use a clean deployment checkout for this operation, or preserve any local
changes before switching revisions. Do not delete Docker volumes during
rollback. They contain the WhatsApp session, queue, duplicate metadata, and
n8n encryption state.

This deployment is single-host and single-process. Before adding another bot
or OCR worker, migrate queue and duplicate claims to shared transactional
storage and add distributed locking.
