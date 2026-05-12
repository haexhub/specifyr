import type { StepId } from "./steps";

/**
 * Known extension-registered hooks.
 *
 * This is a manually-curated registry for popular extensions that register
 * hooks in the spec-kit workflow. Ideally we'd scrape each extension's detail
 * page to learn the hooks dynamically — that's a future enhancement.
 *
 * Each entry describes a hook that fires **before** a step, i.e. an extra
 * command the user should run first. The step workspace renders these as an
 * info banner at the top so the user sees the gate clearly.
 */

export interface HookGate {
  extensionSlug: string;
  beforeStep: StepId;
  requiredCommand: string;
  label: string;
  description: string;
  docsUrl: string;
}

export const HOOK_GATES: HookGate[] = [
  {
    extensionSlug: "red-team",
    beforeStep: "plan",
    requiredCommand: "/speckit.red-team.run",
    label: "Red Team Review",
    description:
      "Die red-team Extension registriert einen before_plan-Hook. Führe vor /speckit.plan eine adversariale Review mit /speckit.red-team.run aus, um versteckte Sicherheits-/Integrationsrisiken zu finden.",
    docsUrl: "https://speckit-community.github.io/extensions/red-team"
  },
  {
    extensionSlug: "superpowers-bridge",
    beforeStep: "tasks",
    requiredCommand: "/speckit.superpowers.brainstorm",
    label: "Brainstorm & Clarify",
    description:
      "superpowers-bridge empfiehlt vor der Task-Zerlegung noch eine Brainstorming-Runde, um Edge-Cases und Kanten der Spec zu schärfen.",
    docsUrl: "https://speckit-community.github.io/extensions/superpowers-bridge"
  }
];

export function gatesForStep(stepId: StepId, installedSlugs: string[]): HookGate[] {
  const installed = new Set(installedSlugs);
  return HOOK_GATES.filter((g) => g.beforeStep === stepId && installed.has(g.extensionSlug));
}
