# SendPanda public packages

Official JavaScript and TypeScript tools for [SendPanda](https://sendpanda.email).

| Package | Source | npm |
| --- | --- | --- |
| SDK | [TypeScript SDK](packages/sdk-typescript) | [@sendpanda/sdk](https://www.npmjs.com/package/@sendpanda/sdk) |
| Webhooks | [Signature verification](packages/webhooks) | [@sendpanda/webhooks](https://www.npmjs.com/package/@sendpanda/webhooks) |
| MCP | [MCP server](packages/mcp) | [@sendpanda/mcp](https://www.npmjs.com/package/@sendpanda/mcp) |
| CLI | [Command line](packages/cli) | [@sendpanda/cli](https://www.npmjs.com/package/@sendpanda/cli) |

## Development

Use Node.js 22 or newer, then run:

```sh
npm ci
npm run build
npm run typecheck
npm test
npm run packages:check
```

Package checks build exact allowlisted npm archives and verify isolated ESM, CommonJS, TypeScript and CLI consumers. Tests use mock APIs and local transports.

## Scope and releases

This repository contains only the MIT-licensed public client packages. The SendPanda application, API, workers, database and infrastructure are maintained separately in a private repository. No private Git history is included here.

The npm scope remains `@sendpanda`. Changing the GitHub organisation does not change install commands. Existing npm releases retain their original repository metadata; a new version of each package is required to update its npm source link.

Before a release, bump the selected package version, review and test the archive, and verify the resulting registry integrity. SendPanda’s official MCP Registry identifier is `io.github.SendPanda/sendpanda`. Both it and the older registry entry point to the same hosted MCP endpoint.

[API and guides](https://sendpanda.email/docs) · [Report an issue](https://github.com/SendPanda/packages/issues)
