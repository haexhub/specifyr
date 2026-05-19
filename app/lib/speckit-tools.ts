import { tool, type Tool } from "ai";

import {
  listFilesInput,
  readFileInput,
  searchCodeInput,
  readExistingSpecInput,
  listMyDraftsInput,
  loadDraftInput,
  updateDraftFilesInput,
} from "#shared/utils/spec-tools-schemas";

import { useActiveSessionStore } from "~/stores/active-session";

export type SpeckitToolContext = {
  orgSlug: string;
  projSlug: string;
};

function projectBase(ctx: SpeckitToolContext): string {
  return `/api/orgs/${ctx.orgSlug}/projects/${ctx.projSlug}`;
}

function encodePath(p: string): string {
  return p
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Build the seven LLM-callable tools that the browser-side agent
 * passes to `streamText`. Six are HTTP-backed against the typed REST
 * surface from Phase 1; the seventh (`update_draft_files`) is local
 * — it mutates the active-session store and the composable PATCHes
 * the result to the server after the turn completes.
 *
 * Why per-call store access: a singleton-import would freeze the
 * Pinia instance at module load, which is wrong in tests and in the
 * theoretical case of multiple Pinia roots. `useActiveSessionStore()`
 * resolves the active instance each time the tool runs.
 */
export function buildSpeckitTools(ctx: SpeckitToolContext): Record<string, Tool> {
  const base = projectBase(ctx);

  return {
    list_files: tool({
      description:
        "List files in the current project. Pass an optional glob to narrow the listing.",
      inputSchema: listFilesInput,
      execute: async ({ glob }) =>
        await $fetch(`${base}/files`, {
          query: glob ? { glob } : undefined,
        }),
    }),

    read_file: tool({
      description: "Read a single project file by its project-relative path.",
      inputSchema: readFileInput,
      execute: async ({ path }) =>
        await $fetch(`${base}/files/${encodePath(path)}`),
    }),

    search_code: tool({
      description:
        "Search the project's source for a literal string (ripgrep -F). Use this when you need to locate where a name is referenced.",
      inputSchema: searchCodeInput,
      execute: async (input) =>
        await $fetch(`${base}/search`, {
          method: "POST",
          body: input,
        }),
    }),

    read_existing_spec: tool({
      description:
        "Read the project's current published spec state. Omit `name` for all spec files, or pass it to read a single one.",
      inputSchema: readExistingSpecInput,
      execute: async ({ name }) =>
        await $fetch(`${base}/spec-public-state`, {
          query: name ? { name } : undefined,
        }),
    }),

    list_my_drafts: tool({
      description:
        "List the caller's own spec drafts (status=draft) plus their published history in this project.",
      inputSchema: listMyDraftsInput,
      execute: async () => await $fetch(`${base}/spec-drafts/mine`),
    }),

    load_draft: tool({
      description:
        "Load a draft by id (files + conversation history). Use this when resuming work from another device.",
      inputSchema: loadDraftInput,
      execute: async ({ draftId }) =>
        await $fetch(`${base}/spec-drafts/${draftId}`),
    }),

    update_draft_files: tool({
      description:
        "Replace the named files in the active draft. Use this to write spec content. The update is stored locally; the agent loop will PATCH it to the server after the turn finishes.",
      inputSchema: updateDraftFilesInput,
      execute: async ({ files }) => {
        const session = useActiveSessionStore();
        const merged: Record<string, string> = { ...(session.session?.files ?? {}) };
        for (const f of files) merged[f.name] = f.content;
        session.updateFiles(merged);
        return { ok: true as const, files: files.map((f) => f.name) };
      },
    }),
  };
}
