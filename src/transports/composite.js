/**
 * CompositeTransport — routes notify() calls to the right underlying transport
 * based on the `channel` name.
 *
 * Why this layer: CapabilityApprovalService passes `{ channel, payload }` and
 * each agent declares `notify_via: ["telegram", "signal"]` in its spec. The
 * service shouldn't know about specific transports; the composite hides that.
 *
 * Adding a new channel is two steps:
 *   1. Create `src/transports/<channel>.js` with a class exposing `notify(payload)`.
 *   2. Construct it in start.post.ts and add to the CompositeTransport map.
 *
 * Errors propagate to the caller (CapabilityApprovalService catches them and
 * emits 'transport-error') — we don't swallow here, so misconfiguration
 * doesn't hide.
 */

export class CompositeTransport {
  /**
   * @param {Record<string, { notify: (payload: object) => Promise<void> }>} transports
   *   Map of channel-name → transport instance. e.g. { telegram: <TelegramTransport> }
   */
  constructor(transports = {}) {
    this.transports = transports;
  }

  async notify({ channel, payload }) {
    const t = this.transports[channel];
    if (!t) {
      throw new Error(
        `CompositeTransport: no transport configured for channel '${channel}' ` +
          `(known: ${Object.keys(this.transports).join(", ") || "none"})`,
      );
    }
    return t.notify(payload);
  }
}
