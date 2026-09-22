import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createForge, detectForge, FORGES, runForgeCli } from "../lib/forge.mjs";
import { createGitLabForge } from "../lib/forge-gitlab.mjs";
import { BlockedError, UsageError } from "../lib/errors.mjs";

// ---- detectForge ----
{
  // 显式环境变量优先
  assert.equal(detectForge({ env: { GSD_LOOP_FORGE: "gitlab" }, run: () => ({ status: 1, stdout: "", stderr: "" }) }), "gitlab");
  assert.throws(() => detectForge({ env: { GSD_LOOP_FORGE: "sourcehut" } }), UsageError);
  assert.ok(FORGES.has("github") && FORGES.has("gitlab"));
}

// ---- github backend(注入 run,argv 形状契约) ----
{
  const calls = [];
  const run = (program, argumentsList, options = {}) => {
    calls.push({ program, argumentsList, input: options.input });
    if (argumentsList[0] === "api" && argumentsList[1] === "user") {
      return { status: 0, stdout: "octocat\n", stderr: "" };
    }
    if (argumentsList[0] === "repo" && argumentsList[1] === "view") {
      return {
        status: 0,
        stdout: JSON.stringify({ nameWithOwner: "octocat/project", defaultBranchRef: { name: "main" } }),
        stderr: "",
      };
    }
    if (argumentsList[0] === "issue" && argumentsList[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 1, title: "A", labels: ["gsd:ready"], body: "", assignees: [], createdAt: "", url: "u1", state: "OPEN" },
          { number: 2, title: "B", labels: ["gsd:ready"], body: "", assignees: [{ login: "octocat" }], createdAt: "", url: "u2", state: "OPEN" },
        ]),
        stderr: "",
      };
    }
    if (argumentsList[0] === "pr" && argumentsList[1] === "checks") {
      if (argumentsList.includes("--required")) {
        return { status: 8, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "[]", stderr: "" };
    }
    if (argumentsList[0] === "label" && argumentsList[1] === "create") {
      if (argumentsList[2] === "gsd:ready") {
        return { status: 1, stdout: "", stderr: "label with name gsd:ready already exists" };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "[]", stderr: "" };
  };

  const forge = createForge({ forge: "github", repo: "octocat/project", run });
  assert.deepEqual(forge.repo(), { nameWithOwner: "octocat/project", defaultBranch: "main" });
  assert.equal(forge.whoami(), "octocat");

  // assignee none 是客户端过滤:两条里只留无指派的一条
  const issues = forge.issueList({ state: "open", label: "gsd:ready", assignee: "none" });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].number, 1);

  // prChecks 语义化退出码
  assert.deepEqual(forge.prChecks(9), { state: "pending", enforced: true, checks: [] });

  // ensure-labels 幂等:already exists 容忍,其余成功
  const labels = forge.ensureLabels([
    { name: "gsd:ready", color: "ededed" },
    { name: "gsd:blocked", color: "ededed" },
  ]);
  assert.deepEqual(labels.created, ["gsd:blocked"]);

  // argv 契约:pr list 保持 gh 形状
  forge.prList({ state: "open", label: "gsd:rework" });
  const prListCall = calls.find((c) => c.argumentsList.includes("pr") && c.argumentsList[1] === "list");
  assert.ok(prListCall.argumentsList.includes("--label") && prListCall.argumentsList.includes("gsd:rework"));
}

// prChecks 的 no-required-checks 与失败语义
{
  const run = (program, argumentsList) => {
    if (argumentsList[0] === "pr" && argumentsList[1] === "checks") {
      if (argumentsList.includes("--required") && argumentsList.includes("77")) {
        return { status: 1, stdout: "", stderr: "no required checks reported on the 'x' branch" };
      }
      if (argumentsList.includes("--required") && argumentsList.includes("78")) {
        return { status: 0, stdout: JSON.stringify([
          { bucket: "pass", name: "ci", state: "SUCCESS", link: "l" },
          { bucket: "failing", name: "e2e", state: "FAILURE", link: "l" },
        ]), stderr: "" };
      }
    }
    return { status: 0, stdout: "[]", stderr: "" };
  };
  const forge = createForge({ forge: "github", repo: "octocat/project", run });
  assert.deepEqual(forge.prChecks(77), { state: "none", enforced: false, checks: [] });
  assert.deepEqual(forge.prChecks(78).state, "failing");
}

