import { copyFile } from "node:fs/promises";
await copyFile("dist/index.d.ts", "dist/index.d.cts");
