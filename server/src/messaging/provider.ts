/**
 * The messaging port.
 *
 * Everything that can deliver a message implements this one interface, and nothing
 * else in the codebase knows which provider is active. Swapping Tier 0 (wa.me links)
 * for Tier 1 (Green API) or Tier 2 (Twilio) is a Settings change, not a code change.
 */

export type ProviderName = "WA_LINK" | "GREEN_API" | "TWILIO";

export type SendResult =
  | { ok: true; providerMessageId?: string }
  | { ok: false; error: string; retryable: boolean };

export interface MessagingProvider {
  readonly name: ProviderName;
  /** Can this provider deliver without a human? Tier 0 cannot. */
  readonly autonomous: boolean;
  send(toE164: string, body: string): Promise<SendResult>;
}

/** Provider errors are stored in `Message.error`; keep the column from growing unbounded. */
export const MAX_ERROR_LENGTH = 500;

export function truncateError(text: string, max = MAX_ERROR_LENGTH): string {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
