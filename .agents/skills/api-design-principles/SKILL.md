---
name: api-design-principles
description: Design consistent, backward-compatible HTTP APIs for the Filtra backend.
---
# API design principles

- Inspect existing route, middleware, response, error, and versioning conventions before adding endpoints.
- Validate path, query, and body at the boundary with established schemas; reject malformed input rather than coercing ambiguously.
- Keep authentication, authorization, tenant scoping, validation, business logic, and persistence as explicit layers.
- Return stable status codes and structured errors without stack traces, SQL details, tokens, or personal data.
- Bound pagination, payload sizes, timeouts, and expensive operations; apply rate limits to sensitive or costly routes.
- Make mutations idempotent where retries are expected; use transactions for multi-step persistence.
- Preserve compatibility and document behavior changes. Never invent an API contract that disagrees with runtime behavior.
- Test unauthorized, forbidden, invalid, cross-tenant, duplicate, and successful cases.
