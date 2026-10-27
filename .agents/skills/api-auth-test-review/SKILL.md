---
name: api-auth-test-review
description: Review API authentication, authorization, tenant isolation, webhook security, and regression coverage.
---

# API Auth and Security Test Review

Use for route handlers, sessions, JWTs, MFA/WebAuthn, tenant-scoped data, CORS, rate limits, webhooks, and security-sensitive middleware.

1. Trace the request from entrypoint through authentication, authorization, validation, business logic, and persistence.
2. Verify object- and tenant-level authorization on every path; authentication alone is not authorization.
3. Test unauthenticated, unauthorized, wrong-tenant, expired/invalid credential, malformed input, rate-limit, and success cases as applicable.
4. Keep webhook verification fail-closed; compare secrets safely and validate signatures/timestamps before processing side effects.
5. Never log secrets, tokens, passwords, session cookies, raw personal data, or full customer payloads. Use synthetic fixtures.
6. Preserve CORS allowlists, secure cookie settings, rate limits, and existing account/MFA boundaries; do not broaden access to make a test pass.
7. Add regression tests for each fixed security issue and verify expected error status/body without leaking internal details.
8. Run targeted tests, the full test suite, build/typecheck, and production dependency audit where practical. Report each result separately.
9. Do not claim all tests passed from a successful dependency audit. Do not deploy or migrate production data as part of this skill.
