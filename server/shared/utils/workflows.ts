import path from "node:path";
import fs from "node:fs/promises";
import { projectArtifactsDir } from "./data-dirs";
import { SPEC_KIT_WORKFLOW, loadInstalledExtensionWorkflow } from "./workflow-discovery";

// Only spec-kit is a built-in workflow. Every other workflow comes from a project-installed
// extension that declares the "workflow" tag in its extension.yml.
export const DEFAULT_WORKFLOW_ID = "spec-kit";

// Read the workflow id stored in a project's meta.json (no extension-availability check yet).
export async function getProjectWorkflowId(orgId: string, slug: string): Promise<string> {
  const metaPath = path.join(projectArtifactsDir(orgId, slug), "meta.json");
  try {
    const content = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(content) as { workflow?: string };
    if (typeof meta.workflow === "string" && meta.workflow.length > 0) {
      return meta.workflow;
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_WORKFLOW_ID;
}

// Resolve a project's chosen workflow to an ordered list of step ids.
// spec-kit → hardcoded; extension id → parsed from the extension's yml.
// Missing / unparsable extension falls back to spec-kit's order for safety.
export async function getProjectStepIds(orgId: string, slug: string): Promise<string[]> {
  const workflowId = await getProjectWorkflowId(orgId, slug);
  if (workflowId === DEFAULT_WORKFLOW_ID) {
    return SPEC_KIT_WORKFLOW.steps.map((s) => s.id);
  }
  const wf = await loadInstalledExtensionWorkflow(orgId, slug, workflowId);
  if (wf) return wf.steps.map((s) => s.id);
  return SPEC_KIT_WORKFLOW.steps.map((s) => s.id);
}
