# DigitalOcean single-Droplet deployment

This runbook describes the first production-shaped deployment for one Baileys
WhatsApp session, one n8n instance, and one OCR/Stripe service. It does not
create a managed database. The queue and duplicate ledger are persisted in
Docker volumes and must be backed up.

## Sizing

Use at least 2 GB RAM for a low-volume pilot. The `$7` option shown in the
provided screenshot has 1 vCPU and 1 GB RAM; it may boot this stack, but it is
not a responsible 24/7 production baseline because n8n, Tesseract/OCR, and
Baileys compete for a very small memory budget. A 2 GB plan is the minimum
recommendation for 5–8 groups. Choose 2 vCPU / 2 GB when available for burst
headroom. Keep `PROCESSING_QUEUE_CONCURRENCY=1` until peak throughput is
measured.

The 50+ group target means the allowlist and fairness logic can serve many
groups; it does not promise 50 simultaneous OCR pipelines. The default worker
processes one payment at a time, applies backpressure at 200 pending jobs, and
uses retries/dead-letter review for transient or permanent failures. Measure
the real median and p95 end-to-end processing time with synthetic screenshots
before increasing capacity or changing concurrency.

## 1. Prepare Ubuntu

Use an Ubuntu LTS Droplet with an SSH key and a non-root deployment user. The
DigitalOcean Docker 1-Click image is acceptable for this stack; otherwise
install Docker Engine and the Compose plugin using Docker's official Ubuntu
instructions. Do not install n8n globally on the host.

In the DigitalOcean control panel:

1. Choose **Create > Droplets** and select Ubuntu LTS or the Docker 1-Click
   image.
2. Choose a plan with **at least 2 GB RAM**. For this three-container stack,
   the `$7` 1 GB plan is a temporary trial option only.
3. Add an SSH key; do not use password-only authentication.
4. Enable monitoring, IPv6, VPC/private networking, and automated backups.
5. Create a Cloud Firewall allowing inbound TCP 22 only from your trusted
   workstation IP, with outbound traffic allowed for Docker image pulls,
   Stripe, Groq (if enabled), and WhatsApp.
6. Do not add public inbound rules for ports 8000 or 5678. The Compose file
   binds n8n to loopback and keeps OCR private.

On the first login, create a deployment user and verify a second SSH session
before disabling root/password login:

```bash
apt update && apt install -y git ca-certificates openssl
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
usermod -aG docker deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Open a new terminal and verify `ssh deploy@DROPLET_IP` works. Then harden SSH:

```bash
cat >/etc/ssh/sshd_config.d/99-whatsapp-agent.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sshd -t && systemctl reload ssh
```

If you select the 1 GB trial plan, add swap before building, but treat it as
an emergency buffer rather than extra RAM:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

```bash
git clone https://github.com/Ibadat-Ali86/whatsapp-transaction-ai-agent.git
cd whatsapp-transaction-ai-agent
mkdir -p deploy/env
cp deploy/env/bot.env.example deploy/env/bot.env
cp deploy/env/ocr.env.example deploy/env/ocr.env
cp deploy/env/n8n.env.example deploy/env/n8n.env
chmod 600 deploy/env/*.env
```

Before starting, validate the files without printing their values:

```bash
bash deploy/validate-production.sh
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
The Compose file pins n8n to the stable v1 image `n8nio/n8n:1.123.80` rather
than a floating `latest` tag. Verify workflow import and authentication on the
Droplet before activating live processing.

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

The webhook credential must use header name `X-Webhook-Token` and the exact
value from `bot.env`. The OCR credential must use header name
`X-Internal-Service-Token` and the exact value from `ocr.env`. Never paste
either value into the workflow export or a screenshot.

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

The QR is normally required only for the first link. The `bot_auth` volume
must remain intact so restarts reuse the linked WhatsApp session. Run exactly
one bot container for that volume.

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
- Create a protected backup before upgrades or credential rotation:

  ```bash
  bash deploy/backup-production.sh /var/backups/whatsapp-transaction-agent
  ```

  This backs up the bot auth/data and n8n state only; raw screenshots are not
  backed up. Restrict the backup directory because it contains session
  material and encrypted n8n credentials.
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

## Pilot acceptance sequence

Do not treat a green container status as payment-verification acceptance. In
one approved group, verify all of the following and retain only redacted logs:

1. valid screenshot with an exact caption email;
2. valid screenshot with no caption email but deterministic OCR/Stripe match;
3. mistyped caption email where Stripe identity can recover the payment;
4. exact duplicate in the same group;
5. exact duplicate in another allowlisted group;
6. ambiguous or missing Stripe evidence, which must remain `UNCLEAR`/`❌`, not
   an automatic accusation of fraud;
7. temporary OCR or Stripe outage, confirming retry and dead-letter behavior.

Roll out gradually: 1–3 groups, observe queue depth and p95 duration, then 5,
10, 25, and finally 50+ groups. A Droplet provides an always-on host, but
24/7 behavior still depends on persistent Docker volumes, restart policies,
backups, monitoring, and a stable WhatsApp session.
