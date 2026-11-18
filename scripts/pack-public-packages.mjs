import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = resolve(root, "dist/npm");
const fromRegistry = process.argv.includes("--registry");
const packages = [
  { name: "@sendpanda/sdk", directory: "sdk-typescript" },
  { name: "@sendpanda/webhooks", directory: "webhooks" },
  { name: "@sendpanda/mcp", directory: "mcp" },
  { name: "@sendpanda/cli", directory: "cli" },
];
function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${result.stdout ?? ""}${result.stderr ?? "see output above"}`,
    );
  return result.stdout;
}
await mkdir(output, { recursive: true });
const manifests = [];
for (const item of packages) {
  run("npm", ["run", "build", "--workspace", item.name]);
  const [packed] = JSON.parse(
    run(
      "npm",
      [
        "pack",
        `./packages/${item.directory}`,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        output,
      ],
      root,
      true,
    ),
  );
  assert.equal(packed.name, item.name);
  const expected = new Set(
    item.directory === "cli"
      ? ["package.json", "README.md", "LICENSE", "dist/cli.js"]
      : [
          "package.json",
          "README.md",
          "LICENSE",
          "dist/index.js",
          "dist/index.cjs",
          "dist/index.d.ts",
          "dist/index.d.cts",
        ],
  );
  if (item.directory === "mcp")
    for (const file of ["dist/cli.js", "dist/cli.cjs", "dist/cli.d.ts"])
      expected.add(file);
  assert.deepEqual(
    new Set(packed.files.map((file) => file.path)),
    expected,
    "Archive must contain only the reviewed public files",
  );
  const metadata = JSON.parse(
    await readFile(
      join(root, "packages", item.directory, "package.json"),
      "utf8",
    ),
  );
  assert.equal(metadata.private, false);
  assert.equal(metadata.license, "MIT");
  assert.equal(metadata.publishConfig.access, "public");
  assert.equal(metadata.publishConfig.registry, "https://registry.npmjs.org/");
  assert.ok(
    Object.keys(metadata.dependencies ?? {}).every(
      (name) => !name.startsWith("@sendpanda/"),
    ),
    "Public packages must not depend on private workspace packages",
  );
  manifests.push({
    name: packed.name,
    version: packed.version,
    filename: packed.filename,
    integrity: packed.integrity,
    shasum: packed.shasum,
    size: packed.size,
    files: packed.files.map((file) => file.path),
  });
}

if (fromRegistry) {
  for (const pkg of manifests) {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    );
    assert.equal(
      response.status,
      200,
      `${pkg.name}@${pkg.version} must be publicly available`,
    );
    const metadata = await response.json();
    assert.equal(
      metadata.dist.integrity,
      pkg.integrity,
      "Published archive must match the reviewed package",
    );
    const indexResponse = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`,
    );
    assert.equal(indexResponse.status, 200);
    const index = await indexResponse.json();
    assert.equal(index["dist-tags"].latest, pkg.version);
  }
}

