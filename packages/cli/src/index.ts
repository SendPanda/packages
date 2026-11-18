import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

export type Deps = {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  out: (text: string) => void;
  err: (text: string) => void;
  readFile: (path: string) => Promise<string>;
  open: (url: string) => void;
};
type Config = { token?: string; api?: string; environment?: string };
const DEFAULT_API = "https://api.sendpanda.email";
const DEFAULT_WEB = "https://sendpanda.email";
const HELP = `sendpanda: manage SendPanda from a terminal or a coding agent

Setup
  login [--api URL] [--web URL]            Open SendPanda in your browser to approve access
  login --token <sp_pat_...>               Save an access token instead (Settings > Connections)
  logout                                   Forget the saved token
  whoami                                   Show your accounts, projects and environment ids
  setup --project NAME --domain DOMAIN     Create a project, add the domain, create a sending key
        [--account ORG_ID] [--env-file .env]

Projects (accounts hold projects; each project has environments such as Production)
  projects list
  projects create NAME [--account ORG_ID]
  projects rename PROJECT NEW_NAME
  projects delete PROJECT --confirm "EXACT NAME"      PERMANENT, with all its data
  use PROJECT                                         Default environment for later commands

Resources (use --env PROJECT_OR_ENVIRONMENT to override the default)
  domains list | add NAME | get ID | verify ID | delete ID
          | tracking ID [--opens on|off] [--clicks on|off]   Open/click tracking, off by default
  keys list | create NAME [--scope send|full] | revoke ID
  templates list | get ID | create --name N --subject S (--html-file F | --text-file F | --design-file F)
            | update ID --name N --subject S (--html-file F | --text-file F | --design-file F)
            | publish ID [--version N] | preview ID [--version N] [--variables JSON|@file]
  emails send --from A --to B[,C] --subject S (--html-file F | --text-file F | --template ID) [--attach F[,F]] | list | get ID
  webhooks list | create URL [--events a,b] | delete ID   (events include email.received)
  inbox [status] | domain add|verify|rm NAME | add local@domain | check DOMAIN | messages MAILBOX [--cursor C]
        | read MESSAGE_ID | rm MAILBOX_ID | rm-message MESSAGE_ID     Incoming mail (paid plans)

Everything else
  api METHOD PATH [--data JSON|@file] [--env ...]     Any API endpoint as you
  routes [FILTER]                                     List API endpoints
  mcp                                                 Run the MCP server for all your projects

Output is JSON on stdout; messages go to stderr. SENDPANDA_TOKEN, SENDPANDA_API_URL and
SENDPANDA_ENVIRONMENT override the saved login. Billing, sign-in and tokens need the dashboard.
`;

class CliError extends Error {}
function parse(argv: string[]) {
  const positional: string[] = [],
    flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[k!] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--"))
        flags[k!] = argv[++i]!;
      else flags[k!] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}
const str = (v: string | true | undefined) =>
  typeof v === "string" ? v : undefined;

export async function main(
  argv: string[],
  deps: Partial<Deps> = {},
): Promise<number> {
  const d: Deps = {
    fetch: deps.fetch ?? fetch,
    env: deps.env ?? process.env,
    out: deps.out ?? ((t) => process.stdout.write(t)),
    err: deps.err ?? ((t) => process.stderr.write(t)),
    readFile: deps.readFile ?? ((p) => readFile(p, "utf8")),
    open: deps.open ?? openBrowser,
  };
  try {
    await run(argv, d);
    return 0;
  } catch (e) {
    d.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError ? 2 : 1;
  }
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd!, args as string[], { stdio: "ignore", detached: true })
      .on("error", () => {})
      .unref();
  } catch {
    /* the URL is printed too */
  }
}

