#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceModule = fileURLToPath(new URL("../../../../lib/forge.mjs", import.meta.url));
const bundledModule = fileURLToPath(new URL("./runtime/forge.mjs", import.meta.url));
const modulePath = existsSync(bundledModule) ? bundledModule : sourceModule;
const { runForgeCli } = await import(pathToFileURL(modulePath));

try {
  process.stdout.write(
    // 严格按字节输出:issue-body 等文本载荷若被追加换行,CLI 指纹与内部读取就会不一致(合同指纹假阳性)
    runForgeCli({ argumentsList: process.argv.slice(2), cwd: process.cwd() }),
  );
} catch (error) {
  console.error(`gsd-loop forge: ${error.message}`);
  process.exit(error.exitCode ?? 1);
}
