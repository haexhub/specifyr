import { z } from "zod";

/**
 * Tool-surface and REST-payload schemas for the browser-side Speckit
 * agent. Lives at the top-level `shared/` directory so the Nuxt-4
 * dual-import contract lets both Nitro endpoints and the browser-side
 * tool definitions consume the same Zod source.
 *
 * The seven LLM-callable tools (list_files, read_file, search_code,
 * read_existing_spec, list_my_drafts, load_draft, update_draft_files)
 * each declare an `<Name>Input` and `<Name>Output` schema. Six map to
 * REST endpoints; `update_draft_files` runs purely in the active-
 * session store and has no server route.
 *
 * The three user-actions (save / publish / discard) are not tool-
 * callable; their request/response schemas live in the lower half of
 * this file.
 */

// ---------------------------------------------------------------------------
// Primitive constraints (shared)
// ---------------------------------------------------------------------------

/** Project-relative path. No leading `/`, no `..` segment. */
export const projectRelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !p.startsWith("/"), "must be project-relative")
  .refine(
    (p) => !p.split("/").includes(".."),
    "must not contain '..' segment",
  );

/**
 * A glob expression rooted at the project directory. The pattern must
 * stay project-relative — `..` segments and absolute paths are rejected
 * so a caller cannot widen the search to the entire filesystem. The
 * Windows drive-letter check is defensive: server is POSIX-only today,
 * but the schema also runs in the browser bundle in Phase 2 where the
 * input could originate from a different OS.
 */
const ABSOLUTE_GLOB_RE = /^(?:[\\/]|[A-Za-z]:[\\/])/;

export const safeGlob = z
  .string()
  .min(1)
  .max(512)
  .refine((g) => !g.includes(".."), "glob must not contain '..'")
  .refine((g) => !ABSOLUTE_GLOB_RE.test(g), "glob must be project-relative");

/** Bare file name inside `specs/` — no slashes, no dots-only. */
export const specFileName = z
  .string()
  .min(1)
  .max(128)
  .refine((n) => !n.includes("/"), "must be a bare file name")
  .refine((n) => !n.startsWith("."), "must not start with '.'");

export const draftId = z.string().uuid();
export const projectId = z.string().uuid();

// ---------------------------------------------------------------------------
// LLM tool 1 — list_files
// ---------------------------------------------------------------------------

export const listFilesInput = z.object({
  glob: safeGlob.optional(),
});

export const listFilesOutput = z.object({
  files: z.array(
    z.object({
      path: projectRelativePath,
      type: z.enum(["file", "directory"]),
    }),
  ),
  truncated: z.boolean(),
});

// ---------------------------------------------------------------------------
// LLM tool 2 — read_file
// ---------------------------------------------------------------------------

export const readFileInput = z.object({
  path: projectRelativePath,
});

export const readFileOutput = z.object({
  content: z.string(),
  encoding: z.enum(["utf-8", "base64"]),
});

// ---------------------------------------------------------------------------
// LLM tool 3 — search_code
// ---------------------------------------------------------------------------

export const searchCodeInput = z.object({
  query: z.string().min(1).max(512),
  glob: safeGlob.optional(),
  limit: z.number().int().min(1).max(500).default(100),
});

export const searchCodeOutput = z.object({
  matches: z.array(
    z.object({
      path: projectRelativePath,
      line: z.number().int().positive(),
      snippet: z.string(),
    }),
  ),
  truncated: z.boolean(),
});

// ---------------------------------------------------------------------------
// LLM tool 4 — read_existing_spec (current public state)
// ---------------------------------------------------------------------------

export const readExistingSpecInput = z.object({
  name: specFileName.optional(),
});

