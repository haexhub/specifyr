import type { StepDefinition, StepStatus } from "./steps";

export type WorkflowId = string;

export interface Workflow {
  id: WorkflowId;
  label: string;
  description: string;
  source: "built-in" | "extension";
  // The extension slug that provides this workflow (undefined for built-in).
  extensionSlug?: string;
  steps: StepDefinition[];
}

// Catalog-level summary (no step list — only available after install).
export interface WorkflowSummary {
  id: WorkflowId;
  label: string;
  description: string;
  source: "built-in" | "extension";
  extensionSlug?: string;
  version?: string;
}

// The only client-side baked-in workflow. Every other workflow is discovered from an installed
// extension and returned by the server in the project snapshot's `workflowDefinition`.
export const SPEC_KIT_WORKFLOW: Workflow = {
  id: "spec-kit",
  label: "Spec Kit (Standard)",
  description:
    "Der klassische 5-Step-Flow: Constitution → Specify → Plan → Tasks → Implement. Feature-basierte Entwicklung.",
  source: "built-in",
  steps: [
    {
      id: "constitution",
      label: "Constitution",
      command: "/speckit.constitution",
      summary: "Prinzipien und Leitplanken des Projekts festlegen.",
      description:
        "Definiere die Grundsätze, an denen sich das Projekt durchgängig orientiert — Code-Qualität, Test-Standards, UX-Konsistenz, Performance.",
      tips: [],
      artifacts: [".specify/memory/constitution.md"]
    },
    {
      id: "specify",
      label: "Specify",
      command: "/speckit.specify",
      summary: "Was und warum — Feature-Spec erarbeiten.",
      description: "Beschreibe WAS gebaut werden soll und WARUM.",
      tips: [],
      artifacts: [".specify/specs/<feature>/spec.md"]
    },
    {
      id: "plan",
      label: "Plan",
      command: "/speckit.plan",
      summary: "Wie — Technischen Plan ableiten.",
      description: "Übersetze die Spec in das WIE.",
      tips: [],
      artifacts: [".specify/specs/<feature>/plan.md"]
    },
    {
      id: "tasks",
      label: "Tasks",
      command: "/speckit.tasks",
      summary: "Ausführbare Aufgaben mit Abhängigkeiten.",
      description: "Zerlege den Plan in konkrete Aufgaben mit ID, Dependencies, Akzeptanzkriterien.",
      tips: [],
      artifacts: [".specify/specs/<feature>/tasks.md", ".specops/<slug>/tasks.graph.json"]
    },
    {
      id: "implement",
      label: "Implement",
      command: "/speckit.implement",
      summary: "Tasks via Hermes ausführen.",
      description: "Hermes führt die Tasks aus — unabhängige parallel, abhängige sequenziell.",
      tips: [],
      artifacts: [],
      isRun: true
    }
  ]
};

export const DEFAULT_WORKFLOW_ID: WorkflowId = "spec-kit";

// Resolve any workflow id to a usable definition. Extension workflows flow through the project
// snapshot; this helper is the fallback for when the caller has only an id. Prefer using
// `project.workflowDefinition` directly wherever it's in scope.
export function resolveWorkflow(
  id: WorkflowId | undefined | null,
  fromSnapshot?: Workflow | null
): Workflow {
  if (fromSnapshot && (!id || fromSnapshot.id === id)) return fromSnapshot;
  if (!id || id === DEFAULT_WORKFLOW_ID) return SPEC_KIT_WORKFLOW;
  // Unknown id without snapshot context — degrade to spec-kit instead of 404ing the UI.
  return SPEC_KIT_WORKFLOW;
}

export type { StepStatus };
