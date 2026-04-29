---
id: systematic-debugging
name: "Systematic Debugging"
description: >
  Use when a concrete failure has appeared and the root cause is unclear.
  Don't use for speculative pre-optimization — only after a reproducible failure is in hand.
tags:
  - quality
  - debugging
---

# Systematic Debugging

When a bug appears:

1. **Reproduce reliably.** Write a minimal failing test or a repeatable command sequence. If you can't reproduce, you can't claim a fix.
2. **Form a hypothesis.** State what you think is wrong, in one sentence. Why this and not something else?
3. **Verify the hypothesis** by reading the code along the suspected path. Don't change anything yet.
4. **Test the hypothesis** with a minimal probe (a `console.log`, a debugger, a stripped-down repro).
5. **Only then** propose a fix. The fix should target the root cause, not a downstream symptom.

**Anti-patterns to avoid:**
- "Try changing X and see if it works." If you don't know *why* a change should help, you're guessing.
- Adding `try/catch` that hides the symptom. You haven't fixed anything.
- "Works on my machine" — investigate the environmental delta.
- More than two failed fix attempts in a row → stop, escalate, get a second pair of eyes.
