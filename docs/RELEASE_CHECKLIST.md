# RELEASE CHECKLIST

## Local release
- [ ] all unit tests pass
- [ ] all integration tests pass
- [ ] OCR accuracy report reviewed
- [ ] no secrets in git
- [ ] no auth/session in git
- [ ] no client production data
- [ ] logs checked
- [ ] error paths tested
- [ ] docs updated
- [ ] git commit created

## Production release
- [ ] client approval
- [ ] DigitalOcean approved
- [ ] server hardened
- [ ] HTTPS configured
- [ ] n8n protected
- [ ] secrets injected securely
- [ ] backup plan
- [ ] monitoring
- [ ] Stripe test verification completed
- [ ] Google Sheets restricted
- [ ] Telegram restricted
- [ ] pilot groups selected
- [ ] rollback tested

## Rollout
- [ ] 1-3 groups
- [ ] observe
- [ ] 5 groups
- [ ] observe
- [ ] 10 groups
- [ ] observe
- [ ] 25 groups
- [ ] observe
- [ ] 50+ groups
