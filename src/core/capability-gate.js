/**
 * Capability gate — enforces the per-agent permission layer described by
 * speckit-company. Default-deny: anything not explicitly granted is forbidden.
 *
 * Capabilities are strings of shape `<class>:<subclass>` (e.g. `filesystem:write`,
 * `payment:execute_unrestricted`). `<class>:any` is a wildcard that grants any
 * subclass in that class.
 *
 * Some grants are *sensitive*: they require user-approval at every use,
 * regardless of task autonomy. The runtime is expected to invoke the
 * ApprovalService whenever `requiresApproval=true` is returned.
 */

export const SENSITIVE_CAPABILITIES = new Set([
  "payment:execute_unrestricted",
  "secrets:read_vault",
  "network:any",
  // account:* is sensitive — handled by class-level check below
]);

const SENSITIVE_CLASSES = new Set(["account"]);

/**
 * @param {object} input
 * @param {{role: string, capabilities: string[]}} input.agent
 * @param {string} input.request - capability the agent wants to use
 * @param {"full"|"supervised"|"interactive"} [input.taskAutonomy]
 * @returns {{allowed: boolean, reason: string, requiresApproval: boolean}}
 */
export function checkCapability({ agent, request, taskAutonomy }) {
  const granted = agent?.capabilities ?? [];

  const grant = findGrant(granted, request);
  if (!grant) {
    return {
      allowed: false,
      reason: `capability '${request}' is not granted to agent '${agent?.role ?? "?"}'`,
      requiresApproval: false,
    };
  }

  // Sensitivity is checked at BOTH the grant and the request level — a sensitive
  // grant (e.g. `network:any`) makes every concrete use approval-gated, and a
  // sensitive request (e.g. `payment:execute_unrestricted`) is approval-gated
  // even if the grant looks innocuous.
  if (isSensitive(grant) || isSensitive(request)) {
    return {
      allowed: true,
      reason: `capability '${request}' allowed by grant '${grant}' but sensitive — user approval required at every use`,
      requiresApproval: true,
    };
  }

  return {
    allowed: true,
    reason: `capability '${request}' allowed by grant '${grant}'`,
    requiresApproval: false,
  };
}

function findGrant(grantedList, request) {
  for (const grant of grantedList) {
    if (grant === request) return grant;
    const grantClass = capabilityClass(grant);
    const requestClass = capabilityClass(request);
    if (grantClass === requestClass && capabilitySub(grant) === "any") return grant;
  }
  return null;
}

function isSensitive(cap) {
  if (SENSITIVE_CAPABILITIES.has(cap)) return true;
  const cls = capabilityClass(cap);
  if (SENSITIVE_CLASSES.has(cls)) return true;
  return false;
}

function capabilityClass(cap) {
  const idx = cap.indexOf(":");
  return idx >= 0 ? cap.slice(0, idx) : cap;
}

function capabilitySub(cap) {
  const idx = cap.indexOf(":");
  return idx >= 0 ? cap.slice(idx + 1) : "";
}