// Waits for the dashboard to redirect back to a one-shot loopback listener.
async function browserLogin(d: Deps, webUrl: string): Promise<string> {
  const state = randomBytes(16).toString("hex");
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const token = url.searchParams.get("token");
      const ok = url.searchParams.get("state") === state && !!token;
      res
        .writeHead(ok ? 200 : 400, {
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
        })
        .end(
          ok
            ? '<!doctype html><title>SendPanda</title><body style="font-family:system-ui;padding:3rem"><h2>You\'re signed in.</h2><p>You can close this tab and return to your terminal.</p>'
            : '<!doctype html><title>SendPanda</title><body style="font-family:system-ui;padding:3rem"><h2>Sign-in failed.</h2><p>Return to your terminal and run sendpanda login again.</p>',
        );
      if (ok) done(() => resolve(token!));
    });
    const timer = setTimeout(
      () =>
        done(() =>
          reject(new CliError("Timed out waiting for browser approval")),
        ),
      5 * 60_000,
    );
    function done(fn: () => void) {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      fn();
    }
    server.on("error", (e) => done(() => reject(e)));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      const target = new URL("/cli/authorize", webUrl);
      target.searchParams.set("port", String(port));
      target.searchParams.set("state", state);
      d.err(
        `Opening your browser to approve access. If it does not open, visit:\n${target}\n`,
      );
      d.open(target.toString());
    });
  });
}

