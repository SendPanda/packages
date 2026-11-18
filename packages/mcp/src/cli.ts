#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createApiCaller,
  createSendPandaMcp,
  createTokenCaller,
} from "./index.js";
async function main() {
  // An access token (SENDPANDA_TOKEN) serves every project the user can
  // reach; a project API key (SENDPANDA_API_KEY) serves that one project.
  if (process.env.SENDPANDA_TOKEN) {
    const call = createTokenCaller(
      process.env.SENDPANDA_TOKEN,
      process.env.SENDPANDA_API_URL,
    );
    await call({ method: "GET", path: "/api/me" });
    await serveStdio(() =>
      createSendPandaMcp(call, { scope: "full", account: true }),
    );
    return;
  }
  const call = createApiCaller(
    process.env.SENDPANDA_API_KEY ?? "",
    process.env.SENDPANDA_API_URL,
  );
  const project = (await call({ method: "GET", path: "/v1/project" })) as {
    api_key_scope: "send" | "full";
  };
  if (!["send", "full"].includes(project.api_key_scope))
    throw new Error("Project key scope could not be verified");
  await serveStdio(() =>
    createSendPandaMcp(call, { scope: project.api_key_scope }),
  );
}
main().catch(() => {
  console.error(
    "SendPanda MCP could not start. Check your token or project key, API URL and connectivity. Secrets are never printed.",
  );
  process.exitCode = 1;
});
