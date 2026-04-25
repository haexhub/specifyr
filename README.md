# SpecOps V1

SpecOps is a local, spec-driven orchestration tool for building software through explicit artifacts instead of opaque agent prompts. The intended workflow is:

1. Formulate the work clearly in `spec-kit`.
2. Sync the finalized spec into SpecOps.
3. Let SpecOps generate the plan and work items.
4. Let `hermes-agent` execute the approved work.
5. Use `fabric` only where critique, summaries, or refinement patterns are useful.

Each initiative lives under `.specops/<slug>/` and moves through visible stages: `draft`, `refined`, `planned`, `approved_for_execution`, `running`, `blocked`, `completed`, `failed`.

## What is included

- A repo-native artifact store for specs, plans, tasks, run state, and event logs
- A central orchestrator with approval gates
- Provider and runner interfaces with local adapters for model generation and Hermes-style agent execution
- Optional CLI adapters for `fabric` and `hermes` with safe fallback to local implementations
- A `.specify/` mirror for spec-kit-style artifact navigation
- Fabric-inspired pattern resolution by workflow stage
- A Nuxt 4 UI built with Vue, Tailwind, and shadcn-style components for timeline, artifact, and run inspection

## CLI

```bash
node ./src/index.js init
node ./src/index.js config show
node ./src/index.js config set integrations.fabric.enabled true
node ./src/index.js config set integrations.hermes.enabled true
node ./src/index.js spec create "Build a transparent spec-driven orchestrator"
node ./src/index.js spec sync my-spec
node ./src/index.js spec refine my-spec
node ./src/index.js plan generate my-spec
node ./src/index.js tasks generate my-spec
node ./src/index.js approve my-spec spec
node ./src/index.js approve my-spec plan
node ./src/index.js approve my-spec task_batch
node ./src/index.js run start my-spec
node ./src/index.js run status my-spec
node ./src/index.js ui
```

## Notes

- Artifacts are plain files under `.specops/`.
- Specs can be authored in `.specify/specs/<slug>/spec.md` and pulled into SpecOps with `spec sync <slug>`.
- SpecOps also mirrors every initiative back into `.specify/specs/<slug>/` so the workflow stays compatible with spec-kit-style navigation.
- The default model provider and Hermes runner are deterministic local implementations so the project works without external services.
- If `fabric` or `hermes` are installed locally, you can enable them via `config set` and SpecOps will use them opportunistically.
- The UI runs through Nuxt. For local development use `pnpm dev` or `node ./src/index.js ui`.