export const readExistingSpecOutput = z.object({
  version: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      name: specFileName,
      content: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// LLM tool 5 — list_my_drafts
// ---------------------------------------------------------------------------

export const listMyDraftsInput = z.object({});

export const draftStatus = z.enum(["draft", "published"]);

export const draftSummary = z.object({
  id: draftId,
  title: z.string(),
  baseVersion: z.number().int().nonnegative(),
  status: draftStatus,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});

export const listMyDraftsOutput = z.object({
  drafts: z.array(draftSummary),
});

// ---------------------------------------------------------------------------
// LLM tool 6 — load_draft
// ---------------------------------------------------------------------------

export const loadDraftInput = z.object({
  draftId,
});

/**
 * Conversation is the Vercel-AI-SDK message array. Validated only as
 * "JSON-serialisable array of objects" at the boundary — semantic
 * validation happens in the SDK on consumption.
 */
export const conversationMessageList = z.array(z.record(z.string(), z.unknown()));

export const loadDraftOutput = z.object({
  id: draftId,
  title: z.string(),
  baseVersion: z.number().int().nonnegative(),
  status: draftStatus,
  files: z.array(
    z.object({
      name: specFileName,
      content: z.string(),
    }),
  ),
  conversation: conversationMessageList,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
});

// ---------------------------------------------------------------------------
// LLM tool 7 — update_draft_files (LOCAL — no REST equivalent)
// ---------------------------------------------------------------------------

export const updateDraftFilesInput = z.object({
  files: z
    .array(
      z.object({
        name: specFileName,
        content: z.string(),
      }),
    )
    .min(1),
});

export const updateDraftFilesOutput = z.object({
  ok: z.literal(true),
  files: z.array(specFileName),
});

// ---------------------------------------------------------------------------
// User-action — POST /spec-drafts (create) / PATCH /spec-drafts/{id} (save)
// ---------------------------------------------------------------------------

export const createDraftBody = z.object({
  title: z.string().min(1).max(256),
  baseVersion: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      name: specFileName,
      content: z.string(),
    }),
  ),
  conversation: conversationMessageList,
});

export const createDraftResponse = z.object({
  draftId,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const patchDraftBody = z
  .object({
    title: z.string().min(1).max(256).optional(),
    files: z
      .array(
        z.object({
          name: specFileName,
          content: z.string(),
        }),
      )
      .optional(),
    conversation: conversationMessageList.optional(),
  })
  .refine(
    (b) =>
      b.title !== undefined ||
      b.files !== undefined ||
      b.conversation !== undefined,
    "at least one of { title, files, conversation } is required",
  );

export const patchDraftResponse = z.object({
  updatedAt: z.string().datetime(),
});

// ---------------------------------------------------------------------------
// User-action — POST /spec-drafts/{id}/publish (compare-and-swap)
// ---------------------------------------------------------------------------

export const publishDraftBody = z.object({}).strict();

export const publishDraftSuccess = z.object({
  ok: z.literal(true),
  newPublicVersion: z.number().int().positive(),
});

/**
 * Returned with HTTP 409 when `draft.baseVersion` is behind
 * `project.spec_public_version`. Includes the current public state so
 * the UI can render a diff without a second round-trip.
 */
export const publishDraftConflict = z.object({
  conflict: z.literal(true),
  currentPublicVersion: z.number().int().nonnegative(),
  currentPublicFiles: z.array(
    z.object({
      name: specFileName,
      content: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// User-action — DELETE /spec-drafts/{id}
// ---------------------------------------------------------------------------

/**
 * Hard delete for `status="draft"`. Returns 409 if `status="published"`
 * (audit-trail rows are immutable — see ADR Section "Resolved Phase-0
 * Design Questions / 1").
 */
export const deleteDraftResponse = z.object({
  ok: z.literal(true),
});

// ---------------------------------------------------------------------------
// Inferred types for cross-importing
// ---------------------------------------------------------------------------

export type ListFilesInput = z.infer<typeof listFilesInput>;
export type ListFilesOutput = z.infer<typeof listFilesOutput>;
export type ReadFileInput = z.infer<typeof readFileInput>;
export type ReadFileOutput = z.infer<typeof readFileOutput>;
export type SearchCodeInput = z.infer<typeof searchCodeInput>;
export type SearchCodeOutput = z.infer<typeof searchCodeOutput>;
export type ReadExistingSpecInput = z.infer<typeof readExistingSpecInput>;
export type ReadExistingSpecOutput = z.infer<typeof readExistingSpecOutput>;
export type ListMyDraftsOutput = z.infer<typeof listMyDraftsOutput>;
export type LoadDraftInput = z.infer<typeof loadDraftInput>;
export type LoadDraftOutput = z.infer<typeof loadDraftOutput>;
export type UpdateDraftFilesInput = z.infer<typeof updateDraftFilesInput>;
export type UpdateDraftFilesOutput = z.infer<typeof updateDraftFilesOutput>;
export type DraftSummary = z.infer<typeof draftSummary>;
export type CreateDraftBody = z.infer<typeof createDraftBody>;
export type CreateDraftResponse = z.infer<typeof createDraftResponse>;
export type PatchDraftBody = z.infer<typeof patchDraftBody>;
export type PatchDraftResponse = z.infer<typeof patchDraftResponse>;
export type PublishDraftSuccess = z.infer<typeof publishDraftSuccess>;
export type PublishDraftConflict = z.infer<typeof publishDraftConflict>;
