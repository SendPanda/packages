# @sendpanda/webhooks

Authenticate SendPanda webhook events on your server. Node.js 22+, ESM and CommonJS, typed events and no runtime dependencies.

```sh
npm install @sendpanda/webhooks
```

## Verify a request

Use the endpoint's webhook signing secret, not your API key. Pass the exact raw request body **before** parsing JSON. Verification throws `WebhookVerificationError` for invalid headers, stale timestamps, incorrect signatures or invalid event envelopes.

Next.js route handler (`app/api/webhooks/sendpanda/route.ts`):

```ts
import { verifyWebhook, WebhookVerificationError } from "@sendpanda/webhooks";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  let event;
  try {
    event = verifyWebhook(
      rawBody,
      request.headers,
      process.env.SENDPANDA_WEBHOOK_SECRET!,
    );
  } catch (error) {
    if (error instanceof WebhookVerificationError)
      return new Response("Invalid webhook", { status: 400 });
    throw error; // invalid server configuration should fail visibly
  }

  // Persist receipt and deduplicate by event.id in your database transaction.
  // Queue your application work before acknowledging successful receipt.
  await persistReceiptAndQueue(event); // implement this in your application
  return new Response(null, { status: 204 });
}
```

For Express, mount `express.raw({ type: "application/json" })` on the webhook route **before** `express.json()`, and pass `request.body` plus `request.headers`. A parsed object or re-serialized JSON is not the original body and will fail verification. The helper accepts a string or `Uint8Array` (including Node.js `Buffer`).

```js
const { verifyWebhook } = require("@sendpanda/webhooks");
```

## Signing protocol and rotation

SendPanda sends `webhook-id`, `webhook-timestamp` (Unix seconds) and `webhook-signature` with space-separated `v1=HEX` values. The helper verifies HMAC-SHA256 over `timestamp.event_id.raw_body` using constant-time comparison. The default timestamp tolerance is 300 seconds in either direction; keep your server clock synchronized.

During signing-secret rotation, deliveries carry both signatures for 24 hours. The helper accepts either valid signature. If your application temporarily retains both secrets:

```ts
const event = verifyWebhook(rawBody, headers, [currentSecret, previousSecret]);
```

An optional fourth argument sets `{ tolerance: 300 }` (0–3600 seconds). `{ now: unixSeconds }` is available for deterministic tests; use the default real clock in production.

The verified event contains `id`, `type`, `email_id`, `created_at`, string-valued `metadata` and event-specific `data`. It is authenticated, but verification does not deduplicate deliveries or make your application side effects idempotent. Deduplicate durably by `event.id`; retries and manual replays can reuse that ID with a fresh delivery timestamp/signature. Acknowledge only after durable receipt. Never log your signing secret or sensitive message content.

See [API documentation](https://api.sendpanda.email/docs) and [SendPanda](https://sendpanda.email/docs). Use `@sendpanda/sdk` to send email and manage webhook endpoints.

## License

MIT. See LICENSE.
