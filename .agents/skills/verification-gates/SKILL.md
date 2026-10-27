---
name: verification-gates
description: Require reproducible acceptance criteria and honest validation reports for code changes.
---

# Verification Gates

1. Define observable acceptance criteria before editing.
2. Inspect repository instructions, source ownership, and relevant tests first.
3. Make narrow changes and preserve existing contracts unless a change is requested.
4. Add regression tests for the changed behavior and failure paths.
5. Run targeted tests, then the full test suite, typecheck/build, and security audit as applicable.
6. Report passed, failed, skipped, and not-run checks separately, with exact commands and commit/run identifiers.
7. Never bypass failures by disabling checks, weakening assertions, or hiding errors.
8. A dependency audit passing does not imply that the test suite or application build passed.
9. Do not deploy, migrate production data, or trigger external side effects without explicit authorization.
