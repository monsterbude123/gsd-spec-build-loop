import { readFileSync } from "node:fs";
import { UsageError } from "./errors.mjs";
import { runProcess } from "./process.mjs";
import { createGitHubForge } from "./forge-github.mjs";
import { createGitLabForge, parseRemote } from "./forge-gitlab.mjs";

// forge 层:把 playbooks 的托管平台交互从 gh 收敛到一个抽象接口。
// 探测顺序:GSD_LOOP_FORGE 环境变量 > origin remote URL 解析。
// github backend 包 gh(argv 与历史实现逐字节兼容,守护既有测试);
// gitlab backend 走 curl + REST(GITLAB_TOKEN)。

export const FORGES = new Set(["github", "gitlab"]);

function forgeFromRemote({ cwd, run }) {
  const runner = run ?? runProcess;
  const result = runner("git", ["remote", "get-url", "origin"], { cwd });
  if (result.status !== 0) {
    throw new UsageError(
      "could not detect forge: git remote get-url origin failed; set GSD_LOOP_FORGE=github|gitlab",
    );
  }
  const { host } = parseRemote((result.stdout ?? "").trim());
  if (/github/i.test(host)) return "github";
  if (/gitlab/i.test(host)) return "gitlab";
  // 自托管 Gitea 等未识别主机:默认 github(URL 形态最接近),可显式覆盖。
  return "github";
}

export function detectForge({ cwd = process.cwd(), env = process.env, run } = {}) {
  const override = env.GSD_LOOP_FORGE;
  if (override) {
    if (!FORGES.has(override)) {
      throw new UsageError(`unknown GSD_LOOP_FORGE: ${override} (expected github|gitlab)`);
    }
    return override;
  }
  return forgeFromRemote({ cwd, run });
}

export function createForge({
  cwd = process.cwd(),
  env = process.env,
  run,
  forge,
  repo,
  fallbackForge,
  detect = true,
} = {}) {
  let resolvedForge = forge;
  if (!resolvedForge && env.GSD_LOOP_FORGE) {
    if (!FORGES.has(env.GSD_LOOP_FORGE)) {
      throw new UsageError(`unknown GSD_LOOP_FORGE: ${env.GSD_LOOP_FORGE} (expected github|gitlab)`);
    }
    resolvedForge = env.GSD_LOOP_FORGE;
  }
  if (!resolvedForge && detect) {
    try {
      resolvedForge = forgeFromRemote({ cwd, run });
    } catch (error) {
      // lib 守卫(linkage/outcomes 以 detect:false 调用)不走这里;
      // CLI 无法探测是值得报告的真实配置错误。
      if (fallbackForge && FORGES.has(fallbackForge)) {
        resolvedForge = fallbackForge;
      } else {
        throw error;
      }
    }
  }
  if (!resolvedForge && fallbackForge && FORGES.has(fallbackForge)) {
    // detect:false 且 env 未设时的兜底(守卫的历史行为 = 纯 gh)。
    resolvedForge = fallbackForge;
  }
  if (!resolvedForge) {
    throw new UsageError(
      "could not detect forge: git remote get-url origin failed; set GSD_LOOP_FORGE=github|gitlab",
    );
  }
  if (resolvedForge === "gitlab") {
    return createGitLabForge({ cwd, repo, run, env });
  }
  return createGitHubForge({ cwd, repo, run });
}

function readBodySource({ body, bodyFile }) {
  if (bodyFile) {
    return readFileSync(bodyFile, "utf8");
  }
  if (body !== undefined) {
    return body;
  }
  throw new UsageError("requires --body TEXT or --body-file PATH");
}

function requireNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError(`${name} requires a positive number`);
  }
  return parsed;
}

