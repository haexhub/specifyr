/**
 * Routes specifyr CapabilityApprovalService notifications through the connected
 * ACP client's session/request_permission. One transport instance per
 * connection.
 *
 * Bindings map slug -> ACP sessionId so concurrent sessions for different
 * slugs route to the right permission UI. When no session is bound for the
 * caller's slug we return undefined — the CAS-side wiring treats that as
 * "this transport has no opinion" and falls through to the timeout / other
 * transports, instead of denying every request just because one transport is
 * unbound.
 */
export class AcpApprovalTransport {
  constructor({ client }) {
    this.client = client;
    /** @type {Map<string, string>} slug -> sessionId */
    this.bindings = new Map();
  }

  bindSession({ slug }, sessionId) {
    this.bindings.set(slug, sessionId);
  }

  unbind(slug) {
    this.bindings.delete(slug);
  }

  /**
   * Called by CapabilityApprovalService. Resolves to "approved" or "denied"
   * if a session is bound and the SDK answers; resolves to undefined when no
   * session is bound (CAS treats undefined as "no opinion").
   */
  async notify({ slug, capability, requestPayload }) {
    const sessionId = this.bindings.get(slug);
    if (!sessionId) return undefined;
    const toolCall = requestPayload?.toolCall ?? {
      title: capability,
      toolCallId: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    };
    const result = await this.client.requestPermission({
      sessionId,
      toolCall,
      options: [
        { optionId: "allow_once", name: `Allow ${capability} once`, kind: "allow_once" },
        { optionId: "allow_always", name: `Allow ${capability} always`, kind: "allow_always" },
        { optionId: "reject_once", name: "Deny", kind: "reject_once" },
        { optionId: "reject_always", name: "Deny always", kind: "reject_always" }
      ]
    });
    if (result.outcome?.outcome === "selected" && result.outcome.optionId.startsWith("allow")) {
      return "approved";
    }
    return "denied";
  }
}
