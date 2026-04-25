export function extractSection(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`, "m");
  const match = markdown.match(regex);
  return match ? match[1].trim() : "";
}

export function parseBullets(sectionText) {
  return sectionText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

export function extractJsonBlock(markdown) {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  if (!match) {
    return null;
  }
  return JSON.parse(match[1]);
}

export function createSpecTemplate(title, slug, problemStatement = "") {
  return `# ${title}

Slug: ${slug}

## Problem
${problemStatement || "Describe the problem this initiative solves."}

## Goals
- Deliver a transparent, spec-driven workflow

## Constraints
- Keep all artifacts repo-native
- Require explicit approvals before execution

## Acceptance Criteria
- A spec can be refined into a plan
- A plan can be turned into executable tasks
- Runs are visible through a timeline and artifact views
`;
}

export function createPlanMarkdown(spec, planData) {
  const phaseLines = planData.phases.map((phase) => `- ${phase.name}: ${phase.objective}`).join("\n");
  const riskLines = planData.risks.map((risk) => `- ${risk}`).join("\n");
  const verifyLines = planData.verification.map((item) => `- ${item}`).join("\n");

  return `# Execution Plan: ${spec.title}

## Summary
${planData.summary}

## Phases
${phaseLines}

## Risks
${riskLines}

## Verification
${verifyLines}

\`\`\`json
${JSON.stringify(planData, null, 2)}
\`\`\`
`;
}

export function createTasksMarkdown(spec, tasksData) {
  const items = tasksData.tasks
    .map((task) => `- ${task.id}: ${task.title} [deps: ${task.dependencies.join(", ") || "none"}]`)
    .join("\n");

  return `# Work Items: ${spec.title}

## Summary
${tasksData.summary}

## Tasks
${items}

\`\`\`json
${JSON.stringify(tasksData, null, 2)}
\`\`\`
`;
}
