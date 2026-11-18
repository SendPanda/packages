import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
function webhookSignature(key: string, timestamp: number, id: string, payload: string) {
  return createHmac("sha256", key).update(timestamp + "." + id + "." + payload).digest("hex");
}
import { verifyWebhook, WebhookVerificationError } from "./index";
const seconds = 1_800_000_000;
const secret = "whsec-controlled-test-secret";
const event = {
  id: "evt_test",
  type: "email.delivered",
  email_id: "em_test",
  created_at: "2026-10-13T00:00:00.000Z",
  metadata: { order_id: "42" },
  data: { recipients: ["controlled@example.test"], message: "Hello 🐼" },
};
const body = JSON.stringify(event);
function headers(
  payload = body,
  key = secret,
  timestamp = seconds,
  id = event.id,
) {
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": `v1=${webhookSignature(key, timestamp, id, payload)}`,
  };
}
describe("public webhook signature protocol", () => {
  it("verifies raw strings and UTF-8 bytes signed with the documented HMAC protocol", () => {
    expect(verifyWebhook(body, headers(), secret, { now: seconds })).toEqual(
      event,
    );
    expect(
      verifyWebhook(
        new TextEncoder().encode(body),
        new Headers(headers()),
        secret,
        { now: seconds },
      ),
    ).toEqual(event);
  });
  it("accepts either rotation signature and an explicitly configured previous secret", () => {
    const old = headers(body, "old-secret")["webhook-signature"];
    const signed = {
      ...headers(),
      "webhook-signature": `${old} ${headers()["webhook-signature"]}`,
    };
    expect(verifyWebhook(body, signed, "old-secret", { now: seconds })).toEqual(
      event,
    );
    expect(verifyWebhook(body, signed, secret, { now: seconds })).toEqual(
      event,
    );
    expect(
      verifyWebhook(body, headers(body, "old-secret"), [secret, "old-secret"], {
        now: seconds,
      }),
    ).toEqual(event);
  });
  it("accepts case-insensitive header names", () => {
    expect(
      verifyWebhook(
        body,
        Object.fromEntries(
          Object.entries(headers()).map(([k, v]) => [k.toUpperCase(), v]),
        ),
        secret,
        { now: seconds },
      ),
    ).toEqual(event);
  });
  it.each([-301, 301])(
    "rejects a timestamp %s seconds outside the window",
    (offset) => {
      expect(() =>
        verifyWebhook(body, headers(body, secret, seconds + offset), secret, {
          now: seconds,
        }),
      ).toThrow(WebhookVerificationError);
    },
  );
  it("honors the timestamp boundary and custom skew", () => {
    expect(
      verifyWebhook(body, headers(body, secret, seconds - 300), secret, {
        now: seconds,
      }),
    ).toEqual(event);
    expect(() =>
      verifyWebhook(body, headers(body, secret, seconds - 61), secret, {
        now: seconds,
        tolerance: 60,
      }),
    ).toThrow();
  });
  it.each(["", "1.8e9", "1800000000.0", " 1800000000", "01800000000", "NaN"])(
    "rejects malformed timestamp %s",
    (timestamp) => {
      expect(() =>
        verifyWebhook(
          body,
          { ...headers(), "webhook-timestamp": timestamp },
          secret,
          { now: seconds },
        ),
      ).toThrow();
    },
  );
  it("rejects missing/ambiguous headers and malformed signatures", () => {
    expect(() => verifyWebhook(body, {}, secret, { now: seconds })).toThrow();
    expect(() =>
      verifyWebhook(body, { ...headers(), "Webhook-Id": event.id }, secret, {
        now: seconds,
      }),
    ).toThrow();
    expect(() =>
      verifyWebhook(
        body,
        { ...headers(), "webhook-id": [event.id, event.id] },
        secret,
        { now: seconds },
      ),
    ).toThrow();
    expect(() =>
      verifyWebhook(
        body,
        { ...headers(), "webhook-signature": "v1=00" },
        secret,
        { now: seconds },
      ),
    ).toThrow();
  });
  it("rejects changed raw bodies, wrong secrets and a changed event ID", () => {
    expect(() =>
      verifyWebhook(body + " ", headers(), secret, { now: seconds }),
    ).toThrow();
    expect(() =>
      verifyWebhook(body, headers(), "wrong-secret", { now: seconds }),
    ).toThrow();
    expect(() =>
      verifyWebhook(body, headers(body, secret, seconds, "evt_other"), secret, {
        now: seconds,
      }),
    ).toThrow();
  });
  it("rejects authenticated non-JSON and invalid envelopes after signature verification", () => {
    const invalid = [
      "not-json",
      JSON.stringify({ ...event, metadata: { id: 42 } }),
      JSON.stringify({ ...event, id: "evt_other" }),
      JSON.stringify({ ...event, email_id: "not-an-email" }),
    ];
    for (const payload of invalid)
      expect(() =>
        verifyWebhook(payload, headers(payload), secret, { now: seconds }),
      ).toThrow();
  });
  it("rejects parsed input and unsafe verification configuration", () => {
    expect(() =>
      verifyWebhook(event as never, headers(), secret, { now: seconds }),
    ).toThrow(TypeError);
    expect(() => verifyWebhook(body, headers(), "", { now: seconds })).toThrow(
      TypeError,
    );
    expect(() =>
      verifyWebhook(body, headers(), secret, {
        now: seconds,
        tolerance: Infinity,
      }),
    ).toThrow(TypeError);
  });
});
