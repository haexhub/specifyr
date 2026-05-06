/**
 * Factory for the specifyr ACP server-side agent.
 *
 * For Task 3.1 only `initialize` and `authenticate` are wired. Subsequent
 * tasks fill in `newSession` / `loadSession` / `prompt` / `cancel`.
 */
export function createSpecifyrAcpAgent(/* { client, projectRoot, turnBroker, approvalService } */) {
  return {
    async initialize() {
      return {
        protocolVersion: 1,
        agentInfo: { name: "specifyr", version: "0.1.0" },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true, image: false, audio: false },
          mcpCapabilities: { http: false, sse: false }
        },
        authMethods: []
      };
    },
    async authenticate() { return null; },
    async newSession() { throw new Error("session/new not implemented"); },
    async loadSession() { throw new Error("session/load not implemented"); },
    async prompt() { throw new Error("session/prompt not implemented"); },
    async cancel() {}
  };
}
