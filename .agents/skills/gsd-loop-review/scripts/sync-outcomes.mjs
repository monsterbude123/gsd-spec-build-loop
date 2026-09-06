#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceModule = fileURLToPath(new URL("../../../../lib/outcomes.mjs", import.meta.url));
const bundledModule = fileURLToPath(new URL("./runtime/outcomes.mjs", import.meta.url));
const modulePath = existsSync(bundledModule) ? bundledModule : sourceModule;
const { fingerprintContract, parseOutcomeArguments, syncIssueOutcomes } = await import(pathToFileURL(modulePath));

try {
  if (process.argv[2] === "fingerprint") {
    console.log(fingerprintContract(readFileSync(0, "utf8")));
    process.exit(0);
  }
  const options = parseOutcomeArguments(process.argv.slice(2));
  const changed = syncIssueOutcomes({ cwd: process.cwd(), ...options });
  const state = changed ? options.state : `already ${options.state}`;
  console.log(`issue #${options.issue} outcomes: ${state}`);
} catch (error) {
  console.error(`gsd-loop outcomes: ${error.message}`);
  process.exit(error.exitCode ?? 1);
}
