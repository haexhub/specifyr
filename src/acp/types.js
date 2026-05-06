/**
 * Thin JSDoc typedefs for the ACP shapes specifyr touches most.
 * The SDK provides zod schemas; this file is just for editor hover-help
 * and to keep our own helpers honest. Do not duplicate validation here.
 *
 * @typedef {object} AcpSessionId
 * @property {string} slug
 * @property {string} stepId
 * @property {string} sid
 *
 * @typedef {{ type: "text", text: string }
 *   | { type: "image", data: string, mimeType: string }
 *   | { type: "resource_link", uri: string, name: string }} AcpContentBlock
 *
 * @typedef {object} AcpToolCall
 * @property {string} toolCallId
 * @property {string} title
 * @property {"pending"|"in_progress"|"completed"|"failed"} status
 * @property {AcpContentBlock[]} [content]
 * @property {string} [kind]
 * @property {unknown} [rawInput]
 * @property {unknown} [rawOutput]
 * @property {Array<{path: string, line?: number}>} [locations]
 *
 * @typedef {"end_turn"|"max_tokens"|"refusal"|"cancelled"|"max_turn_requests"} AcpStopReason
 */
export {};
