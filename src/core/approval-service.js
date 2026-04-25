import { APPROVAL_STAGES } from "./constants.js";

export class ApprovalService {
  request(stage, payload) {
    if (!APPROVAL_STAGES.includes(stage)) {
      throw new Error(`Unknown approval stage '${stage}'.`);
    }
    return {
      stage,
      requestedAt: new Date().toISOString(),
      payload
    };
  }

  approve(run, stage, actor = "human") {
    if (!APPROVAL_STAGES.includes(stage)) {
      throw new Error(`Unknown approval stage '${stage}'.`);
    }
    const approvals = run.approvals.filter((approval) => approval.stage !== stage);
    approvals.push({
      stage,
      approved: true,
      actor,
      approvedAt: new Date().toISOString()
    });
    return {
      ...run,
      approvals
    };
  }

  hasApproval(run, stage) {
    return run.approvals.some((approval) => approval.stage === stage && approval.approved);
  }
}
