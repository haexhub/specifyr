---
id: speckit-speckit-company-validate
name: "Company Validate"
description: "Consistency check: graph integrity, tools, models, mode-constraints, budget."
tags:
  - speckit
  - company
  - validation
---

# Company Validate

Validates the company configuration before starting.

Checks:
- Agent graph integrity (CEO → workers, no orphans)
- Tool and skill references exist in catalog
- Model constraints match operating mode
- Budget limits are configured
- Constitution is ratified
