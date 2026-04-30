---
id: tdd
name: "Test-Driven Development"
description: >
  Use when starting any feature implementation or bug fix — write the failing test first.
  Don't use when the task is pure documentation, configuration, or exploration with no testable behavior.
tags:
  - quality
  - engineering
  - workflow
---

# Test-Driven Development

When implementing any feature or bug fix:

1. **Red** — Write a test that captures the desired behavior. Run it. Confirm it fails for the *right* reason (missing implementation, not setup error).
2. **Green** — Write the minimum code that makes the test pass. Don't generalize, don't optimize.
3. **Refactor** — Clean up the code with the safety net of green tests.

**Rules:**
- Never claim work done without a test that captures the requirement.
- If the test would be hard to write (mocking required, brittle setup), the production code is probably structured wrong — fix the design first.
- One test, one assertion path. Multi-assert tests hide which behavior actually broke.
