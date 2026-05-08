import { z } from "zod";
import { getExtensionCatalog } from "@su/extension-catalog";
import { SPEC_KIT_WORKFLOW } from "@su/workflow-discovery";
import { getAppConfigModule } from "@su/app-config";
import { readLocalManifest } from "@su/local-extension";
import { listOrgExtensions } from "@su/org-extensions-store";
import { getMembership, getOrgBySlug } from "@su/org-store";
import { parseQuery } from "@su/validation";

// Entries suitable for a pre-project workflow picker: spec-kit plus any extension
// that self-declares the `workflow` tag. Step lists are intentionally not populated —
// they are only known after the extension is installed (extension.yml on disk).
interface CatalogWorkflowSummary {
  id: string;
  label: string;
  description: string;
  source: "built-in" | "extension";
  extensionSlug?: string;
  version?: string;
  /** Where the entry came from when source='extension'. */
  origin?: "deployment" | "bundled" | "org" | "community";
}

// Mirrors the check in workflow-discovery.ts: workflow tag + no hooks + >= 3 commands.
const WORKFLOW_MIN_COMMANDS = 3;

const querySchema = z.object({
  orgSlug: z.string().trim().min(1).max(64).optional(),
});

export default defineEventHandler(async (event) => {
  const { orgSlug } = parseQuery(event, querySchema);
  const userId = event.context.userId;

  const summaries: CatalogWorkflowSummary[] = [
    {
      id: SPEC_KIT_WORKFLOW.id,
      label: SPEC_KIT_WORKFLOW.label,
      description: SPEC_KIT_WORKFLOW.description,
      source: SPEC_KIT_WORKFLOW.source
    }
  ];

  // Org-scoped extensions take precedence — they are private to the
  // org and the caller must be a member to see them. Resolution
  // intentionally fails closed (no entries) when the caller isn't
  // entitled, rather than throwing, so the picker still renders.
  if (orgSlug && userId) {
    const org = await getOrgBySlug(orgSlug);
    if (org && (await getMembership(org.id, userId))) {
      const orgExts = await listOrgExtensions(org.id);
      for (const ext of orgExts) {
        try {
          const manifest = await readLocalManifest(ext.path);
          const tags = manifest.tags?.map((t) => t.toLowerCase()) ?? [];
          if (!tags.includes("workflow")) continue;
          if (manifest.hookCount > 0 || manifest.commandCount < WORKFLOW_MIN_COMMANDS) continue;
          summaries.push({
            id: manifest.slug,
            label: manifest.name ?? manifest.slug,
            description: manifest.description ?? "",
            source: "extension",
            extensionSlug: manifest.slug,
            version: manifest.version,
            origin: "org",
          });
        } catch {
          // Broken org-extension manifest: skip silently.
        }
      }
    }
  }

  // Deployment-global localExtensions (incl. bundled). Same id = first
  // win, so org-scoped above shadow deployment entries.
  try {
    const { loadAppConfig } = await getAppConfigModule();
    const cfg = await loadAppConfig();
    for (const entry of cfg.localExtensions ?? []) {
      if (summaries.some((s) => s.id === entry.slug)) continue;
      try {
        const manifest = await readLocalManifest(entry.path);
        const tags = manifest.tags?.map((t) => t.toLowerCase()) ?? [];
        if (!tags.includes("workflow")) continue;
        if (manifest.hookCount > 0 || manifest.commandCount < WORKFLOW_MIN_COMMANDS) continue;
        summaries.push({
          id: manifest.slug,
          label: manifest.name ?? manifest.slug,
          description: manifest.description ?? "",
          source: "extension",
          extensionSlug: manifest.slug,
          version: manifest.version,
          origin: "deployment",
        });
      } catch {
        // Broken manifest — skip rather than 500 the picker.
      }
    }
  } catch {
    // Config load failed — carry on with community catalog.
  }

  const seenIds = new Set(summaries.map((s) => s.id));

  try {
    const catalog = await getExtensionCatalog();
    for (const ext of catalog) {
      if (seenIds.has(ext.id)) continue; // local copy takes precedence
      const tags = Array.isArray(ext.tags) ? ext.tags.map((t) => String(t).toLowerCase()) : [];
      if (!tags.includes("workflow")) continue;
      const hooksCount = ext.provides?.hooks ?? 0;
      const commandsCount = ext.provides?.commands ?? 0;
      if (hooksCount > 0 || commandsCount < 3) continue;
      summaries.push({
        id: ext.id,
        label: ext.name,
        description: ext.description ?? "",
        source: "extension",
        extensionSlug: ext.id,
        version: ext.version,
        origin: "community",
      });
    }
  } catch {
    // Community catalog unavailable — never 500 the picker.
  }

  return summaries;
});