const consumer = await mkdtemp(join(tmpdir(), "sendpanda-npm-consumer-"));
try {
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "sendpanda-package-acceptance",
      version: "0.0.0",
      private: true,
      type: "module",
    }),
  );
  run(
    "npm",
    [
      "install",
      ...manifests.map((m) =>
        fromRegistry ? `${m.name}@${m.version}` : join(output, m.filename),
      ),
      "@types/node",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--prefer-online",
    ],
    consumer,
    true,
  );
  const smoke = `
const assert = ${"MODULE_ASSERT"};
const { SendPanda, SendPandaError } = ${"MODULE_SDK"};
const { verifyWebhook, WebhookVerificationError } = ${"MODULE_WEBHOOKS"};
const { createHmac } = ${"MODULE_CRYPTO"};
const {createSendPandaMcp,mcpToolNames}= ${"MODULE_MCP"};
assert.ok(mcpToolNames.includes("campaigns_schedule"));
const mcp=createSendPandaMcp(async()=>({data:[]}),{scope:"send"});
await mcp.close();
const api = new SendPanda('sp_live_package_test', {maxRetries:0,fetch:async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer sp_live_package_test');
  assert.equal(options.redirect,'error');
  assert.ok(url.endsWith('/emails/em_test'));
  return new Response(JSON.stringify({id:'em_test',status:'delivered'}));
}});
assert.equal((await api.emails.get('em_test')).status,'delivered');
assert.equal(new SendPandaError('controlled',400,'controlled').name,'SendPandaError');
const timestamp = Math.floor(Date.now()/1000);
const body = JSON.stringify({id:'evt_test',type:'email.delivered',email_id:'em_test',created_at:new Date().toISOString(),metadata:{},data:{}});
const signature=createHmac('sha256','controlled-secret').update(timestamp+'.evt_test.'+body).digest('hex');
const event=verifyWebhook(body,{'webhook-id':'evt_test','webhook-timestamp':String(timestamp),'webhook-signature':'v1='+signature},'controlled-secret');
assert.equal(event.email_id,'em_test');
assert.throws(()=>verifyWebhook(body+' ',{'webhook-id':'evt_test','webhook-timestamp':String(timestamp),'webhook-signature':'v1='+signature},'controlled-secret'),WebhookVerificationError);
`;
  const modules = {
    ASSERT: "node:assert/strict",
    SDK: "@sendpanda/sdk",
    WEBHOOKS: "@sendpanda/webhooks",
    CRYPTO: "node:crypto",
    MCP: "@sendpanda/mcp",
  };
  const esmImports = Object.entries(modules)
    .map(([key, spec]) => `import * as M_${key} from '${spec}';`)
    .join("\n");
  let esm = smoke,
    cjs = smoke;
  for (const [key, spec] of Object.entries(modules)) {
    esm = esm.replace(
      `MODULE_${key}`,
      key === "ASSERT" ? `M_${key}.default` : `M_${key}`,
    );
    cjs = cjs.replace(`MODULE_${key}`, `require('${spec}')`);
  }
  await writeFile(join(consumer, "smoke.mjs"), esmImports + esm);
  await writeFile(
    join(consumer, "smoke.cjs"),
    `(async()=>{${cjs}})().catch(error=>{console.error(error);process.exitCode=1;});`,
  );
  run(process.execPath, ["smoke.mjs"], consumer, true);
  run(process.execPath, ["smoke.cjs"], consumer, true);
  // The CLI is a binary only: its installed bin must start and print help.
  const help = run(
    join(consumer, "node_modules/.bin/sendpanda"),
    ["help"],
    consumer,
    true,
  );
  assert.match(help, /login --token/);
  const typed = `import { SendPanda, type EmailListResponse, type Usage } from '@sendpanda/sdk';
import {createSendPandaMcp} from '@sendpanda/mcp';
const mcp=createSendPandaMcp(async()=>({data:[]}),{scope:'send'});void mcp;
import { verifyWebhook, type WebhookEvent } from '@sendpanda/webhooks';
const panda = new SendPanda('sp_live_typecheck');
const emails: Promise<EmailListResponse> = panda.emails.list({status:'delivered'});
const usage: Promise<Usage> = panda.usage.get();
const templateTest = panda.templates.test('tpl_example', {from:'hello@example.com',to:'reviewer@example.com'});
const broadcastTest = panda.campaigns.test('campaign_example', 'reviewer@example.com');
void templateTest;void broadcastTest;
// @ts-expect-error Test sends require an explicitly selected recipient.
panda.campaigns.test('campaign_example');
const event: WebhookEvent = verifyWebhook('', new Headers(), 'controlled-secret');
void emails; void usage; void event;
// @ts-expect-error Invalid status should fail type checking.
panda.emails.list({status:'invented'});
`;
  await writeFile(join(consumer, "consumer.mts"), typed);
  await writeFile(join(consumer, "consumer.cts"), typed);
  const compiler = join(root, "node_modules/typescript/bin/tsc");
  for (const module of ["NodeNext", "Bundler"]) {
    const config = {
      compilerOptions: {
        target: "ES2022",
        module: module === "Bundler" ? "ESNext" : "NodeNext",
        moduleResolution: module,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
        lib: ["ES2022", "DOM"],
      },
      files:
        module === "Bundler"
          ? ["consumer.mts"]
          : ["consumer.mts", "consumer.cts"],
    };
    await writeFile(join(consumer, "tsconfig.json"), JSON.stringify(config));
    run(
      process.execPath,
      [compiler, "--project", "tsconfig.json"],
      consumer,
      true,
    );
  }
} finally {
  await rm(consumer, { recursive: true, force: true });
}
const gitSha = run("git", ["rev-parse", "HEAD"], root, true).trim();
await writeFile(
  join(output, "manifest.json"),
  JSON.stringify(
    { gitSha, node: process.version, packages: manifests },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified isolated ESM, CommonJS and TypeScript consumers for ${manifests.map((m) => `${m.name}@${m.version}`).join(", ")} from ${fromRegistry ? "the public npm registry" : "local archives"}. Archives: ${output}`,
);
