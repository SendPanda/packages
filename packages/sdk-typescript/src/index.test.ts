import { describe, it, expect, vi } from "vitest";
import { SendPanda, SendPandaError } from "./index";
const message = {
  from: "hello@example.com",
  to: ["you@example.com"],
  subject: "Hello",
  text: "Hello",
};
describe("SDK safe retries", () => {
  it("uses explicitly chosen test recipients and never retries unkeyed test sends", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"id":"em_template","status":"queued"}'),
      )
      .mockResolvedValueOnce(
        new Response('{"id":"em_campaign","status":"queued"}'),
      )
      .mockRejectedValueOnce(new Error("ambiguous timeout"));
    const sdk = new SendPanda("sp_live_test", { fetch: fake, maxRetries: 2 });
    await sdk.templates.test(
      "tpl/one",
      {
        from: "hello@example.com",
        to: "designer@example.com",
        variables: { name: "Alex" },
      },
      { idempotencyKey: "one-template-test" },
    );
    expect(String(fake.mock.calls[0]?.[0])).toContain(
      "/templates/tpl%2Fone/test",
    );
    expect(JSON.parse(String(fake.mock.calls[0]?.[1]?.body))).toMatchObject({
      to: "designer@example.com",
      variables: { name: "Alex" },
    });
    expect(fake.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "one-template-test",
    });
    await sdk.campaigns.test("campaign/one", "reviewer@example.com", {
      idempotencyKey: "one-broadcast-test",
    });
    expect(JSON.parse(String(fake.mock.calls[1]?.[1]?.body))).toEqual({
      to: "reviewer@example.com",
    });
    await expect(
      sdk.campaigns.test("campaign/one", "reviewer@example.com"),
    ).rejects.toMatchObject({ code: "network_error" });
    expect(fake).toHaveBeenCalledTimes(3);
    expect(() =>
      sdk.campaigns.test("campaign/one", undefined as unknown as string),
    ).toThrow("recipient");
    expect(fake).toHaveBeenCalledTimes(3);
  });
  it("maps consent and scheduling without blindly retrying broadcast mutations", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"created":1,"updated":0,"unsubscribed":0}'),
      )
      .mockRejectedValueOnce(new Error("timeout"));
    const sdk = new SendPanda("sp_live_test", { fetch: fake, maxRetries: 2 });
    await sdk.audiences.addContacts(
      "audience/one",
      [
        {
          email: "opted-in@example.com",
          consent: {
            at: "2026-01-01T00:00:00Z",
            source: "signup",
            evidence: "Product marketing opt-in form",
          },
        },
      ],
      { permissionConfirmed: true },
    );
    expect(String(fake.mock.calls[0]?.[0])).toContain(
      "/audiences/audience%2Fone/contacts",
    );
    expect(
      JSON.parse(String(fake.mock.calls[0]?.[1]?.body)).permission_confirmed,
    ).toBe(true);
    await expect(
      sdk.campaigns.schedule("campaign/one", {
        permissionConfirmed: true,
        scheduledAt: "2026-11-01T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(SendPandaError);
    expect(fake).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fake.mock.calls[1]?.[1]?.body))).toEqual({
      permission_confirmed: true,
      scheduled_at: "2026-11-01T00:00:00Z",
    });
  });
  it("keeps the original payload when the caller mutates its object during a keyed retry", async () => {
    const mutable = { ...message };
    const fake = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        mutable.subject = "Changed later";
        throw new Error("connection lost");
      })
      .mockResolvedValue(new Response('{"id":"em_1","status":"queued"}'));
    await new SendPanda("sp_live_test", { fetch: fake }).emails.send(mutable, {
      idempotencyKey: "same-event",
    });
    expect(JSON.parse(String(fake.mock.calls[1]![1]!.body)).subject).toBe(
      "Hello",
    );
  });
  it("encodes email filters and returns the API's opaque pagination cursor", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"data":[],"next_cursor":"opaque"}'));
    const result = await new SendPanda("sp_live_test", {
      fetch: fake,
    }).emails.list({
      recipient: "customer+tag@example.com",
      cursor: "opaque/value",
      tag: "welcome",
    });
    expect(result.next_cursor).toBe("opaque");
    const url = new URL(String(fake.mock.calls[0]![0]));
    expect(url.searchParams.get("recipient")).toBe("customer+tag@example.com");
    expect(url.searchParams.get("cursor")).toBe("opaque/value");
    expect(fake.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("never claims success or resubmits after an invalid success response", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("invalid-json", { status: 200 }));
    await expect(
      new SendPanda("sp_live_test", { fetch: fake }).emails.send(message),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(fake).toHaveBeenCalledTimes(1);
  });
  it("rejects browser use and invalid timeout/retry configuration", () => {
    expect(() => new SendPanda("sp_live_test", { timeout: 0 })).toThrow();
    expect(() => new SendPanda("sp_live_test", { maxRetries: -1 })).toThrow();
    vi.stubGlobal("window", {});
    try {
      expect(() => new SendPanda("sp_live_test")).toThrow("server");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("sends auth and idempotency headers with configurable URL", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{"id":"em_1","status":"queued"}'));
    const sdk = new SendPanda("sp_live_test", {
      baseUrl: "http://localhost:4000/v1",
      fetch: fake,
    });
    expect(
      await sdk.emails.send(message, { idempotencyKey: "event-1" }),
    ).toEqual({ id: "em_1", status: "queued" });
    expect(fake.mock.calls[0]?.[0]).toBe("http://localhost:4000/v1/emails");
    expect(fake.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Idempotency-Key": "event-1",
      Authorization: "Bearer sp_live_test",
    });
  });
  it("never retries an unkeyed send after network uncertainty", async () => {
    const fake = vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout"));
    const sdk = new SendPanda("sp_live_test", { fetch: fake });
    await expect(sdk.emails.send(message)).rejects.toBeInstanceOf(
      SendPandaError,
    );
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]?.[0]).toBe(
      "https://api.sendpanda.email/v1/emails",
    );
  });
  it("retries a keyed send with the same payload and key", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(new Response('{"id":"em_1","status":"queued"}'));
    const sdk = new SendPanda("sp_live_test", { fetch: fake });
    await sdk.emails.send(message, { idempotencyKey: "same" });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(fake.mock.calls[0]?.[1]?.body).toBe(fake.mock.calls[1]?.[1]?.body);
  });
  it("does not retry validation errors and preserves request IDs", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          '{"error":{"code":"validation_error","message":"Invalid"},"request_id":"req1"}',
          { status: 400 },
        ),
      );
    await expect(
      new SendPanda("sp_live_test", { fetch: fake }).emails.send(message, {
        idempotencyKey: "same",
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "validation_error",
      requestId: "req1",
    });
    expect(fake).toHaveBeenCalledTimes(1);
  });
});

describe("SDK inbound mail", () => {
  it("reads mailboxes and messages and encodes ids", async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"data":[],"next_cursor":null}'))
      .mockResolvedValueOnce(new Response('{"id":"inm_1"}'))
      .mockResolvedValueOnce(new Response('{"deleted":true}'));
    const sdk = new SendPanda("sp_live_test", { fetch: fake });
    await sdk.inbound.messages("mbx/1", { cursor: "a b" });
    await sdk.inbound.message("inm_1");
    await sdk.inbound.removeMessage("inm_1");
    expect(fake.mock.calls.map((c) => [String(c[0]), c[1]?.method])).toEqual([
      [
        expect.stringContaining(
          "/inbound/mailboxes/mbx%2F1/messages?cursor=a%20b",
        ),
        "GET",
      ],
      [expect.stringContaining("/inbound/messages/inm_1"), "GET"],
      [expect.stringContaining("/inbound/messages/inm_1"), "DELETE"],
    ]);
  });
});
