/**
 * Bridge between ACP `session/request_permission` and specifyr's
 * CapabilityApprovalService.
 *
 * - acpPermissionToCapability: maps an ACP toolCall.title (e.g. "Edit") to a
 *   specifyr capability slug (e.g. "filesystem:write"). Unknown titles fall
 *   back to `tool:<lower>` so they're still gated, just under a generic name.
 * - capabilityDecisionToAcpOutcome: maps the approval decision string back
 *   into the ACP outcome shape, picking a sensible optionId from the offered
 *   options list.
 */

const TITLE_TO_CAP = {
  Edit: "filesystem:write",
  Write: "filesystem:write",
  MultiEdit: "filesystem:write",
  Read: "filesystem:read",
  Glob: "filesystem:read",
  Grep: "filesystem:read",
  Bash: "shell:execute",
  WebFetch: "network:http",
  WebSearch: "network:http"
};

export function acpPermissionToCapability({ title } = {}) {
  return TITLE_TO_CAP[title] ?? `tool:${String(title ?? "unknown").toLowerCase()}`;
}

export function capabilityDecisionToAcpOutcome(decision, options) {
  const want = decision === "approved" ? "allow_once" : "reject_once";
  const match = options.find((o) => o.optionId === want) ?? options[0];
  return { outcome: "selected", optionId: match.optionId };
}
