import { BlockedError, CliError } from "./errors.mjs";
import { checked, parseJson, runProcess } from "./process.mjs";

// GitHub backend 的 gh argv 与历史实现逐字节兼容:
// tests/linkage_test.mjs / tests/outcomes_test.mjs 通过 PATH 上的假 gh 或注入 run
// 按 argv 形状拦截调用,改动任何一处 argv 都会让既有测试失真。

const PR_COMMENTS_PAGE_SIZE = 100;

const PR_EVIDENCE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        author { login }
        body
        baseRefOid
        headRefOid
        comments(first: ${PR_COMMENTS_PAGE_SIZE}, after: $endCursor) {
          nodes { author { login } body isMinimized }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const PR_BODY_EVIDENCE_QUERY = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id
        headRefOid
        body
        userContentEdits(last: 2) {
          totalCount
          nodes {
            diff
          }
        }
      }
    }
  }
`;

const PR_BODY_UPDATE_MUTATION = `
  mutation($pullRequestId: ID!, $body: String!) {
    updatePullRequest(input: {pullRequestId: $pullRequestId, body: $body}) {
      pullRequest {
        id
        headRefOid
        body
        userContentEdits(last: 2) {
          totalCount
          nodes {
            diff
          }
        }
      }
    }
  }
`;

const ISSUE_FIELDS = "number,title,labels,body,assignees,createdAt,url,state";
const PR_FIELDS =
  "number,title,labels,isDraft,headRefName,headRefOid,updatedAt,url,state";

function labelsOf(entry) {
  if (Array.isArray(entry?.labels)) {
    return entry.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
  }
  return [];
}

function assigneesOf(entry) {
  if (Array.isArray(entry?.assignees)) {
    return entry.assignees
      .map((assignee) => assignee?.login ?? assignee)
      .filter((value) => typeof value === "string" && value.length);
  }
  return [];
}

function normalizeIssue(entry) {
  return {
    number: entry.number,
    title: entry.title ?? "",
    state: entry.state ?? "OPEN",
    labels: labelsOf(entry),
    body: entry.body ?? "",
    assignees: assigneesOf(entry),
    createdAt: entry.createdAt ?? null,
    url: entry.url ?? "",
  };
}

function normalizePullRequest(entry) {
  return {
    number: entry.number,
    title: entry.title ?? "",
    state: entry.state ?? "OPEN",
    labels: labelsOf(entry),
    isDraft: Boolean(entry.isDraft),
    headRefName: entry.headRefName ?? "",
    headRefOid: entry.headRefOid ?? "",
    updatedAt: entry.updatedAt ?? null,
    url: entry.url ?? "",
  };
}

function graphQlPullRequest(output, description) {
  const payload = parseJson(output, description);
  if (payload?.errors?.length) {
    const first = payload.errors[0];
    throw new BlockedError(`${description}: ${first?.message ?? "GraphQL error"}`);
  }
  return payload?.data?.repository?.pullRequest;
}

export function createGitHubForge({ cwd, repo, run }) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new BlockedError("GitHub forge requires --repo OWNER/NAME");
  }
  function gh(argumentsList, options = {}) {
    return checked("gh", argumentsList, { cwd, run, ...options });
  }

  return {
    kind: "github",

    repo() {
      const output = gh([
        "repo", "view",
        "--repo", repo,
        "--json", "nameWithOwner,defaultBranchRef",
      ]);
      const payload = parseJson(output, `repository ${repo}`);
      return {
        nameWithOwner: payload.nameWithOwner ?? repo,
        defaultBranch: payload.defaultBranchRef?.name ?? "main",
      };
    },

    whoami() {
      return gh(["api", "user", "--jq", ".login"]);
    },

    ensureLabels(labels) {
      const created = [];
      for (const label of labels) {
        const argumentsList = [
          "label", "create", label.name,
          "--repo", repo,
          "--color", label.color ?? "ededed",
        ];
        if (label.description) {
          argumentsList.push("--description", label.description);
        }
        try {
          gh(argumentsList);
          created.push(label.name);
        } catch (error) {
          // "already exists" 是幂等语义内的预期失败;认证/权限/网络失败必须上抛。
          if (!/already exists/i.test(error.message ?? "")) {
            throw error;
          }
        }
      }
      return { created };
    },

    issueList({ state = "open", label, assignee, limit = 200 } = {}) {
      const argumentsList = ["issue", "list", "--repo", repo, "--state", state, "--limit", String(limit)];
      if (label) argumentsList.push("--label", label);
      // --assignee @me 是服务端过滤;unassigned 是客户端过滤(索引滞后,见 build.md)。
      if (assignee && assignee !== "none") argumentsList.push("--assignee", assignee);
      const output = gh([...argumentsList, "--json", ISSUE_FIELDS]);
      const entries = parseJson(output, "issue list");
      let issues = entries.map(normalizeIssue);
      if (assignee === "none") {
        issues = issues.filter((issue) => issue.assignees.length === 0);
      }
      return issues;
    },

    issueView(number) {
      const output = gh([
        "issue", "view", String(number),
        "--repo", repo,
        "--json", `${ISSUE_FIELDS},closedByPullRequestsReferences`,
      ]);
      const entry = parseJson(output, `issue #${number}`);
      return {
        ...normalizeIssue(entry),
        closedByPullRequestsReferences: (entry.closedByPullRequestsReferences ?? []).map((reference) => ({
          number: reference.number,
          repository: reference.repository?.nameWithOwner ?? null,
          state: reference.state ?? null,
        })),
      };
    },

    issueBody(number) {
      const output = gh([
        "issue", "view", String(number),
        "--repo", repo,
        "--json", "body",
      ]);
      const result = parseJson(output, `issue #${number}`);
      if (typeof result.body !== "string") {
        throw new BlockedError(`issue #${number} has no readable body`);
      }
      return result.body;
    },

    issueCreate({ title, body }) {
      const output = gh([
        "issue", "create",
        "--repo", repo,
        "--title", title,
        "--body-file", "-",
      ], { input: body });
      // gh issue create 把 URL 打到 stdout;数字就在 URL 末尾。
      const match = output.match(/\/issues\/(\d+)\s*$/);
      if (!match) {
        throw new BlockedError(`issue create returned no issue URL: ${output}`);
      }
      return { number: Number(match[1]), url: output.trim() };
    },

    issueEdit(number, { addAssignee, removeAssignee, addLabels, removeLabels } = {}) {
      const argumentsList = ["issue", "edit", String(number), "--repo", repo];
      if (addAssignee) argumentsList.push("--add-assignee", addAssignee);
      if (removeAssignee) argumentsList.push("--remove-assignee", removeAssignee);
      for (const label of addLabels ?? []) argumentsList.push("--add-label", label);
      for (const label of removeLabels ?? []) argumentsList.push("--remove-label", label);
      gh(argumentsList);
      return { number };
    },

    issueBodyEdit(number, body) {
      gh([
        "issue", "edit", String(number),
        "--repo", repo,
        "--body-file", "-",
      ], { input: body });
      return { number };
    },

    issueComment(number, { body }) {
      gh(["issue", "comment", String(number), "--repo", repo, "--body-file", "-"], { input: body });
      return { number };
    },

    issueComments(number) {
      const output = gh([
        "api", "--paginate", "--slurp",
        `repos/${repo}/issues/${number}/comments?per_page=100`,
      ]);
      const pages = parseJson(output, `issue #${number} comments`);
      const comments = [];
      for (const page of Array.isArray(pages) ? pages : [pages]) {
        for (const entry of Array.isArray(page) ? page : [page]) {
          comments.push({
            author: { login: entry?.user?.login ?? "" },
            body: entry?.body ?? "",
            isMinimized: false,
          });
        }
      }
      return comments;
    },

    prList({ state = "open", label, head, limit = 200 } = {}) {
      const argumentsList = ["pr", "list", "--repo", repo, "--state", state, "--limit", String(limit)];
      if (label) argumentsList.push("--label", label);
      if (head) argumentsList.push("--head", head);
      const output = gh([...argumentsList, "--json", PR_FIELDS]);
      return parseJson(output, "pr list").map(normalizePullRequest);
    },

    prView(number, { fields } = {}) {
      const output = gh([
        "pr", "view", String(number),
        "--repo", repo,
        "--json", fields ?? "headRefOid,body,closingIssuesReferences",
      ]);
      return parseJson(output, `PR #${number}`);
    },

    prCreate({ title, body, head, base }) {
      const argumentsList = [
        "pr", "create",
        "--repo", repo,
        "--title", title,
        "--body-file", "-",
        "--head", head,
      ];
      if (base) argumentsList.push("--base", base);
      const output = gh(argumentsList, { input: body });
      const match = output.match(/\/pull\/(\d+)/);
      if (!match) {
        throw new BlockedError(`pr create returned no PR URL: ${output}`);
      }
      return { number: Number(match[1]), url: output.trim() };
    },

    prComment(number, { body }) {
      gh(["pr", "comment", String(number), "--repo", repo, "--body-file", "-"], { input: body });
      return { number };
    },

    prEdit(number, { removeLabels, body } = {}) {
      const argumentsList = ["pr", "edit", String(number), "--repo", repo];
      for (const label of removeLabels ?? []) argumentsList.push("--remove-label", label);
      if (body !== undefined) argumentsList.push("--body-file", "-");
      gh(argumentsList, body !== undefined ? { input: body } : {});
      return { number };
    },

    // --paginate 对 GraphQL 自动注入 endCursor(见 review.md 原始调用),手动再传会冲突;
    // --slurp 把全部页合并成页数组返回,这里逐页摊平。
    prPages(number) {
      const [owner, name] = repo.split("/");
      const output = gh([
        "api", "graphql",
        "--paginate", "--slurp",
        "-f", `query=${PR_EVIDENCE_QUERY}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`,
        "-F", `number=${number}`,
      ]);
      const pages = parseJson(output, `PR #${number} evidence`);
      if (!Array.isArray(pages)) {
        throw new BlockedError(`PR #${number} evidence did not return a page array`);
      }
      return pages;
    },

    // 作者承载的评论轨迹(与 review.md 的 PR_EVIDENCE 投影一致)。
    prComments(number) {
      const comments = [];
      for (const page of this.prPages(number)) {
        const pullRequest = page?.data?.repository?.pullRequest;
        if (pullRequest) comments.push(...(pullRequest.comments?.nodes ?? []));
      }
      return comments;
    },

    // review.md 的 PR_EVIDENCE 投影:作者、正文、base/head SHA、全量评论。
    prEvidence(number) {
      let author = null;
      let body = "";
      let baseRefOid = "";
      let headRefOid = "";
      const comments = [];
      for (const page of this.prPages(number)) {
        const pullRequest = page?.data?.repository?.pullRequest;
        if (!pullRequest) continue;
        author = pullRequest.author ?? author;
        body = pullRequest.body ?? body;
        baseRefOid = pullRequest.baseRefOid ?? baseRefOid;
        headRefOid = pullRequest.headRefOid ?? headRefOid;
        comments.push(...(pullRequest.comments?.nodes ?? []));
      }
      if (!headRefOid) {
        throw new BlockedError(`PR #${number} evidence has no readable head`);
      }
      return { author, body, baseRefOid, headRefOid, comments };
    },

    prFiles(number) {
      const output = gh([
        "pr", "view", String(number),
        "--repo", repo,
        "--json", "files",
      ]);
      const payload = parseJson(output, `PR #${number} files`);
      return (payload.files ?? []).map((file) => file.path);
    },

    // 语义化退出码(与 review.md 契约一致):
    // exit 8 = 检查仍在跑;exit 1 + "no required checks reported" = 仓库未配置必需检查。
    // 需要原始 status,不能走 checked()(它把非零一律当失败抛出)。
    prChecks(number) {
      const runner = run ?? runProcess;
      const raw = runner("gh", [
        "pr", "checks", String(number),
        "--repo", repo,
        "--required",
        "--json", "bucket,name,state,link",
      ], { cwd });
      if (raw.status === 8) {
        return { state: "pending", enforced: true, checks: [] };
      }
      if (raw.status === 1 && /no (required )?checks reported/i.test(raw.stderr ?? "")) {
        return { state: "none", enforced: false, checks: [] };
      }
      if (raw.status !== 0) {
        const detail = (raw.stderr ?? "").trim() || (raw.stdout ?? "").trim() || `exit ${raw.status}`;
        throw new CliError(`gh pr checks ${number} --repo ${repo} failed: ${detail}`);
      }
      const checks = parseJson(raw.stdout ?? "[]", `PR #${number} checks`);
      const buckets = checks.map((check) => check.bucket);
      const state = buckets.includes("pending")
        ? "pending"
        : buckets.includes("failing")
          ? "failing"
          : "passing";
      return { state, enforced: true, checks };
    },

    prMergeState(number) {
      const output = gh([
        "pr", "view", String(number),
        "--repo", repo,
        "--json", "headRefOid,mergeable,mergeStateStatus",
      ]);
      return parseJson(output, `PR #${number} merge state`);
    },

    prLinkage(number) {
      const output = gh([
        "pr", "view", String(number),
        "--repo", repo,
        "--json", "closingIssuesReferences",
      ]);
      const payload = parseJson(output, `PR #${number} linkage`);
      return (payload.closingIssuesReferences ?? []).map((reference) => ({
        number: reference.number,
        repository: reference.repository?.nameWithOwner ?? null,
      }));
    },

    // linkage.mjs 专用:PR 正文证据(id + head + body + 用户内容编辑轨迹)。
    pullRequestBodyEvidence(number) {
      const [owner, name] = repo.split("/");
      const output = gh([
        "api", "graphql",
        "-f", `query=${PR_BODY_EVIDENCE_QUERY}`,
        "-f", `owner=${owner}`,
        "-f", `name=${name}`,
        "-F", `number=${number}`,
      ]);
      const pullRequest = graphQlPullRequest(output, `PR #${number}`);
      if (
        typeof pullRequest?.id !== "string"
        || typeof pullRequest.headRefOid !== "string"
        || typeof pullRequest.body !== "string"
        || !Number.isInteger(pullRequest.userContentEdits?.totalCount)
        || !Array.isArray(pullRequest.userContentEdits.nodes)
        || pullRequest.userContentEdits.nodes.some((edit) => typeof edit?.diff !== "string")
      ) {
        throw new BlockedError(`PR #${number} has no readable linkage evidence`);
      }
      return {
        id: pullRequest.id,
        headRefOid: pullRequest.headRefOid,
        body: pullRequest.body,
        editCount: pullRequest.userContentEdits.totalCount,
        editBodies: pullRequest.userContentEdits.nodes.map((edit) => edit.diff),
      };
    },

    // 调用方(linkage.mjs)持有上次证据里的 id,直接传进来 —— 内部不得重新 fetch,
    // 否则 editCount 并发追踪基线漂移,假 gh 测试也会多看到一次 query 调用。
    pullRequestBodyUpdate({ id, body }) {
      const output = gh([
        "api", "graphql",
        "-f", `query=${PR_BODY_UPDATE_MUTATION}`,
        "-f", `pullRequestId=${id}`,
        "-f", `body=${body}`,
      ]);
      const pullRequest = graphQlPullRequest(output, "PR update");
      if (
        typeof pullRequest?.id !== "string"
        || typeof pullRequest.headRefOid !== "string"
        || typeof pullRequest.body !== "string"
      ) {
        throw new BlockedError("PR update returned no readable evidence");
      }
      return {
        id: pullRequest.id,
        headRefOid: pullRequest.headRefOid,
        body: pullRequest.body,
        editCount: pullRequest.userContentEdits?.totalCount ?? 0,
        editBodies: (pullRequest.userContentEdits?.nodes ?? []).map((edit) => edit.diff),
      };
    },
  };
}
