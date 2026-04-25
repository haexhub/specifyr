/**
 * Hermes path conventions used by the speckit-company runtime.
 *
 * Per-agent isolation: each agent role has its own Hermes "profile" directory
 * holding config, memory, sessions, skills, etc. By setting `HERMES_HOME` to
 * this directory at spawn time, each agent's Hermes process operates as a
 * fully isolated profile (verified against Nous Research's profile mechanism
 * in `_apply_profile_override()`).
 *
 *   <projectRoot>/.hermes/<role>/
 */

import path from "node:path";

const SAFE_ROLE = /^[a-z0-9][a-z0-9-_]*$/;

/**
 * Compute the per-agent Hermes profile directory.
 * @param {object} input
 * @param {string} input.projectRoot
 * @param {string} input.role
 * @returns {string}
 */
export function hermesHomeForAgent({ projectRoot, role }) {
  if (!projectRoot) throw new Error("hermesHomeForAgent: projectRoot required");
  if (!role || !SAFE_ROLE.test(role)) {
    throw new Error(`hermesHomeForAgent: invalid role '${role}'`);
  }
  return path.join(projectRoot, ".hermes", role);
}
