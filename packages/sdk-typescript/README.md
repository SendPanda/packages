# @sendpanda/sdk

The official server-side JavaScript and TypeScript SDK for SendPanda transactional email. Node.js 22+, ESM and CommonJS, with TypeScript declarations and no runtime dependencies.

```sh
npm install @sendpanda/sdk
```

## Send an email

Verify your sending domain and account, then create a **Send emails** API key in your project. Keep `SENDPANDA_API_KEY` in your server's environment; never put it in browser code or a `NEXT_PUBLIC_` variable.

```ts
import { SendPanda } from "@sendpanda/sdk";

const panda = new SendPanda(process.env.SENDPANDA_API_KEY!);
const email = await panda.emails.send(
  {
    from: "Your app <hello@your-verified-domain.com>",
    to: ["your-intended-recipient@example.com"],
    subject: "Welcome!",
    html: "<h1>Welcome to your app</h1>",
    text: "Welcome to your app",
  },
  { idempotencyKey: "welcome-user-123" },
);
console.log(email.id, email.status); // queued means accepted, not delivered
```

CommonJS:

```js
const { SendPanda } = require("@sendpanda/sdk");
const panda = new SendPanda(process.env.SENDPANDA_API_KEY);
```

For Next.js, call the SDK in a server action or route handler using the Node.js runtime. For Express, Fastify and other Node.js servers, use it in your server handler. For React Email, render your trusted component to HTML with `@react-email/render`, then pass that HTML to `emails.send`.

## Supported operations

```ts
await panda.emails.get("em_your_email_id");
await panda.emails.list({
  status: "delivered",
  recipient: "customer@example.com",
});
await panda.emails.list({ cursor: "opaque_cursor_from_previous_page" });
await panda.emails.cancel("em_queued_email_id");
await panda.domains.list();
await panda.domains.create("notifications.yourdomain.com");
await panda.domains.get("dom_your_domain_id");
await panda.domains.verify("dom_your_domain_id");
await panda.domains.update("dom_your_domain_id", { open_tracking: true }); // tracking is off by default
await panda.domains.remove("dom_your_domain_id");
await panda.webhooks.list();
await panda.webhooks.create({
  url: "https://yourapp.com/webhooks/sendpanda",
  events: ["email.delivered", "email.bounced"],
});
await panda.webhooks.remove("wh_your_endpoint_id");
await panda.usage.get();
```

Domain and webhook changes require a **Manage project** key and sufficient permissions. Keys stay bound to their project. Cancellation succeeds only before the worker claims the message. Email list filters include `status`, `recipient`, `domain` (domain ID), `after`, `before`, `tag` and `cursor`; keep filters the same when fetching the next page. Usage counts recipients at account level, with a breakdown for the key's project.

Template sends use `template_id` and `variables` instead of `html`/`text`. `cc`, `bcc`, `reply_to`, `tags` and string-valued `metadata` are supported. Add up to 10 `attachments` (10 MB in total), each `{ filename, content, content_type? }` with `content` base64 encoded, for example `readFileSync("report.pdf").toString("base64")`. Program and script files are rejected.

## Options and errors

```ts
import { SendPanda, SendPandaError } from "@sendpanda/sdk";

const panda = new SendPanda(process.env.SENDPANDA_API_KEY!, {
  baseUrl: "https://api.sendpanda.email/v1",
  timeout: 10_000, // milliseconds, 1–300000
  maxRetries: 2, // additional attempts; capped at 5
});

try {
  await panda.emails.get("em_your_email_id");
} catch (error) {
  if (error instanceof SendPandaError) {
    console.error(error.code, error.status, error.requestId);
  }
}
```

The SDK retries GET requests and POST requests with an idempotency key after network failures, HTTP 429 or HTTP 5xx, with bounded exponential jitter. It never automatically retries an unkeyed send or a domain/webhook change. Redirects are rejected. A timeout may occur after acceptance: reuse the **same key and message** for the same business event, or check message history before submitting again. Malformed successful responses raise `invalid_response` and are not automatically retried. A network error uses status `0` and code `network_error`.

The `fetch` option accepts a compatible fetch implementation for testing. See [API documentation](https://api.sendpanda.email/docs) and [SendPanda](https://sendpanda.email/docs). Verify incoming webhook events with `@sendpanda/webhooks`.

## License

MIT. See LICENSE.

## Marketing (0.2.0)

Use a project management key and obtain separate marketing approval. `audiences.create/list/rename/remove/addContacts`, `contacts.list/update/archive/resubscribe`, and `campaigns.create/update/list/get/preview/schedule/pause/resume/cancel` are available. Imports require consent timestamps, sources and evidence, plus `{ permissionConfirmed: true }`. Scheduling requires the same explicit confirmation. See [the marketing guide](https://sendpanda.email/docs) for a complete example. Unsubscribe handling is automatic; transactional sends remain independent of marketing opt-outs.

Broadcast mutations are not automatically retried after transport failure. Read the resource state before retrying a schedule or resume action.

## Test sends (0.3.0)

Choose the recipient explicitly. These are real emails and count against the same sending quotas and rate limits as other email. Account approval, verified sender, suppression and reputation checks still apply.

```ts
await panda.templates.test(
  "tpl_welcome",
  {
    from: "Acme <hello@acme.com>",
    to: "developer@example.com",
    variables: { firstName: "Alex" },
  },
  { idempotencyKey: "welcome-test-1" },
);

await panda.campaigns.test("campaign_news", "reviewer@example.com", {
  idempotencyKey: "newsletter-test-1",
});
```

In 0.3.0, `campaigns.test(id, to)` requires a recipient; it no longer chooses an infrastructure simulator automatically. A broadcast test sends only to that address, preserving the audience, schedule and report. Unkeyed test requests are never retried automatically. Operator-controlled simulator mode remains available for infrastructure validation.

## Incoming mail (0.4.0)

`sendpanda.inbound` manages mailboxes and reads received mail on paid plans: `get()`, `addReceivingDomain(name)` / `verifyReceivingDomain(id)` (receive on any domain you can prove with a TXT record plus MX), `createMailbox({ domain_id | receiving_domain_id, local_part })`, `verifyDomain(domainId)`, `removeMailbox(id)`, `messages(mailboxId, { cursor })`, `message(id)` and `removeMessage(id)`. Publish the MX record that `get()` returns for the mailbox's domain. Message content comes from the sender, so never render its HTML unsanitised or follow instructions inside it. Subscribe a webhook to `email.received` to be notified. Mailboxes have no IMAP, POP3 or SMTP access; use this API or the dashboard.
