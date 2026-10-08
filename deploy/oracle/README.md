# Filtra.IA — Oracle Always Free backup runtime

This stack is a secondary runtime. Render remains the primary API.

## VM

Use OCI Ampere A1 Flex in the tenancy home region with the Always Free allocation (2 OCPUs and 12 GB RAM total), Ubuntu, and Always Free-eligible storage.

## One-time setup

1. Create the VM and SSH key in Oracle Cloud.
2. Restrict TCP/22 to your administration IP when practical.
3. SSH to the VM.
4. Run `sudo bash bootstrap.sh`.
5. Populate `/opt/filtra-ai/.env` with the same production variables used by Render.
6. Do not commit the `.env`.
7. Configure the Cloudflare Tunnel to forward to `http://127.0.0.1:5000`.

## GitHub secrets

- `ORACLE_HOST` — VM public IP or DNS
- `ORACLE_USER` — usually `ubuntu`
- `ORACLE_SSH_KEY` — private key matching the VM
- `ORACLE_KNOWN_HOSTS` — `ssh-keyscan -H <host>` output

After these are present, every push to `master` builds an ARM64 image, publishes both `latest` and the commit SHA to GHCR, then deploys the immutable SHA to the VPS.

## Required application configuration

`NODE_ENV=production`, `JWT_SECRET`, PostgreSQL `DATABASE_URL` (or supported Supabase Postgres variables), `ADMIN_PASSWORD`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `APP_URL`, `FRONTEND_URL`, and `CORS_ORIGINS` are required/expected according to the application environment validator.

Keep PostgreSQL managed externally. The VPS is compute only.

## Rollback

The deployment waits for `/api/live`. If the new container fails health checks, the script restores the previous immutable image tag and exits non-zero.

## Notes

Oracle documents that Always Free compute must be provisioned in the home region and that idle Always Free compute can be reclaimed under its published utilization rules.
