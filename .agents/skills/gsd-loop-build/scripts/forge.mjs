#!/usr/bin/env node

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceModule = fileURLToPath(new URL("../../../../lib/forge.mjs", import.meta.url));
const bundledModule = fileURLToPath(new URL("./runtime/forge.mjs", import.meta.url));
const modulePath = existsSync(bundledModule) ? bundledModule : sourceModule;
const { runForgeCli } = await import(pathToFileURL(modulePath));

try {
  process.stdout.write(
    runForgeCli({ argumentsList: process.argv.slice(2), cwd: process.cwd() }) + "\n",
  );
} catch (error) {
  console.error(`gsd-loop forge: ${error.message}`);
  process.exit(error.exitCode ?? 1);
}
