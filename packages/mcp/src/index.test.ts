import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createApiCaller,
  createSendPandaMcp,
  openWorldTools,
  toolTitles,
} from "./index.js";
describe("MCP transports and safety", () => {
  it("requires explicit recipients and user instructions for real template and broadcast tests", async () => {
    const calls: unknown[] = [];
    const server = createSendPandaMcp(
      async (op) => {
        calls.push(op);
        return { id: "em_test", status: "queued" };
      },
      { scope: "full" },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "chosen-test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      for (const [name, extra] of [
        ["templates_test", { from: "hello@example.com" }],
        ["campaigns_test", {}],
      ] as const) {
        expect(
          (
            await client.callTool({
              name,
              arguments: { id: "resource", confirmed: true, ...extra },
            })
          ).isError,
        ).toBe(true);
        expect(
          (
            await client.callTool({
              name,
              arguments: {
                id: "resource",
                to: "designer@example.com",
                ...extra,
              },
            })
          ).isError,
        ).toBe(true);
        const result = await client.callTool({
          name,
          arguments: {
            id: "resource",
            to: "designer@example.com",
            confirmed: true,
            ...extra,
          },
        });
        expect(result.isError).not.toBe(true);
      }
      expect(calls).toHaveLength(2);
      expect(calls).toEqual([
        expect.objectContaining({
          path: "/v1/templates/resource/test",
          body: { from: "hello@example.com", to: "designer@example.com" },
        }),
        expect.objectContaining({
          path: "/v1/campaigns/resource/test",
          body: { to: "designer@example.com" },
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("preserves editable designs through the public MCP contract", async () => {

    const calls: { path: string; body?: unknown }[] = [];
    const server = createSendPandaMcp(
      async (op) => {
        calls.push(op);
        return { id: "tpl_draft", version: 2 };
      },
      { scope: "full" },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "editor", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const design = {
        version: 1, preheader: "Public example",
        theme: { background: "#ffffff", surface: "#ffffff", text: "#111111", accent: "#6655ee", font: "Arial", width: 600, radius: 8 },
        blocks: [{ id: "heading", type: "heading", text: "Hello" }],
      };
      const tools = (await client.listTools()).tools;
      expect(
        JSON.stringify(
          tools.find((t) => t.name === "templates_create")?.inputSchema,
        ),
      ).toContain('"columns"');
      for (const [name, extra] of [
        ["templates_create", {}],
        ["templates_create_version", { id: "tpl_draft" }],
        [
          "campaigns_update",
          {
            id: "campaign_draft",
            audience_id: "audience_optin",
            from: "hello@example.com",
            postal_address: "1 Example Street, London, United Kingdom",
          },
        ],
      ] as const) {
        const result = await client.callTool({
          name,
          arguments: {
            name: "Summer",
            subject: "Hi {{name}}",
            design,
            confirmed: true,
            ...extra,
          },
        });
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
        expect(calls.at(-1)?.body).toMatchObject({ design });
        expect(calls.at(-1)?.body).not.toHaveProperty("html");
        expect(calls.at(-1)?.body).not.toHaveProperty("confirmed");
      }
      const count = calls.length;
      expect(
        (
          await client.callTool({
            name: "templates_create",
            arguments: {
              name: "Unsafe",
              subject: "Hi",
              design: { ...design, theme: { ...design.theme, width: 1 } },
              confirmed: true,
            },
          })
        ).isError,
      ).toBe(true);
      expect(calls).toHaveLength(count);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("returns sandboxed visual resources and retrieves snapshots without offering them to sending keys", async () => {
    const previewId = "preview_" + "a".repeat(32);
    const result = {
      subject: "Untrusted <script>",
      html: "<script>alert(1)</script><p>Hello Alex</p>",
      preview_id: previewId,
      preview_url: `https://sendpanda.email/preview/${previewId}?project=prj_example`,
    };
    const server = createSendPandaMcp(async () => result, { scope: "full" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "preview", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const preview = await client.callTool({
        name: "templates_preview",
        arguments: { id: "tpl_draft", variables: { name: "Alex" } },
      });
      expect(preview.content).toHaveLength(3);
      expect(preview.content[1]).toMatchObject({
        type: "resource_link",
        uri: `sendpanda://previews/${previewId}`,
      });
      const content = (
        await client.readResource({ uri: `sendpanda://previews/${previewId}` })
      ).contents[0];
      expect(content).toMatchObject({ mimeType: "text/html" });
      expect(content && "text" in content ? content.text : "").toContain(
        'sandbox=""',
      );
      expect(content && "text" in content ? content.text : "").not.toContain(
        "<script>",
      );
      expect(content && "text" in content ? content.text : "").toContain(
        "script-src 'none'",
      );
    } finally {
      await client.close();
      await server.close();
    }
    const sendServer = createSendPandaMcp(async () => result, {
      scope: "send",
    });
    const [c, d] = InMemoryTransport.createLinkedPair();
    const send = new Client({ name: "sending", version: "1" });
    await sendServer.connect(c);
    await send.connect(d);
    try {
      expect(
        (await send.listTools()).tools.some((t) =>
          t.name.startsWith("email_design"),
        ),
      ).toBe(false);
      expect(
        (await send.listResourceTemplates()).resourceTemplates,
      ).toHaveLength(0);
      await expect(
        send.readResource({ uri: `sendpanda://previews/${previewId}` }),
      ).rejects.toThrow();
    } finally {
      await send.close();
      await sendServer.close();
    }
  });
  it("requires explicit mutation confirmation and never automatically retries API errors", async () => {
    const calls: unknown[] = [];
    const server = createSendPandaMcp(
      async (op) => {
        calls.push(op);
        throw new Error("controlled API failure");
      },
      { scope: "full" },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "acceptance", version: "1" });
    await server.connect(a);
    await client.connect(b);
    try {
      const unconfirmed = await client.callTool({
        name: "emails_send",
        arguments: {
          from: "hello@acme.test",
          to: ["controlled@acme.test"],
          text: "Hello",
        },
      });
      expect(unconfirmed.isError).toBe(true);
      expect(calls).toHaveLength(0);
      const confirmed = await client.callTool({
        name: "emails_send",
        arguments: {
          from: "hello@acme.test",
          to: ["controlled@acme.test"],
          text: "Hello",
          confirmed: true,
          idempotency_key: "controlled-once",
        },
      });
      expect(confirmed.isError).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ idempotencyKey: "controlled-once" });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("rejects unsafe API destinations and forwards no credential through redirects", async () => {
    expect(() =>
      createApiCaller("sp_live_test", "http://external.test"),
    ).toThrow();
    expect(() =>
      createApiCaller("sp_live_test", "https://user:password@api.test"),
    ).toThrow();
    let count = 0;
    const call = createApiCaller(
      "sp_live_test",
      "https://api.test",
      async (_url, init) => {
        count++;
        expect(init?.redirect).toBe("error");
        return new Response(
          JSON.stringify({
            error: { code: "quota_exceeded", message: "Quota exceeded" },
          }),
          { status: 429 },
        );
      },
    );
    await expect(
      call({ method: "POST", path: "/v1/emails", body: {} }),
    ).rejects.toThrow("quota_exceeded");
    expect(count).toBe(1);
    await expect(
      call({ method: "GET", path: "https://external.test" }),
    ).rejects.toThrow();
  });
  it("communicates through the actual stdio CLI without mixing logs with protocol output", async () => {
    const http = createServer((req, res) => {
      expect(req.headers.authorization).toBe("Bearer sp_live_stdio_test");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/v1/project"
            ? { id: "prj_controlled", api_key_scope: "send" }
            : { data: [] },
        ),
      );
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    const port = (http.address() as { port: number }).port;
    const client = new Client({ name: "stdio-acceptance", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", resolve("packages/mcp/src/cli.ts")],
      env: {
        ...process.env,
        SENDPANDA_API_KEY: "sp_live_stdio_test",
        SENDPANDA_API_URL: `http://127.0.0.1:${port}`,
      },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("project_get");
      expect(names).not.toContain("api_keys_create");
      expect(
        (
          (await client.callTool({ name: "project_get", arguments: {} }))
            .structuredContent as { id?: string }
        )?.id,
      ).toBe("prj_controlled");
    } finally {
      await client.close();
      await new Promise<void>((r) => http.close(() => r()));
    }
  });
});

describe("account (access token) mode", () => {
  async function connect(options: Parameters<typeof createSendPandaMcp>[1]) {
    const calls: Array<{
      path: string;
      environmentId?: string;
      body?: unknown;
    }> = [];
    const server = createSendPandaMcp(async (op) => {
      calls.push(op);
      return { ok: true };
    }, options);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "account-test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    return { client, calls };
  }
  it("adds account tools and routes every project tool to the chosen environment", async () => {
    const { client, calls } = await connect({ scope: "full", account: true });
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      "account_get",
      "projects_create",
      "projects_delete",
      "domains_create",
      "templates_create",
      "inbound_get",
      "inbound_domains_create",
      "inbound_domains_verify",
      "inbound_messages_list",
      "inbound_messages_get",
      "api_request",
    ])
      expect(names, name).toContain(name);
    // Project tools need an environment_id.
    expect(
      (await client.callTool({ name: "domains_list", arguments: {} })).isError,
    ).toBe(true);
    await client.callTool({
      name: "domains_list",
      arguments: { environment_id: "prj_123" },
    });
    expect(calls.at(-1)).toMatchObject({
      path: "/v1/domains",
      environmentId: "prj_123",
    });
    // Account tools act on the account, not an environment.
    await client.callTool({
      name: "projects_create",
      arguments: { name: "Shop", organisation_id: "org_1", confirmed: true },
    });
    expect(calls.at(-1)).toMatchObject({
      path: "/api/projects",
      body: { name: "Shop", organisation_id: "org_1" },
    });
    expect(calls.at(-1)?.environmentId).toBeUndefined();
    // Changes through the escape hatch need the user's confirmation.
    expect(
      (
        await client.callTool({
          name: "api_request",
          arguments: { method: "POST", path: "/v1/domains", body: {} },
        })
      ).isError,
    ).toBe(true);
  });
  it("reads incoming mail and asks before deleting it", async () => {
    const { client, calls } = await connect({ scope: "full", account: true });
    await client.callTool({
      name: "inbound_messages_list",
      arguments: { environment_id: "prj_1", id: "mbx_1", cursor: "abc" },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "GET",
      path: "/v1/inbound/mailboxes/mbx_1/messages?cursor=abc",
      environmentId: "prj_1",
    });
    const before = calls.length;
    expect(
      (
        await client.callTool({
          name: "inbound_messages_delete",
          arguments: { environment_id: "prj_1", id: "inm_1" },
        })
      ).isError,
    ).toBe(true);
    expect(calls).toHaveLength(before);
    await client.callTool({
      name: "inbound_messages_delete",
      arguments: { environment_id: "prj_1", id: "inm_1", confirmed: true },
    });
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      path: "/v1/inbound/messages/inm_1",
    });
  });
  it("keeps account tools out of project-bound servers", async () => {
    const { client } = await connect({ scope: "full" });
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("account_get");
    expect(names).not.toContain("projects_delete");
  });
  it("only accepts access tokens and never reaches sign-in, billing or token routes", async () => {
    const { createTokenCaller } = await import("./index.js");
    expect(() => createTokenCaller("sp_live_abc")).toThrow();
    const fetched: string[] = [];
    const call = createTokenCaller(
      "sp_pat_abc",
      "https://api.example.com",
      (async (url: URL) => {
        fetched.push(String(url));
        return new Response(JSON.stringify({ ok: true }));
      }) as unknown as typeof fetch,
    );
    await call({ method: "GET", path: "/api/me" });
    for (const path of ["/api/tokens", "/api/billing/portal", "/api/auth/x"])
      await expect(call({ method: "GET", path })).rejects.toThrow();
    expect(fetched).toEqual(["https://api.example.com/api/me"]);
  });
});

describe("directory listing metadata", () => {
  async function tools(options: Parameters<typeof createSendPandaMcp>[1]) {
    const server = createSendPandaMcp(
      async () => ({ id: "wh_1", signing_secret: "whsec_secret" }),
      options,
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "directory-test", version: "1" });
    await server.connect(a);
    await client.connect(b);
    return { client, list: (await client.listTools()).tools };
  }
  it("gives every tool a title, explicit boolean hints and a useful description", async () => {
    const { list } = await tools({ scope: "full", account: true });
    expect(list.length).toBeGreaterThan(70);
    for (const tool of list) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const)
        expect(typeof tool.annotations?.[hint], `${tool.name} ${hint}`).toBe(
          "boolean",
        );
      if (tool.annotations?.readOnlyHint)
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(tool.description!.length, tool.name).toBeGreaterThanOrEqual(45);
    }
    expect(Object.keys(toolTitles).sort()).toEqual(
      list.map((t) => t.name).sort(),
    );
  });
  it("marks only outbound actions as open-world and stored rechecks as writes", async () => {
    const { list } = await tools({ scope: "full", account: true });
    const hints = Object.fromEntries(list.map((t) => [t.name, t.annotations]));
    expect(
      list
        .filter((t) => t.annotations?.openWorldHint)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...openWorldTools].sort());
    for (const name of [
      "domains_verify",
      "inbound_domains_verify",
      "inbound_domain_verify",
    ])
      expect(hints[name]).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    for (const name of [
      "domains_update",
      "contacts_update",
      "campaigns_update",
      "audiences_rename",
      "project_rename",
      "projects_rename",
    ])
      expect(hints[name]?.destructiveHint, name).toBe(true);
  });
  it("drops internal account identifiers from connected apps' results only", async () => {
    const row = {
      id: "em_1",
      organisation_id: "org_1",
      project_id: "prj_1",
      created_by: "usr_1",
      metadata: { project_id: "customer-value" },
    };
    const connect = async (delegated: boolean) => {
      const server = createSendPandaMcp(
        async () => ({
          data: [row],
          organisation_id: "org_1",
          next_cursor: null,
        }),
        { scope: "full", delegated },
      );
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "trim-test", version: "1" });
      await server.connect(a);
      await client.connect(b);
      return client.callTool({ name: "emails_list", arguments: {} });
    };
    const trimmed = await connect(true);
    expect(trimmed.structuredContent).toEqual({
      data: [{ id: "em_1", metadata: { project_id: "customer-value" } }],
      next_cursor: null,
    });
    expect(JSON.stringify(trimmed.content)).not.toContain("org_1");
    expect((await connect(false)).structuredContent).toMatchObject({
      organisation_id: "org_1",
      data: [row],
    });
  });
  it("keeps webhook signing secrets out of connected apps", async () => {
    const delegated = await tools({ scope: "full", delegated: true });
    const names = delegated.list.map((t) => t.name);
    expect(names).toContain("webhooks_create");
    expect(names).not.toContain("webhooks_rotate_secret");
    const created = await delegated.client.callTool({
      name: "webhooks_create",
      arguments: {
        url: "https://hooks.example.com/sendpanda",
        events: ["email.delivered"],
        confirmed: true,
      },
    });
    expect(JSON.stringify(created)).not.toContain("whsec_secret");
    expect(created.structuredContent).toMatchObject({
      id: "wh_1",
      signing_secret_hidden: true,
    });
    const local = await tools({ scope: "full" });
    const own = await local.client.callTool({
      name: "webhooks_rotate_secret",
      arguments: { id: "wh_1", confirmed: true },
    });
    expect(own.structuredContent).toMatchObject({
      signing_secret: "whsec_secret",
    });
  });
});
