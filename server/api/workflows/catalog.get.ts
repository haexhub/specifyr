import { getExtensionCatalog } from "../../utils/extension-catalog";
import { SPEC_KIT_WORKFLOW } from "../../utils/workflow-discovery";

// Entries suitable for a pre-project workflow picker: spec-kit plus any catalog extension
// that self-declares the `workflow` tag. Step lists are intentionally not populated —
// they are only known after the extension is installed (extension.yml on disk).
interface CatalogWorkflowSummary {
  id: string;
  label: string;
  description: string;
  source: "built-in" | "extension";
  extensionSlug?: string;
  version?: string;
}

export default defineEventHandler(async () => {
  const summaries: CatalogWorkflowSummary[] = [
    {
      id: SPEC_KIT_WORKFLOW.id,
      label: SPEC_KIT_WORKFLOW.label,
      description: SPEC_KIT_WORKFLOW.description,
      source: SPEC_KIT_WORKFLOW.source
    }
  ];

  try {
    const catalog = await getExtensionCatalog();
    for (const ext of catalog) {
      // Same heuristic as parseExtensionWorkflow in workflow-discovery.ts: workflow tag
      // AND zero hooks AND >= 3 commands. See that file for the rationale.
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
        version: ext.version
      });
    }
  } catch {
    // If the catalog is unavailable, fall back to just spec-kit — never 500 the picker.
  }

  return summaries;
});
