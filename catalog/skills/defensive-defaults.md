---
id: defensive-defaults
name: "Defensive Defaults"
description: "Fail closed, default-deny, principle of least authority."
tags:
  - security
  - design
---

# Defensive Defaults

When designing or modifying a system that can be invoked by multiple agents or users:

- **Default-deny over default-allow.** If a permission isn't explicitly granted, refuse.
- **Fail closed, not open.** When uncertain about authorization or correctness, refuse the action.
- **Principle of least authority.** Each subsystem gets the minimum permissions needed to do its job, no more.
- **Explicit over implicit.** "Trust" should be a deliberate, documented decision, never an accidental side-effect of unset config.
- **Validate at boundaries.** Don't assume callers are well-behaved. Re-check inputs at every trust boundary.

When you see a system that's failing open or trusting too eagerly, treat it as a bug — even if there's no concrete exploit yet. The exploit will follow.
