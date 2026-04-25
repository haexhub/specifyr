---
id: pr-review-checklist
name: "PR Review Checklist"
description: "Structured pass over a diff before approving."
tags:
  - quality
  - review
---

# PR Review Checklist

Walk a diff with this checklist before approving:

**Correctness**
- Does the change do what its description claims?
- Does it match the spec / acceptance criteria?
- Are edge cases (empty input, null, max-size, concurrency) handled?

**Tests**
- Is there a test that would have caught the bug being fixed (for fixes)?
- Is there a test for new behavior (for features)?
- Do existing tests still cover what they were intended to cover, or did the diff weaken them?

**Style & convention**
- Does it match the project's existing style (naming, formatting, file layout)?
- No dead code, no commented-out blocks, no debug `console.log`?
- No unrelated "drive-by" changes mixed in?

**Risk surface**
- Does it touch security-critical code (auth, payment, secrets)? Extra scrutiny.
- Does it change a public API or DB schema? Migration path documented?
- Does it add new dependencies? Are they trustworthy and necessary?

**Comments**
- Where the code is non-obvious, is the *why* explained (not the what)?
- No comments that will rot (referencing tickets, "added because of bug X" style)?

If any item is "no" or "unclear", request changes. Don't approve to be polite.