// CLI 方法表:method 名 → 参数解析 + client 调用。输出一律 JSON(body 类除外)。
const METHODS = {
  repo: (client) => client.repo(),
  whoami: (client) => client.whoami(),
  "ensure-labels": (client, options) =>
    client.ensureLabels(options.labels.map((name) => ({
      name,
      color: options.color ?? "ededed",
      description: options.description,
    }))),
  "issue-list": (client, options) => client.issueList({
    state: options.state,
    label: options.label,
    assignee: options.assignee,
    limit: options.limit,
  }),
  "issue-view": (client, options) => client.issueView(requireNumber(options.positional[0], "issue-view")),
  "issue-body": (client, options) =>
    client.issueBody(requireNumber(options.positional[0], "issue-body")),
  "issue-create": (client, options) => client.issueCreate({
    title: options.title,
    body: readBodySource(options),
  }),
  "issue-edit": (client, options) => client.issueEdit(
    requireNumber(options.positional[0], "issue-edit"),
    {
      addAssignee: options["add-assignee"],
      removeAssignee: options["remove-assignee"],
      addLabels: options["add-label"],
      removeLabels: options["remove-label"],
    },
  ),
  "issue-comment": (client, options) => client.issueComment(
    requireNumber(options.positional[0], "issue-comment"),
    { body: readBodySource(options) },
  ),
  "issue-comments": (client, options) =>
    client.issueComments(requireNumber(options.positional[0], "issue-comments")),
  "pr-list": (client, options) => client.prList({
    state: options.state,
    label: options.label,
    head: options.head,
    limit: options.limit,
  }),
  "pr-view": (client, options) => client.prView(requireNumber(options.positional[0], "pr-view")),
  "pr-create": (client, options) => client.prCreate({
    title: options.title,
    body: readBodySource(options),
    head: options.head,
    base: options.base,
  }),
  "pr-comment": (client, options) => client.prComment(
    requireNumber(options.positional[0], "pr-comment"),
    { body: readBodySource(options) },
  ),
  "pr-edit": (client, options) => {
    const body = options["body-file"] || options.body !== undefined
      ? readBodySource(options)
      : undefined;
    return client.prEdit(requireNumber(options.positional[0], "pr-edit"), {
      removeLabels: options["remove-label"],
      body,
    });
  },
  "pr-comments": (client, options) =>
    client.prComments(requireNumber(options.positional[0], "pr-comments")),
  "pr-evidence": (client, options) =>
    client.prEvidence(requireNumber(options.positional[0], "pr-evidence")),
  "pr-files": (client, options) =>
    client.prFiles(requireNumber(options.positional[0], "pr-files")),
  "pr-checks": (client, options) =>
    client.prChecks(requireNumber(options.positional[0], "pr-checks")),
  "pr-merge-state": (client, options) =>
    client.prMergeState(requireNumber(options.positional[0], "pr-merge-state")),
  "pr-linkage": (client, options) =>
    client.prLinkage(requireNumber(options.positional[0], "pr-linkage")),
};

const REPEATABLE = new Set(["labels", "add-label", "remove-label"]);
const VALUE_OPTIONS = new Set([
  "--repo", "--forge", "--state", "--label", "--assignee", "--limit", "--head", "--base",
  "--title", "--body", "--body-file", "--color", "--description", "--labels",
  "--add-assignee", "--remove-assignee", "--add-label", "--remove-label",
]);

function parseForgeArguments(argumentsList) {
  const options = { positional: [], labels: [], "add-label": [], "remove-label": [] };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index];
    if (value === "--repo" || value === "--forge") {
      options[value.slice(2)] = argumentsList[index + 1];
      index += 1;
      continue;
    }
    const method = METHODS[value] ? value : null;
    if (method && !options.method) {
      options.method = method;
      continue;
    }
    if (!options.method) {
      throw new UsageError(`unknown forge method: ${value}`);
    }
    if (value.startsWith("--")) {
      const name = value.slice(2);
      if (!VALUE_OPTIONS.has(`--${name}`)) {
        throw new UsageError(`unknown forge option: ${value}`);
      }
      const optionValue = argumentsList[index + 1];
      if (optionValue === undefined) {
        throw new UsageError(`--${name} requires a value`);
      }
      index += 1;
      const key = name;
      if (REPEATABLE.has(key)) {
        options[key].push(optionValue);
      } else {
        options[key] = optionValue;
      }
      continue;
    }
    options.positional.push(value);
  }
  return options;
}

export function runForgeCli({ argumentsList, cwd = process.cwd(), env = process.env, run } = {}) {
  const options = parseForgeArguments(argumentsList);
  if (!options.method) {
    throw new UsageError("usage: forge.mjs METHOD [options] (--repo OWNER/NAME)");
  }
  const client = createForge({ cwd, env, run, forge: options.forge, repo: options.repo });
  const result = METHODS[options.method](client, options);
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result, null, 2);
}
