import { describe, it, expect } from "vitest";
import { main } from "./index";

const me = {
  user: { id: "u1", name: "Sam", email: "sam@example.com" },
  organisations: [{ id: "org_1", name: "Acme", role: "owner" }],
  applications: [
    { id: "app_1", name: "Shop", organisation_id: "org_1", role: "owner" },
  ],
  projects: [
    {
      id: "prj_a1",
      name: "Production",
      application_id: "app_1",
      organisation_id: "org_1",
    },
  ],
};
function harness(routes: Record<string, unknown> = {}) {
  const calls: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
  }[] = [];
  let out = "",
    err = "";
  const files: Record<string, string> = {};
  const fetcher = (async (url: URL, init: RequestInit) => {
    const key = `${init.method ?? "GET"} ${url.pathname}`;
    calls.push({
      method: init.method ?? "GET",
      url: url.pathname,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const value = key in routes ? routes[key] : { ok: true };
    return new Response(JSON.stringify(value), {
      status: value && (value as { error?: unknown }).error ? 400 : 200,
    });
  }) as unknown as typeof fetch;
  const run = (
    argv: string[],
    env: Record<string, string> = {},
    open: (url: string) => void = () => {},
  ) =>
    main(argv, {
      fetch: fetcher,
      env: {
        SENDPANDA_TOKEN: "sp_pat_test",
        SENDPANDA_CONFIG_DIR: "/nonexistent-sendpanda",
        ...env,
      },
      open,
      out: (t) => (out += t),
      err: (t) => (err += t),
      readFile: async (p) => {
        if (p in files) return files[p]!;
        throw new Error("ENOENT");
      },
    });
  return { run, calls, files, out: () => out, err: () => err };
}

describe("sendpanda CLI", () => {
  it("updates an existing template without creating or publishing another template", async () => {
    const h = harness({
      "GET /api/me": me,
      "POST /v1/templates/tpl_1/versions": { version: 3 },
    });
    h.files["design.json"] = JSON.stringify({ version: 1, blocks: [] });
    expect(
      await h.run([
        "templates",
        "update",
        "tpl_1",
        "--name",
        "Welcome",
        "--subject",
        "Welcome to our app",
        "--design-file",
        "design.json",
        "--env",
        "Shop",
      ]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/v1/templates/tpl_1/versions",
      body: {
        name: "Welcome",
        subject: "Welcome to our app",
        design: { version: 1, blocks: [] },
      },
    });
    expect(h.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
    expect(JSON.parse(h.out()).version).toBe(3);
  });
  it("previews a specific saved version with sample variables from a file without sending", async () => {
    const h = harness({ "GET /api/me": me });
    h.files["variables.json"] = JSON.stringify({ greeting: "Hello Alex," });
    expect(
      await h.run([
        "templates",
        "preview",
        "tpl_1",
        "--version",
        "3",
        "--variables",
        "@variables.json",
        "--env",
        "Shop",
      ]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/v1/templates/tpl_1/preview",
      body: { version: 3, variables: { greeting: "Hello Alex," } },
    });
    expect(h.calls.filter((c) => c.method !== "GET")).toHaveLength(1);
  });
  it("refuses to run without a token and explains how to get one", async () => {
    const h = harness();
    expect(await h.run(["whoami"], { SENDPANDA_TOKEN: "" })).toBe(2);
    expect(h.err()).toContain("sendpanda login");
    expect(h.calls).toHaveLength(0);
  });
  it("shows accounts and projects with their environment ids", async () => {
    const h = harness({ "GET /api/me": me });
    expect(await h.run(["whoami"])).toBe(0);
    const result = JSON.parse(h.out());
    expect(result.projects[0].environments).toEqual([
      { id: "prj_a1", name: "Production" },
    ]);
    expect(h.calls[0]!.headers.Authorization).toBe("Bearer sp_pat_test");
  });
  it("resolves a project name to its Production environment for resource commands", async () => {
    const h = harness({ "GET /api/me": me });
    await h.run(["domains", "list", "--env", "shop"]);
    const last = h.calls.at(-1)!;
    expect(last.url).toBe("/v1/domains");
    expect(last.headers["X-Environment-Id"]).toBe("prj_a1");
  });
  it("only deletes a project when its exact name is confirmed", async () => {
    const h = harness({ "GET /api/me": me });
    expect(await h.run(["projects", "delete", "Shop"])).toBe(2);
    expect(
      await h.run(["projects", "delete", "Shop", "--confirm", "shop"]),
    ).toBe(2);
    expect(h.calls.some((c) => c.url.endsWith("/purge"))).toBe(false);
    expect(
      await h.run(["projects", "delete", "Shop", "--confirm", "Shop"]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/api/projects/app_1/purge",
      body: { confirm_name: "Shop" },
    });
  });
  it("sets up a project, domain and sending key in one command", async () => {
    const h = harness({
      "GET /api/me": me,
      "GET /v1/domains": { data: [] },
      "POST /v1/domains": { id: "dom_1", name: "shop.com", records: [] },
      "POST /v1/api-keys": {
        id: "key_1",
        key: "sp_live_secret",
        prefix: "sp_live_secret",
      },
    });
    expect(
      await h.run(["setup", "--project", "Shop", "--domain", "shop.com"], {
        SENDPANDA_CONFIG_DIR: "/tmp/sendpanda-cli-test",
      }),
    ).toBe(0);
    expect(h.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/me",
      "GET /v1/domains",
      "POST /v1/domains",
      "POST /v1/api-keys",
    ]);
    expect(JSON.parse(h.out()).sending_key).toBe("sp_live_secret");
  });
  it("adds a mailbox by address and reads its mail", async () => {
    const h = harness({
      "GET /api/me": me,
      "GET /v1/domains": { data: [{ id: "dom_1", name: "shop.com" }] },
      "GET /v1/inbound": { receiving_domains: [] },
      "POST /v1/inbound/mailboxes": { id: "mbx_1", address: "help@shop.com" },
      "GET /v1/inbound/messages/inm_1": { id: "inm_1" },
    });
    expect(
      await h.run(["inbox", "add", "help@shop.com", "--env", "shop"]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      method: "POST",
      url: "/v1/inbound/mailboxes",
      body: { domain_id: "dom_1", local_part: "help" },
    });
    expect(await h.run(["inbox", "read", "inm_1", "--env", "shop"])).toBe(0);
    expect(h.calls.at(-1)!.url).toBe("/v1/inbound/messages/inm_1");
    expect(
      await h.run(["inbox", "add", "help@other.com", "--env", "shop"]),
    ).toBe(2);
    expect(h.err()).toContain("not in this project");
  });
  it("adds a receiving domain and a mailbox on it once verified", async () => {
    const h = harness({
      "GET /api/me": me,
      "POST /v1/inbound/receiving-domains": { id: "ind_1", name: "shop.com" },
      "GET /v1/domains": { data: [] },
      "GET /v1/inbound": {
        receiving_domains: [
          { id: "ind_1", name: "shop.com", status: "verified" },
        ],
      },
      "POST /v1/inbound/mailboxes": { id: "mbx_2" },
    });
    expect(
      await h.run(["inbox", "domain", "add", "Shop.com", "--env", "shop"]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      url: "/v1/inbound/receiving-domains",
      body: { name: "shop.com" },
    });
    expect(
      await h.run(["inbox", "add", "help@shop.com", "--env", "shop"]),
    ).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({
      url: "/v1/inbound/mailboxes",
      body: { receiving_domain_id: "ind_1", local_part: "help" },
    });
  });
  it("surfaces API errors with their code", async () => {
    const h = harness({
      "GET /api/me": { error: { code: "forbidden", message: "Nope" } },
    });
    expect(await h.run(["whoami"])).toBe(1);
    expect(h.err()).toContain("forbidden: Nope");
  });
  it("refuses non-HTTPS API URLs except loopback", async () => {
    const h = harness();
    expect(
      await h.run(["whoami"], { SENDPANDA_API_URL: "http://example.com" }),
    ).toBe(2);
  });
  it("logs in through the browser and saves the approved token", async () => {
    const h = harness({
      "GET /api/me": me,
    });
    let opened = "";
    const code = await h.run(
      ["login"],
      {
        SENDPANDA_TOKEN: "",
        SENDPANDA_CONFIG_DIR: "/tmp/sendpanda-cli-login-test",
      },
      (url: string) => {
        opened = url;
        const u = new URL(url);
        void fetch(
          `http://127.0.0.1:${u.searchParams.get("port")}/callback?token=sp_pat_browser&state=${u.searchParams.get("state")}`,
        );
      },
    );
    expect(code).toBe(0);
    expect(opened).toContain("/cli/authorize?port=");
    expect(h.calls[0]!.headers.Authorization).toBe("Bearer sp_pat_browser");
    expect(h.err()).toContain("Signed in as sam@example.com");
  });
});