// ---- gitlab backend(注入 run 模拟 curl) ----
{
  const gitlabResponses = (path) => {
    if (path === "/api/v4/user") {
      return { status: 200, payload: JSON.stringify({ username: "gluser" }) };
    }
    return { status: 200, payload: "[]" };
  };
  const run = (program, argumentsList) => {
    assert.equal(program, "curl");
    const url = argumentsList[argumentsList.length - 1];
    const tokenArg = argumentsList.find((a) => a.startsWith("PRIVATE-TOKEN"));
    assert.ok(tokenArg && tokenArg.includes("glpat-test"), "token must be sent");
    const response = gitlabResponses(url.replace(/^https:\/\/gitlab\.example/, ""));
    return { status: 0, stdout: `${response.payload}\n200`, stderr: "" };
  };
  const forge = createGitLabForge({
    cwd: "/tmp/project",
    repo: "group/project",
    run,
    env: { GITLAB_TOKEN: "glpat-test" },
    host: "gitlab.example",
  });
  assert.equal(forge.whoami(), "gluser");
}

// issue-edit --add-assignee @me:必须解析为 GET /user 的 id,而不是按用户名 "me" 搜项目成员
{
  const putBodies = [];
  const run = (program, argumentsList) => {
    assert.equal(program, "curl");
    const url = argumentsList[argumentsList.length - 1];
    const dataArg = argumentsList.find((a) => typeof a === "string" && a.startsWith("@"));
    if (dataArg) {
      putBodies.push(JSON.parse(readFileSync(dataArg.slice(1), "utf8")));
      return { status: 0, stdout: "\n200", stderr: "" };
    }
    if (url.endsWith("/api/v4/user")) {
      return { status: 0, stdout: `${JSON.stringify({ username: "gluser", id: 42 })}\n200`, stderr: "" };
    }
    if (url.includes("/issues/7")) {
      return {
        status: 0,
        stdout: `${JSON.stringify({ iid: 7, assignees: [{ username: "gluser", id: 42 }] })}\n200`,
        stderr: "",
      };
    }
    return { status: 0, stdout: "[]\n200", stderr: "" };
  };
  const forge = createGitLabForge({
    cwd: "/tmp/project", repo: "group/project", run,
    env: { GITLAB_TOKEN: "t" }, host: "gitlab.example",
  });
  forge.issueEdit(7, { addAssignee: "@me" });
  assert.deepEqual(putBodies.at(-1), { assignee_ids: [42] });
  // 无法解析的指派对象必须显式报错:认领静默 no-op 比失败更隐蔽
  assert.throws(() => forge.issueEdit(7, { addAssignee: "ghost" }), /could not resolve assignee/);
}

// 无 token 时明确报错(而不是崩在 curl)
{
  assert.throws(
    () => createGitLabForge({
      cwd: "/tmp/project",
      repo: "group/project",
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      env: {},
      host: "gitlab.example",
    }),
    /GITLAB_TOKEN/,
  );
}

// pr-linkage 描述解析(Closes/Fixes/Resolves/Linked-issue)
{
  const mrDescription = "Summary\n\nCloses #3\nFixes: #4\nresolves #5\nLinked-issue: #6";
  const run = (program, argumentsList) => {
    const url = argumentsList[argumentsList.length - 1];
    if (url.includes("/merge_requests/9")) {
      return {
        status: 0,
        stdout: `${JSON.stringify({ iid: 9, description: mrDescription, sha: "abc", source_branch: "gsd/9-x", target_branch: "main", author: { username: "gl" }, labels: [], web_url: "u" })}\n200`,
        stderr: "",
      };
    }
    return { status: 0, stdout: "[]\n200", stderr: "" };
  };
  const forge = createGitLabForge({
    cwd: "/tmp/project", repo: "group/project", run,
    env: { GITLAB_TOKEN: "t" }, host: "gitlab.example",
  });
  const linked = forge.prLinkage(9).map((entry) => entry.number);
  assert.deepEqual(linked.sort(), [3, 4, 5, 6]);
}

