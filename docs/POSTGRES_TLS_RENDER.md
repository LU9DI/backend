# PostgreSQL TLS troubleshooting on Render

The API deliberately validates PostgreSQL TLS certificates. Do not set `PGSSL=0` for a remote database and do not disable `rejectUnauthorized`.

If Render logs show `SELF_SIGNED_CERT_IN_CHAIN`:

1. Confirm `DATABASE_URL` points to the intended provider's official PostgreSQL endpoint or pooler. Do not publish the URL because it contains credentials.
2. In the database provider dashboard, obtain the official CA certificate/CA bundle required for that endpoint. Do not use a certificate copied from an untrusted connection.
3. In Render → `filtra-ia-api` → Environment, set `PGSSL_CA` to the PEM certificate contents. If the environment editor requires a single line, encode line breaks as literal `\n`; the adapter converts those back to newlines.
4. Save and redeploy, then inspect logs. A successful startup should no longer log `SELF_SIGNED_CERT_IN_CHAIN`.
5. Validate `/api/live` (process liveness) and `/api/health` (database readiness). Login should only be tested after the database reports healthy.

The application now accepts `PGSSL_CA` while keeping `rejectUnauthorized: true`. Supplying a CA does not bypass certificate validation; it adds the provider's trusted CA to the TLS verification configuration.

If the provider does not require a custom CA, investigate whether the configured hostname or connection URL is wrong, or whether a proxy is intercepting TLS. Do not work around the error by disabling certificate verification.
