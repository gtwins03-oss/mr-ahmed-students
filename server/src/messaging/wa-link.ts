import type { MessagingProvider, SendResult } from "./provider";

/**
 * Tier 0 — wa.me click-to-chat. The default provider: free, no credentials, no ban risk.
 *
 * It cannot send by itself. Messages stay PENDING until the teacher taps «فتح واتساب»
 * in the Send Queue (which opens the link built by `toWaLink`) and then confirms with
 * POST /api/messages/:id/mark-sent. `autonomous: false` is what makes `drainOutbox()`
 * a deliberate no-op on this tier.
 */
export const waLinkProvider: MessagingProvider = {
  name: "WA_LINK",
  autonomous: false,
  async send(): Promise<SendResult> {
    return { ok: false, error: "MANUAL_PROVIDER", retryable: false };
  },
};

export default waLinkProvider;
