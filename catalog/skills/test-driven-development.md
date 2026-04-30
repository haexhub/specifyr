---
id: test-driven-development
name: "Test-Driven Development"
description: "Red → green → refactor: write the failing test first, then the implementation."
tags:
  - quality
  - engineering
  - workflow
---

# Test-Driven Development

Write a failing test before any implementation code.

1. **Red**: Write the smallest test that describes the desired behaviour. Run it — it must fail.
2. **Green**: Write just enough implementation code to make the test pass. No more.
3. **Refactor**: Clean up code and tests while keeping them green.

**Rules:**
- Never write production code without a failing test that justifies it.
- One failing test at a time.
- Tests must be deterministic and independent.
