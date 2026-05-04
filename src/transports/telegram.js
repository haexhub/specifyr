/**
 * TelegramTransport — sends approval-request notifications to a Telegram chat
 * via the Bot API's sendMessage endpoint.
 *
 * Why Telegram first: free, HTTP-only API (no GUI dep like signal-cli), works
 * on Linux without a paired phone, solo-dev setup is ~3 minutes:
 *   1. Talk to @BotFather, /newbot, copy the bot token.
 *   2. Send any message to your new bot, then visit
 *      https://api.telegram.org/bot<TOKEN>/getUpdates to find your chat_id.
 *   3. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars before starting
 *      the company.
 *
 * Outbound only in v1: notifications go OUT, but reply-routing (Approve/Deny
 * via tap) requires a webhook or polling — separate inkrement. The user
 * resolves the request via the specifyr UI for now; Telegram is the wake-up
 * channel that tells them a request is waiting.
 *
 * Implementation note on approvalUrlBase: we don't always know the base URL
 * the user will browse from (could be localhost:3000 dev or a remote host).
 * If configured, we embed a deep link to /approvals/<requestId> in the
 * message text so the user can jump straight from notification to decision.
 * Without it, the message is informational only.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";

export class TelegramTransport {
  /**
   * @param {object} opts
   * @param {string} opts.botToken          from @BotFather
   * @param {string} opts.chatId            target chat (your DM with the bot, or a group)
   * @param {string} [opts.approvalUrlBase] e.g. "http://localhost:3000" — embedded as deep link
   * @param {typeof fetch} [opts.fetchFn]   injectable for tests
   */
  constructor({ botToken, chatId, approvalUrlBase, fetchFn = globalThis.fetch } = {}) {
    if (!botToken) throw new Error("TelegramTransport: botToken required");
    if (!chatId) throw new Error("TelegramTransport: chatId required");
    this.botToken = botToken;
    this.chatId = String(chatId);
    this.approvalUrlBase = approvalUrlBase ?? null;
    this.fetchFn = fetchFn;
  }

  /**
   * Send an approval-request notification.
   *
   * @param {object} payload
   * @param {string} payload.requestId
   * @param {string} payload.slug
   * @param {string} payload.agent           role of the worker requesting
   * @param {string} payload.capability      requested capability (e.g. "payment:execute_unrestricted")
   * @param {string} payload.requestedAt     ISO timestamp
   * @param {object} [payload.requestPayload] free-form context
   */
  async notify({ requestId, slug, agent, capability, requestedAt, requestPayload }) {
    const text = this._formatMessage({ requestId, slug, agent, capability, requestedAt, requestPayload });
    const url = `${TELEGRAM_API_BASE}/bot${this.botToken}/sendMessage`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = JSON.stringify(await res.json());
      } catch {
        try { detail = await res.text(); } catch { /* ignore */ }
      }
      throw new Error(`Telegram sendMessage failed: ${res.status} ${detail}`);
    }
  }

  _formatMessage({ requestId, slug, agent, capability, requestedAt, requestPayload }) {
    const lines = [
      `🔐 *Approval Request* — \`${slug}\``,
      `*Agent:* \`${agent}\``,
      `*Capability:* \`${capability}\``,
      `*Requested:* ${requestedAt}`,
      `*Request ID:* \`${requestId}\``,
    ];
    if (requestPayload && typeof requestPayload === "object") {
      const summary = JSON.stringify(requestPayload).slice(0, 240);
      lines.push(`*Payload:* \`${summary}\``);
    }
    if (this.approvalUrlBase) {
      lines.push("");
      lines.push(`👉 ${this.approvalUrlBase.replace(/\/$/, "")}/approvals/${requestId}`);
    }
    return lines.join("\n");
  }
}
