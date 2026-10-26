---
name: auth-implementation-patterns
description: Implement and review authentication and authorization in the Filtra API.
---
# Authentication and authorization

- Follow the existing JWT, MFA/WebAuthn, password-reset, and session design; do not create parallel auth paths without a migration plan.
- Verify signature, expiry, and configured issuer/audience; never trust identity or tenant IDs supplied only in request bodies.
- Authorize every object-level read/write against the authenticated principal and tenant, including admin and MCP entry points.
- Keep password reset and MFA recovery flows one-time, expiring, rate-limited, and non-enumerating.
- Store secrets only in environment variables or secret managers; never log tokens, password material, recovery codes, or full auth headers.
- Use secure cookie flags where applicable and protect cookie-authenticated mutations against CSRF.
- Fail closed when auth configuration is absent or invalid. Do not loosen CORS to make tests pass.
- Add negative tests for expired, malformed, wrong-role, cross-tenant, replayed, and revoked credentials.
