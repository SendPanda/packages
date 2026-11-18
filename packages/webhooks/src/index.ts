import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookHeaders =
  Headers | Readonly<Record<string, string | string[] | undefined>>;
export type WebhookEvent = {
  id: string;
  type: string;
  email_id: string;
  created_at: string;
  metadata: Record<string, string>;
  data: Record<string, unknown>;
};
export type WebhookVerificationOptions = {
  /** Allowed clock skew in seconds, from 0 to 3600. Default: 300. */
  tolerance?: number;
  /** Unix seconds; defaults to the current time. Useful for deterministic tests. */
  now?: number;
};
export class WebhookVerificationError extends Error {
  constructor(
    public code:
      | "invalid_headers"
      | "expired_timestamp"
      | "invalid_signature"
      | "invalid_payload",
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function")
    return (headers as Headers).get(name) ?? undefined;
  const matches = Object.entries(headers).filter(
    ([key]) => key.toLowerCase() === name,
  );
  if (matches.length !== 1 || typeof matches[0]![1] !== "string")
    return undefined;
  return matches[0]![1];
}

/** Authenticate the raw UTF-8 request body before parsing or processing it. */
export function verifyWebhook(
  payload: string | Uint8Array,
  headers: WebhookHeaders,
  secret: string | readonly string[],
  options: WebhookVerificationOptions = {},
): WebhookEvent {
  const secrets = typeof secret === "string" ? [secret] : secret;
  if (
    !Array.isArray(secrets) ||
    !secrets.length ||
    secrets.some((s) => typeof s !== "string" || !s.length)
  )
    throw new TypeError("At least one webhook signing secret is required");
  const tolerance = options.tolerance ?? 300,
    now = options.now ?? Date.now() / 1000;
  if (
    !Number.isInteger(tolerance) ||
    tolerance < 0 ||
    tolerance > 3600 ||
    !Number.isFinite(now) ||
    now < 0
  )
    throw new TypeError(
      "Webhook tolerance must be 0–3600 seconds and now must be finite Unix seconds",
    );
  if (typeof payload !== "string" && !(payload instanceof Uint8Array))
    throw new TypeError(
      "Webhook payload must be the raw string or bytes, before JSON parsing",
    );
  const id = header(headers, "webhook-id"),
    timestamp = header(headers, "webhook-timestamp"),
    signatures = header(headers, "webhook-signature");
  if (
    !id ||
    !/^evt_[A-Za-z0-9_-]{1,196}$/.test(id) ||
    !timestamp ||
    !/^(0|[1-9][0-9]{0,15})$/.test(timestamp) ||
    !signatures ||
    signatures.length > 4096
  )
    throw new WebhookVerificationError(
      "invalid_headers",
      "Webhook authentication headers are missing or malformed",
    );
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now - seconds) > tolerance)
    throw new WebhookVerificationError(
      "expired_timestamp",
      "Webhook timestamp is outside the allowed clock skew",
    );
  const candidates = signatures
    .split(/\s+/)
    .filter((s) => /^v1=[a-f0-9]{64}$/i.test(s))
    .map((s) => Buffer.from(s.slice(3), "hex"));
  const authenticated = secrets.some((key) => {
    const expected = createHmac("sha256", key)
      .update(`${timestamp}.${id}.`)
      .update(payload)
      .digest();
    return candidates.some((value) => timingSafeEqual(expected, value));
  });
  if (!authenticated)
    throw new WebhookVerificationError(
      "invalid_signature",
      "Webhook signature does not match the raw body",
    );
  let event: unknown;
  try {
    event = JSON.parse(
      typeof payload === "string"
        ? payload
        : Buffer.from(payload).toString("utf8"),
    );
  } catch {
    throw new WebhookVerificationError(
      "invalid_payload",
      "Authenticated webhook body is not valid JSON",
    );
  }
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  if (
    !object(event) ||
    event.id !== id ||
    typeof event.type !== "string" ||
    !event.type.startsWith("email.") ||
    typeof event.email_id !== "string" ||
    !event.email_id.startsWith("em_") ||
    typeof event.created_at !== "string" ||
    !Number.isFinite(Date.parse(event.created_at)) ||
    !object(event.metadata) ||
    Object.values(event.metadata).some((v) => typeof v !== "string") ||
    !object(event.data)
  )
    throw new WebhookVerificationError(
      "invalid_payload",
      "Authenticated webhook body does not match the SendPanda event format",
    );
  return event as WebhookEvent;
}