function configPath(d: Deps) {
  return join(
    d.env.SENDPANDA_CONFIG_DIR ?? join(homedir(), ".config", "sendpanda"),
    "config.json",
  );
}
async function loadConfig(d: Deps): Promise<Config> {
  try {
    return JSON.parse(await d.readFile(configPath(d))) as Config;
  } catch {
    return {};
  }
}
async function saveConfig(d: Deps, config: Config) {
  const path = configPath(d);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

type Me = {
  user: { id: string; name: string; email: string };
  organisations: { id: string; name: string; role: string }[];
  applications: {
    id: string;
    name: string;
    organisation_id: string;
    role: string;
  }[];
  projects: {
    id: string;
    name: string;
    application_id: string;
    organisation_id: string;
  }[];
};

async function run(argv: string[], d: Deps) {
  const { positional: p, flags } = parse(argv);
  const [command, sub, ...rest] = p;
  if (!command || command === "help" || flags.help || flags.h) {
    d.out(HELP);
    return;
  }
  const saved = await loadConfig(d);
  const token = d.env.SENDPANDA_TOKEN ?? saved.token;
  const api = (
    str(flags.api) ??
    d.env.SENDPANDA_API_URL ??
    saved.api ??
    DEFAULT_API
  ).replace(/\/(v1)?\/?$/, "");
  const base = new URL(api);
  if (
    base.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new CliError("The API URL must use HTTPS");
  const print = (value: unknown) =>
    d.out(JSON.stringify(value, null, 2) + "\n");

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; env?: string; token?: string } = {},
  ) {
    const secret = options.token ?? token;
    if (!secret) throw new CliError("Not signed in. Run: sendpanda login");
    if (!/^\/(v1|api)\//.test(path))
      throw new CliError("Path must start with /v1/ or /api/");
    const response = await d.fetch(new URL(path, base), {
      method,
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(options.env ? { "X-Environment-Id": options.env } : {}),
        ...(options.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const data = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (!response.ok)
      throw new Error(
        `${data?.error?.code ?? "request_failed"}: ${data?.error?.message ?? `HTTP ${response.status}`}`,
      );
    return data;
  }
  const me = () => call("GET", "/api/me") as Promise<Me>;

  // A project may be given as an environment id, a project id or a name.
  function findProject(all: Me, value: string) {
    const lower = value.toLowerCase();
    const application =
      all.applications.find((a) => a.id === value) ??
      all.applications.find((a) => a.name.toLowerCase() === lower);
    const environment =
      all.projects.find((e) => e.id === value) ??
      (application
        ? (all.projects.find(
            (e) =>
              e.application_id === application.id && e.name === "Production",
          ) ?? all.projects.find((e) => e.application_id === application.id))
        : undefined);
    const owner =
      application ??
      all.applications.find((a) => a.id === environment?.application_id);
    if (!owner)
      throw new CliError(
        `No project matches "${value}". Run: sendpanda projects list`,
      );
    return { application: owner, environment };
  }
  async function environment() {
    const wanted =
      str(flags.env) ?? d.env.SENDPANDA_ENVIRONMENT ?? saved.environment;
    if (!wanted)
      throw new CliError(
        "Choose a project: sendpanda use PROJECT, or pass --env PROJECT",
      );
    if (/^prj_[a-f0-9]+$/.test(wanted)) return wanted;
    const found = findProject(await me(), wanted).environment;
    if (!found) throw new CliError(`Project "${wanted}" has no environment`);
    return found.id;
  }
  const inEnv = async (method: string, path: string, body?: unknown) =>
    call(method, path, { body, env: await environment() });
  const content = async () => {
    const out: Record<string, unknown> = {};
    for (const [flag, key] of [
      ["html-file", "html"],
      ["text-file", "text"],
    ] as const)
      if (str(flags[flag])) out[key] = await d.readFile(str(flags[flag])!);
    if (str(flags["design-file"]))
      out.design = JSON.parse(await d.readFile(str(flags["design-file"])!));
    return out;
  };
  const need = (value: string | undefined, what: string) => {
    if (!value) throw new CliError(`Missing ${what}. See: sendpanda help`);
    return value;
  };

  switch (command) {
    case "login": {
      let given = str(flags.token) ?? d.env.SENDPANDA_TOKEN;
      if (!given) {
        const web =
          str(flags.web) ??
          d.env.SENDPANDA_WEB_URL ??
          (base.hostname.startsWith("api.")
            ? `${base.protocol}//${base.host.slice(4)}`
            : base.hostname === "localhost" || base.hostname === "127.0.0.1"
              ? "http://localhost:3000"
              : DEFAULT_WEB);
        given = await browserLogin(d, web);
      }
      if (!given.startsWith("sp_pat_"))
        throw new CliError("That is not a SendPanda access token (sp_pat_...)");
      const who = (await call("GET", "/api/me", { token: given })) as Me;
      await saveConfig(d, {
        ...saved,
        token: given,
        ...(str(flags.api) ? { api: str(flags.api) } : {}),
      });
      d.err(`Signed in as ${who.user.email}\n`);
      print({ user: who.user });
      return;
    }
    case "logout":
      await saveConfig(d, { ...saved, token: undefined });
      d.err("Signed out. Revoke the token in the dashboard to disable it.\n");
      return;
    case "whoami": {
      const all = await me();
      print({
        user: all.user,
        accounts: all.organisations,
        projects: all.applications.map((a) => ({
          ...a,
          environments: all.projects
            .filter((e) => e.application_id === a.id)
            .map((e) => ({ id: e.id, name: e.name })),
        })),
        default_environment:
          d.env.SENDPANDA_ENVIRONMENT ?? saved.environment ?? null,
      });
      return;
    }
    case "use": {
      const found = findProject(await me(), need(sub, "project"));
      if (!found.environment) throw new CliError("Project has no environment");
      await saveConfig(d, { ...saved, environment: found.environment.id });
      d.err(`Using ${found.application.name} (${found.environment.id})\n`);
      print({ environment: found.environment.id });
      return;
    }
    case "projects": {
      if (sub === "list" || !sub) {
        const all = await me();
        print(
          all.applications.map((a) => ({
            ...a,
            environments: all.projects
              .filter((e) => e.application_id === a.id)
              .map((e) => ({ id: e.id, name: e.name })),
          })),
        );
      } else if (sub === "create") {
        const all = await me();
        const account =
          str(flags.account) ??
          (all.organisations.length === 1
            ? all.organisations[0]!.id
            : undefined);
        if (!account)
          throw new CliError(
            "Pass --account ORG_ID (you belong to several accounts; see: sendpanda whoami)",
          );
        print(
          await call("POST", "/api/projects", {
            body: {
              name: need(rest[0], "project name"),
              organisation_id: account,
            },
          }),
        );
      } else if (sub === "rename") {
        const found = findProject(await me(), need(rest[0], "project"));
        print(
          await call("PATCH", `/api/projects/${found.application.id}`, {
            body: { name: need(rest[1], "new name") },
          }),
        );
      } else if (sub === "delete") {
        const found = findProject(await me(), need(rest[0], "project"));
        if (str(flags.confirm) !== found.application.name)
          throw new CliError(
            `This permanently deletes "${found.application.name}" and all its data. Re-run with --confirm "${found.application.name}"`,
          );
        print(
          await call("POST", `/api/projects/${found.application.id}/purge`, {
            body: { confirm_name: found.application.name },
          }),
        );
      } else throw new CliError("Usage: projects list|create|rename|delete");
      return;
    }
    case "domains": {
      if (sub === "list" || !sub) print(await inEnv("GET", "/v1/domains"));
      else if (sub === "add")
        print(
          await inEnv("POST", "/v1/domains", { name: need(rest[0], "domain") }),
        );
      else if (sub === "get")
        print(await inEnv("GET", `/v1/domains/${need(rest[0], "domain id")}`));
      else if (sub === "verify")
        print(
          await inEnv(
            "POST",
            `/v1/domains/${need(rest[0], "domain id")}/verify`,
          ),
        );
      else if (sub === "delete")
        print(
          await inEnv("DELETE", `/v1/domains/${need(rest[0], "domain id")}`),
        );
      else if (sub === "tracking") {
        const domainId = need(rest[0], "domain id"),
          body: Record<string, boolean> = {};
        for (const [flag, key] of [
          ["opens", "open_tracking"],
          ["clicks", "click_tracking"],
        ] as const) {
          const value = str(flags[flag]);
          if (value === undefined) continue;
          if (value !== "on" && value !== "off")
            throw new CliError(`--${flag} must be on or off`);
          body[key] = value === "on";
        }
        print(
          Object.keys(body).length
            ? await inEnv("PATCH", `/v1/domains/${domainId}`, body)
            : await inEnv("GET", `/v1/domains/${domainId}`),
        );
      } else
        throw new CliError(
          "Usage: domains list|add|get|verify|tracking|delete",
        );
      return;
    }
    case "keys": {
      if (sub === "list" || !sub) print(await inEnv("GET", "/v1/api-keys"));
      else if (sub === "create")
        print(
          await inEnv("POST", "/v1/api-keys", {
            name: need(rest[0], "key name"),
            scope: str(flags.scope) ?? "send",
          }),
        );
      else if (sub === "revoke")
        print(await inEnv("DELETE", `/v1/api-keys/${need(rest[0], "key id")}`));
      else throw new CliError("Usage: keys list|create|revoke");
      return;
    }
    case "templates": {
      if (sub === "list" || !sub) print(await inEnv("GET", "/v1/templates"));
      else if (sub === "get")
        print(
          await inEnv("GET", `/v1/templates/${need(rest[0], "template id")}`),
        );
      else if (sub === "create" || sub === "update")
        print(
          await inEnv(
            "POST",
            sub === "create"
              ? "/v1/templates"
              : `/v1/templates/${need(rest[0], "template id")}/versions`,
            {
              name: need(str(flags.name), "--name"),
              subject: need(str(flags.subject), "--subject"),
              ...(await content()),
            },
          ),
        );
      else if (sub === "publish") {
        const id = need(rest[0], "template id");
        let version = Number(str(flags.version));
        if (!version) {
          const t = (await inEnv("GET", `/v1/templates/${id}`)) as {
            versions?: { version: number }[];
          };
          version = Math.max(...(t.versions ?? []).map((v) => v.version), 0);
        }
        if (!version) throw new CliError("Template has no version to publish");
        print(await inEnv("POST", `/v1/templates/${id}/publish`, { version }));
      } else if (sub === "preview") {
        const variables = str(flags.variables);
        print(
          await inEnv(
            "POST",
            `/v1/templates/${need(rest[0], "template id")}/preview`,
            {
              variables: variables
                ? JSON.parse(
                    variables.startsWith("@")
                      ? await d.readFile(variables.slice(1))
                      : variables,
                  )
                : {},
              ...(str(flags.version)
                ? { version: Number(str(flags.version)) }
                : {}),
            },
          ),
        );
      } else
        throw new CliError(
          "Usage: templates list|get|create|update|publish|preview",
        );
      return;
    }
    case "emails": {
      if (sub === "list" || !sub) print(await inEnv("GET", "/v1/emails"));
      else if (sub === "get")
        print(await inEnv("GET", `/v1/emails/${need(rest[0], "email id")}`));
      else if (sub === "send")
        print(
          await inEnv("POST", "/v1/emails", {
            from: need(str(flags.from), "--from"),
            to: need(str(flags.to), "--to")
              .split(",")
              .map((v) => v.trim()),
            ...(str(flags.subject) ? { subject: str(flags.subject) } : {}),
            ...(str(flags.template)
              ? { template_id: str(flags.template) }
              : {}),
            ...(await content()),
            ...(str(flags.attach)
              ? {
                  attachments: await Promise.all(
                    str(flags.attach)!
                      .split(",")
                      .map((v) => v.trim())
                      .filter(Boolean)
                      .map(async (path) => ({
                        filename: path.split(/[\\/]/).pop()!,
                        content: (await readFile(path)).toString("base64"),
                      })),
                  ),
                }
              : {}),
          }),
        );
      else throw new CliError("Usage: emails send|list|get");
      return;
    }
    case "webhooks": {
      if (sub === "list" || !sub) print(await inEnv("GET", "/v1/webhooks"));
      else if (sub === "create")
        print(
          await inEnv("POST", "/v1/webhooks", {
            url: need(rest[0], "URL"),
            events: (
              str(flags.events) ??
              "email.delivered,email.bounced,email.complained,email.failed"
            ).split(","),
          }),
        );
      else if (sub === "delete")
        print(
          await inEnv("DELETE", `/v1/webhooks/${need(rest[0], "webhook id")}`),
        );
      else throw new CliError("Usage: webhooks list|create|delete");
      return;
    }
    case "inbox": {
      const box = need(sub ?? "status", "subcommand");
      if (box === "status") print(await inEnv("GET", "/v1/inbound"));
      else if (box === "domain") {
        const action = need(rest[0], "add|verify|rm"),
          name = need(rest[1], "domain").toLowerCase();
        if (action === "add")
          print(await inEnv("POST", "/v1/inbound/receiving-domains", { name }));
        else if (action === "verify" || action === "rm") {
          const summary = (await inEnv("GET", "/v1/inbound")) as {
            receiving_domains: { id: string; name: string }[];
          };
          const found = summary.receiving_domains.find(
            (d) => d.id === name || d.name === name,
          );
          if (!found)
            throw new CliError(`"${name}" is not a receiving domain here`);
          print(
            action === "verify"
              ? await inEnv(
                  "POST",
                  `/v1/inbound/receiving-domains/${found.id}/verify`,
                )
              : await inEnv(
                  "DELETE",
                  `/v1/inbound/receiving-domains/${found.id}`,
                ),
          );
        } else throw new CliError("Usage: inbox domain add|verify|rm NAME");
      } else if (box === "add" || box === "check") {
        const raw = need(rest[0], box === "add" ? "local@domain" : "domain");
        const [local, name] = box === "add" ? raw.split("@") : [undefined, raw];
        if (!name || (box === "add" && !local))
          throw new CliError("Use an address such as support@acme.com");
        const domains = (await inEnv("GET", "/v1/domains")) as {
          data: { id: string; name: string }[];
        };
        let domain = domains.data.find(
          (d) => d.id === name || d.name === name.toLowerCase(),
        );
        if (box === "add" && !domain) {
          const summary = (await inEnv("GET", "/v1/inbound")) as {
            receiving_domains: { id: string; name: string; status: string }[];
          };
          const receiving = summary.receiving_domains.find(
            (d) => d.name === name.toLowerCase() && d.status === "verified",
          );
          if (receiving) {
            print(
              await inEnv("POST", "/v1/inbound/mailboxes", {
                receiving_domain_id: receiving.id,
                local_part: local,
              }),
            );
            return;
          }
        }
        if (!domain)
          throw new CliError(`Domain "${name}" is not in this project`);
        print(
          box === "add"
            ? await inEnv("POST", "/v1/inbound/mailboxes", {
                domain_id: domain.id,
                local_part: local,
              })
            : await inEnv("POST", `/v1/inbound/domains/${domain.id}/verify`),
        );
      } else if (box === "messages")
        print(
          await inEnv(
            "GET",
            `/v1/inbound/mailboxes/${need(rest[0], "mailbox id")}/messages${str(flags.cursor) ? `?cursor=${encodeURIComponent(str(flags.cursor)!)}` : ""}`,
          ),
        );
      else if (box === "read")
        print(
          await inEnv(
            "GET",
            `/v1/inbound/messages/${need(rest[0], "message id")}`,
          ),
        );
      else if (box === "rm")
        print(
          await inEnv(
            "DELETE",
            `/v1/inbound/mailboxes/${need(rest[0], "mailbox id")}`,
          ),
        );
      else if (box === "rm-message")
        print(
          await inEnv(
            "DELETE",
            `/v1/inbound/messages/${need(rest[0], "message id")}`,
          ),
        );
      else
        throw new CliError(
          "Usage: inbox status|add|check|messages|read|rm|rm-message",
        );
      return;
    }
    case "api": {
      const method = need(sub, "METHOD").toUpperCase();
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method))
        throw new CliError("METHOD must be GET, POST, PATCH or DELETE");
      let body: unknown;
      const data = str(flags.data);
      if (data !== undefined)
        body = JSON.parse(
          data.startsWith("@") ? await d.readFile(data.slice(1)) : data,
        );
      const wantsEnv = str(flags.env) || (rest[0] ?? "").startsWith("/v1/");
      print(
        await call(method, need(rest[0], "PATH"), {
          body,
          env: wantsEnv ? await environment() : undefined,
        }),
      );
      return;
    }
    case "routes": {
      const spec = (await d
        .fetch(new URL("/openapi.json", base))
        .then((r) => r.json())) as {
        paths: Record<string, Record<string, { summary?: string }>>;
      };
      const filter = (sub ?? "").toLowerCase();
      print(
        Object.entries(spec.paths).flatMap(([path, methods]) =>
          Object.keys(methods)
            .filter(() => path.toLowerCase().includes(filter))
            .map((m) => `${m.toUpperCase()} ${path}`),
        ),
      );
      return;
    }
    case "setup": {
      const name = need(str(flags.project), "--project NAME");
      const domain = need(str(flags.domain), "--domain DOMAIN");
      const all = await me();
      let found = all.applications.find(
        (a) => a.name.toLowerCase() === name.toLowerCase(),
      );
      let environmentId = found
        ? all.projects.find(
            (e) => e.application_id === found!.id && e.name === "Production",
          )?.id
        : undefined;
      if (!found) {
        const account =
          str(flags.account) ??
          (all.organisations.length === 1
            ? all.organisations[0]!.id
            : undefined);
        if (!account)
          throw new CliError("Pass --account ORG_ID (see: sendpanda whoami)");
        const created = (await call("POST", "/api/projects", {
          body: { name, organisation_id: account },
        })) as { id: string; environment_id: string };
        environmentId = created.environment_id;
        d.err(`Created project ${name}\n`);
      } else d.err(`Using existing project ${found.name}\n`);
      if (!environmentId)
        throw new CliError("Project has no Production environment");
      const env = environmentId;
      const domains = (await call("GET", "/v1/domains", { env })) as {
        data: { id: string; name: string }[];
      };
      const existing = domains.data.find(
        (x) => x.name === domain.toLowerCase(),
      );
      const added = existing
        ? await call("GET", `/v1/domains/${existing.id}`, { env })
        : await call("POST", "/v1/domains", { env, body: { name: domain } });
      const key = (await call("POST", "/v1/api-keys", {
        env,
        body: { name: "Created by sendpanda setup", scope: "send" },
      })) as { secret?: string; key?: string };
      const secret = key.secret ?? key.key;
      if (str(flags["env-file"]) && secret)
        await writeFile(
          str(flags["env-file"])!,
          `SENDPANDA_API_KEY=${secret}\n`,
          { flag: "a", mode: 0o600 },
        );
      await saveConfig(d, { ...saved, environment: env });
      d.err(
        "Add the DNS records below at your DNS provider, then run: sendpanda domains verify <id>\n" +
          (str(flags["env-file"])
            ? `The sending key was appended to ${str(flags["env-file"])}.\n`
            : "The sending key is shown once below; store it in your secrets manager.\n"),
      );
      print({
        environment: env,
        domain: added,
        sending_key: str(flags["env-file"]) ? "(written to env file)" : secret,
      });
      return;
    }
    case "mcp":
      throw new CliError(
        "Run the MCP server with: SENDPANDA_TOKEN=sp_pat_... npx -y @sendpanda/mcp",
      );
    default:
      throw new CliError(`Unknown command "${command}". Run: sendpanda help`);
  }
}