// pr-create 的 base 缺省 = 项目默认分支(gh 语义)
{
  const bodies = [];
  const run = (program, argumentsList) => {
    const url = argumentsList[argumentsList.length - 1];
    const dataArg = argumentsList.find((a) => typeof a === "string" && a.startsWith("@"));
    if (dataArg) {
      bodies.push({ url, payload: JSON.parse(readFileSync(dataArg.slice(1), "utf8")) });
      return { status: 0, stdout: `${JSON.stringify({ iid: 12, web_url: "u" })}\n200`, stderr: "" };
    }
    if (url.endsWith("/api/v4/projects/group%2Fproject")) {
      return { status: 0, stdout: `${JSON.stringify({ default_branch: "trunk" })}\n200`, stderr: "" };
    }
    return { status: 0, stdout: "null\n200", stderr: "" };
  };
  const forge = createGitLabForge({
    cwd: "/tmp/project", repo: "group/project", run,
    env: { GITLAB_TOKEN: "t" }, host: "gitlab.example",
  });
  forge.prCreate({ title: "T", body: "B", head: "gsd/7-x" });
  const post = bodies.at(-1);
  assert.equal(post.payload.target_branch, "trunk");
  assert.equal(post.payload.source_branch, "gsd/7-x");
}

// pr-edit 的标签增删:MR API 只认全量 labels,必须先读现值再合并/移除(gh 增删语义)
{
  const putPayloads = [];
  const run = (program, argumentsList) => {
    const url = argumentsList[argumentsList.length - 1];
    const dataArg = argumentsList.find((a) => typeof a === "string" && a.startsWith("@"));
    if (dataArg) {
      putPayloads.push(JSON.parse(readFileSync(dataArg.slice(1), "utf8")));
      return { status: 0, stdout: "\n200", stderr: "" };
    }
    if (url.includes("/merge_requests/3")) {
      return { status: 0, stdout: `${JSON.stringify({ iid: 3, labels: ["gsd:rework", "keep-me"] })}\n200`, stderr: "" };
    }
    return { status: 0, stdout: "null\n200", stderr: "" };
  };
  const forge = createGitLabForge({
    cwd: "/tmp/project", repo: "group/project", run,
    env: { GITLAB_TOKEN: "t" }, host: "gitlab.example",
  });
  forge.prEdit(3, { addLabels: ["gsd:escalated"], removeLabels: ["gsd:rework"] });
  assert.equal(putPayloads.at(-1).labels, "keep-me,gsd:escalated");
}

// ---- runForgeCli(分发与错误路径) ----
{
  assert.throws(() => runForgeCli({ argumentsList: ["nonsense-method"], env: { GSD_LOOP_FORGE: "github" } }), UsageError);
  assert.throws(
    () => runForgeCli({
      argumentsList: ["issue-create", "--title", "T", "--repo", "o/p"],
      env: { GSD_LOOP_FORGE: "github" },
      run: () => ({ status: 0, stdout: "[]", stderr: "" }),
    }),
    /--body/,
  );
  // issue-body 返回原始文本(非 JSON)
  const bodyText = runForgeCli({
    argumentsList: ["issue-body", "5", "--repo", "octocat/project"],
    env: { GSD_LOOP_FORGE: "github" },
    run: (program, argumentsList) => {
      if (argumentsList[0] === "issue" && argumentsList[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ body: "hello contract" }), stderr: "" };
      }
      return { status: 0, stdout: "null", stderr: "" };
    },
  });
  assert.equal(bodyText, "hello contract");
}

console.log("forge abstraction passed");
