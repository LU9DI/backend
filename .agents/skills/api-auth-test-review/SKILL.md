---
name: api-auth-test-review
description: Review API authentication, tenant authorization, payment callbacks, and regression coverage.
---
# API auth and regression review

For each changed route, map the trust boundary and identify the principal, tenant, role, and side effects.

## Test matrix
- no credentials, malformed token, expired token, revoked token, insufficient role;
- object belongs to another tenant/user;
- missing, extra, malformed, and oversized input;
- duplicate/replayed request and concurrent mutation;
- provider callback with invalid signature, stale timestamp, or duplicate event;
- dependency/database/provider failure and safe retry.

Use the repository's test commands and fixtures. Prefer behavior assertions over source-text matching. Never use production secrets, customer records, or live payment actions in tests. Report untested cases; do not label static review as penetration testing.
