---
id: verification-before-completion
name: "Verification Before Completion"
description: "Don't claim work done without running the verification commands and checking output."
tags:
  - quality
  - completion-gate
---

# Verification Before Completion

Before marking any task as complete, before committing, before opening a PR — run the verification:

- `pnpm test` (or the project's test command). Output must show 0 failures.
- `pnpm build` or equivalent. Output must show no errors.
- Lint and type-check, if the project has them. Output must show 0 errors.

**Hard rules:**
- *Evidence before assertions.* Don't say "tests pass" without showing the test runner output.
- *Don't trust a successful exit code in isolation.* If a test was added but no test ran, the run is misleading.
- *Don't disable, skip, or `it.todo` failing tests* to make the suite green. Fix the test or the code.

If verification fails, treat the task as incomplete. Investigate root cause; do not patch around symptoms.
