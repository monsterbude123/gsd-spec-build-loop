import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlockedError, CliError } from "./errors.mjs";
import { parseJson, runProcess } from "./process.mjs";

// GitLab backend:REST API + curl(同步,与 github backend 的注入测试缝一致)。
// 认证:GITLAB_TOKEN 环境变量;实例地址:GITLAB_HOST 或从 origin remote URL 解析。
// GitLab 没有 user-content-edit 轨迹(并发检测降级为"写后读校验不一致即阻塞",
// 安全性保持:宁可阻塞也不静默继续),也没有 sub-issues/dependencies API(discover 环不可用)。

const PAGE_SIZE = 100;

function remoteUrl(cwd, run) {
  const runner = run ?? runProcess;
  const result = runner("git", ["remote", "get-url", "origin"], { cwd });
  if (result.status !== 0) {
    throw new BlockedError(`git remote get-url origin failed: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

// git@host:group/project.git 与 https://host/group/project.git 两种形态都支持。
export function parseRemote(value) {
  const withoutProtocol = value
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "");
  const [hostAndPort, ...pathParts] = withoutProtocol.split(/[:/]/);
  const path = pathParts.join("/");
  if (!hostAndPort || !path || !path.includes("/")) {
    throw new BlockedError(`could not parse git remote: ${value}`);
  }
  return { host: hostAndPort, owner: pathParts[0], name: pathParts.slice(1).join("/") };
}

function mapState(value) {
  if (value === "opened") return "OPEN";
  if (value === "merged") return "MERGED";
  if (value === "closed") return "CLOSED";
  return (value ?? "").toUpperCase();
}

const CLOSE_KEYWORD =
  /^\s*(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|linked[- ]?issue)\s*[:#]?\s*#(\d+)\b/gim;

function encodeProjectPath(repo) {
  return encodeURIComponent(repo);
}

export function createGitLabForge({ cwd, repo, run, env = process.env, host, token }) {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    throw new BlockedError("GitLab forge requires --repo OWNER/NAME");
  }
  const remoteParse = (() => {
    try {
      return parseRemote(remoteUrl(cwd, run));
    } catch {
      return null;
    }
  })();
  const resolvedHost = host ?? env.GITLAB_HOST ?? (() => {
    // 显式选了 gitlab 但 origin 不是 gitlab 主机时,host 静默落到错误主机是隐蔽故障
    // (请求打去别的 forge 只会收到 404);明确要求 GITLAB_HOST。
    if (remoteParse && /gitlab/i.test(remoteParse.host)) {
      return remoteParse.host;
    }
    throw new BlockedError(
      "GitLab forge could not resolve the instance host from origin; set GITLAB_HOST (e.g. GITLAB_HOST=gitlab.example.com, optional http:// scheme for self-hosted HTTP)",
    );
  })();
  const resolvedToken = token ?? env.GITLAB_TOKEN;
  if (!resolvedToken) {
    throw new BlockedError(
      "GitLab forge requires GITLAB_TOKEN (create a project/group access token with api scope)",
    );
  }
  const project = encodeProjectPath(repo);
  // GITLAB_HOST 可带协议(http://host[:port],自托管常见);默认 https。
  const base = /^https?:\/\//i.test(resolvedHost)
    ? `${resolvedHost.replace(/\/+$/, "")}/api/v4`
    : `https://${resolvedHost}/api/v4`;

  // 同步 REST:curl + PRIVATE-TOKEN。末行附 http 状态码,>=400 抛 CliError(带响应片段)。
  // JSON 载荷走临时文件(--data @file)而非 argv:Windows curl 的 argv 会按本地代码页
  // (如 GBK)重编码非 ASCII 字符,UTF-8 JSON 会被打碎成 400;文件路径是 ASCII,字节原样。
  function request(method, path, { body, raw } = {}) {
    const argumentsList = [
      "-sS",
      "-w", "\n%{http_code}",
      "--request", method,
      "--header", `PRIVATE-TOKEN: ${resolvedToken}`,
      "--header", "Content-Type: application/json",
    ];
    let payloadFile = null;
    if (body !== undefined) {
      payloadFile = join(mkdtempSync(join(tmpdir(), "gsd-loop-gitlab-")), "payload.json");
      writeFileSync(payloadFile, JSON.stringify(body), "utf8");
      argumentsList.push("--data", `@${payloadFile}`);
    }
    argumentsList.push(`${base}${path}`);
    let result;
    try {
      result = (run ?? runProcess)("curl", argumentsList, { cwd });
    } finally {
      if (payloadFile) {
        rmSync(payloadFile, { force: true });
        // 目录里的临时文件已删;目录本身留给 OS 临时清理,避免删除竞态。
      }
    }
    if (result.status !== 0) {
      throw new CliError(`curl ${method} ${path} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
    }
    const output = result.stdout ?? "";
    const separator = output.lastIndexOf("\n");
    const status = Number(output.slice(separator + 1).trim());
    const payload = output.slice(0, separator);
    if (status >= 400) {
      throw new CliError(`GitLab ${method} ${path} failed: HTTP ${status} ${payload.slice(0, 300)}`);
    }
    if (raw) {
      return { status, payload };
    }
    return status === 204 ? null : parseJson(payload || "null", `GitLab ${method} ${path}`);
  }

  function paged(path) {
    const entries = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const batch = request("GET", `${path}${separator}per_page=${PAGE_SIZE}&page=${page}`);
      entries.push(...batch);
      if (!Array.isArray(batch) || batch.length < PAGE_SIZE) break;
    }
    return entries;
  }

  function labelByname(name) {
    const labels = paged(`/projects/${project}/labels?search=${encodeURIComponent(name)}`);
    return labels.find((label) => label.name === name) ?? null;
  }

  return {
    kind: "gitlab",

    repo() {
      const payload = request("GET", `/projects/${project}`);
      return {
        nameWithOwner: payload.path_with_namespace ?? repo,
        defaultBranch: payload.default_branch ?? "main",
      };
    },

    whoami() {
      return request("GET", "/user").username;
    },

    ensureLabels(labels) {
      const created = [];
      for (const label of labels) {
        if (labelByname(label.name)) continue;
        request("POST", `/projects/${project}/labels`, {
          body: {
            name: label.name,
            color: `#${(label.color ?? "ededed").replace(/^#/, "")}`,
            ...(label.description ? { description: label.description } : {}),
          },
        });
        created.push(label.name);
      }
      return { created };
    },

    issueList({ state = "open", label, assignee, limit = 200 } = {}) {
      const params = new URLSearchParams({
        state: state === "all" ? "all" : "opened",
        order_by: "created_at",
        sort: "asc",
      });
      if (label) params.set("labels", label);
      // GitLab 无 "none" 服务端过滤;@me 走 assignee_username,均可在客户端兜底。
      if (assignee && assignee !== "none" && assignee !== "@me") {
        params.set("assignee_username", assignee.replace(/^@/, ""));
      }
      let issues = paged(`/projects/${project}/issues?${params}`)
        .slice(0, limit)
        .map((entry) => ({
          number: entry.iid,
          title: entry.title ?? "",
          state: mapState(entry.state),
          labels: entry.labels ?? [],
          body: entry.description ?? "",
          assignees: (entry.assignees ?? []).map((user) => user.username),
          createdAt: entry.created_at ?? null,
          url: entry.web_url ?? "",
        }));
      if (assignee === "none") {
        issues = issues.filter((issue) => issue.assignees.length === 0);
      }
      if (assignee === "@me") {
        const me = this.whoami();
        issues = issues.filter((issue) => issue.assignees.includes(me));
      }
      return issues;
    },

    issueView(number) {
      const entry = request("GET", `/projects/${project}/issues/${number}`);
      return {
        number: entry.iid,
        title: entry.title ?? "",
        state: mapState(entry.state),
        labels: entry.labels ?? [],
        body: entry.description ?? "",
        assignees: (entry.assignees ?? []).map((user) => user.username),
        createdAt: entry.created_at ?? null,
        url: entry.web_url ?? "",
        // GitLab 没有 closingIssuesReferences;由 forge.prLinkage 的描述解析补位。
        closedByPullRequestsReferences: [],
      };
    },

    issueBody(number) {
      const entry = request("GET", `/projects/${project}/issues/${number}`);
      if (typeof entry.description !== "string") {
        throw new BlockedError(`issue #${number} has no readable body`);
      }
      return entry.description;
    },

    issueCreate({ title, body }) {
      const entry = request("POST", `/projects/${project}/issues`, {
        body: { title, description: body ?? "" },
      });
      return { number: entry.iid, url: entry.web_url };
    },

    issueEdit(number, { addAssignee, removeAssignee, addLabels, removeLabels } = {}) {
      const body = {};
      if (addAssignee) {
        const users = request(
          "GET",
          `/projects/${project}/users?search=${encodeURIComponent(addAssignee.replace(/^@/, ""))}`,
        );
        // assignee_ids 是全量替换语义:先读现有指派,再合并/移除。
        const current = request("GET", `/projects/${project}/issues/${number}`);
        const currentIds = (current.assignees ?? []).map((user) => user.id);
        if (removeAssignee) {
          const removeId = users.find((user) => user.username === removeAssignee.replace(/^@/, ""))?.id;
          body.assignee_ids = currentIds.filter((id) => id !== removeId);
        } else {
          const addId = users[0]?.id;
          body.assignee_ids = addId && !currentIds.includes(addId) ? [...currentIds, addId] : currentIds;
        }
      } else if (removeAssignee) {
        const current = request("GET", `/projects/${project}/issues/${number}`);
        const target = (current.assignees ?? []).find(
          (user) => user.username === removeAssignee.replace(/^@/, ""),
        );
        const currentIds = (current.assignees ?? []).map((user) => user.id);
        body.assignee_ids = target ? currentIds.filter((id) => id !== target.id) : currentIds;
      }
      if (addLabels?.length) body.add_labels = addLabels.join(",");
      if (removeLabels?.length) body.remove_labels = removeLabels.join(",");
      if (Object.keys(body).length) {
        request("PUT", `/projects/${project}/issues/${number}`, { body });
      }
      return { number };
    },

    issueBodyEdit(number, body) {
      request("PUT", `/projects/${project}/issues/${number}`, { body: { description: body } });
      return { number };
    },

    issueComment(number, { body }) {
      request("POST", `/projects/${project}/issues/${number}/notes`, { body: { body } });
      return { number };
    },

    issueComments(number) {
      return paged(`/projects/${project}/issues/${number}/notes?sort=asc&order_by=created_at`)
        .filter((note) => !note.system)
        .map((note) => ({
          author: { login: note.author?.username ?? "" },
          body: note.body ?? "",
          isMinimized: false,
        }));
    },

    prList({ state = "open", label, head, limit = 200 } = {}) {
      const params = new URLSearchParams({
        state: state === "all" ? "all" : "opened",
        order_by: "created_at",
        sort: "asc",
        with_merge_status_recheck: "true",
      });
      if (label) params.set("labels", label);
      if (head) params.set("source_branch", head);
      return paged(`/projects/${project}/merge_requests?${params}`)
        .slice(0, limit)
        .map((entry) => this._normalizeMergeRequest(entry));
    },

    _normalizeMergeRequest(entry) {
      const status = entry.detailed_merge_status ?? entry.merge_status ?? "";
      return {
        number: entry.iid,
        title: entry.title ?? "",
        state: mapState(entry.state),
        labels: entry.labels ?? [],
        isDraft: Boolean(entry.draft) || /^(draft|wip)[:\s]/i.test(entry.title ?? ""),
        headRefName: entry.source_branch ?? "",
        headRefOid: entry.sha ?? "",
        updatedAt: entry.updated_at ?? null,
        url: entry.web_url ?? "",
        mergeable: status === "mergeable" ? "MERGEABLE" : status === "conflicts" ? "CONFLICTING" : "UNKNOWN",
        mergeStateStatus: status,
        baseRefOid: entry.diff_refs?.base_sha ?? "",
        body: entry.description ?? "",
      };
    },

    prView(number, { fields } = {}) {
      void fields;
      return this._normalizeMergeRequest(
        request("GET", `/projects/${project}/merge_requests/${number}`),
      );
    },

    prCreate({ title, body, head, base }) {
      if (!head || !base) {
        throw new BlockedError("GitLab pr-create requires both head and base branches");
      }
      const entry = request("POST", `/projects/${project}/merge_requests`, {
        body: {
          source_branch: head,
          target_branch: base,
          title,
          description: body ?? "",
        },
      });
      return { number: entry.iid, url: entry.web_url };
    },

    prComment(number, { body }) {
      request("POST", `/projects/${project}/merge_requests/${number}/notes`, { body: { body } });
      return { number };
    },

    prEdit(number, { removeLabels, body } = {}) {
      const payload = {};
      if (removeLabels?.length) payload.remove_labels = removeLabels.join(",");
      if (body !== undefined) payload.description = body;
      if (Object.keys(payload).length) {
        request("PUT", `/projects/${project}/merge_requests/${number}`, { body: payload });
      }
      return { number };
    },

    // 作者承载的评论轨迹;GitLab notes 无 minimized 概念,恒为 false。
    prComments(number) {
      return paged(`/projects/${project}/merge_requests/${number}/notes?sort=asc&order_by=created_at`)
        .filter((note) => !note.system)
        .map((note) => ({
          author: { login: note.author?.username ?? "" },
          body: note.body ?? "",
          isMinimized: false,
        }));
    },

    // review.md 的 PR_EVIDENCE 投影。
    prEvidence(number) {
      const entry = request("GET", `/projects/${project}/merge_requests/${number}`);
      return {
        author: { login: entry.author?.username ?? "" },
        body: entry.description ?? "",
        baseRefOid: entry.diff_refs?.base_sha ?? "",
        headRefOid: entry.sha ?? "",
        comments: this.prComments(number),
      };
    },

    prFiles(number) {
      return paged(`/projects/${project}/merge_requests/${number}/diffs?per_page=${PAGE_SIZE}`)
        .map((diff) => diff.new_path);
    },

    // GitLab 的"必需 CI"= 项目设置 pipelines_must_succeed + head pipeline 状态。
    prChecks(number) {
      const entry = request("GET", `/projects/${project}/merge_requests/${number}`);
      const projectPayload = request("GET", `/projects/${project}`);
      const enforced = Boolean(projectPayload.only_allow_merge_if_pipeline_succeeds);
      const pipelineStatus = entry.head_pipeline?.status;
      if (!enforced || !pipelineStatus) {
        return { state: "none", enforced: false, checks: [] };
      }
      const state = pipelineStatus === "success"
        ? "passing"
        : ["running", "pending", "created", "waiting_for_resource", "preparing"].includes(pipelineStatus)
          ? "pending"
          : "failing";
      return {
        state,
        enforced: true,
        checks: [{ name: `pipeline:${pipelineStatus}`, state, bucket: state }],
      };
    },

    prMergeState(number) {
      const entry = request("GET", `/projects/${project}/merge_requests/${number}`);
      const normalized = this._normalizeMergeRequest(entry);
      return {
        headRefOid: normalized.headRefOid,
        mergeable: normalized.mergeable,
        mergeStateStatus: normalized.mergeStateStatus,
      };
    },

    // GitLab 在 MR 合并时按描述里的 close 关键字关 issue;此处做同样的解析,
    // 关键字集合与 lib/outcomes.mjs 的 fallbackClosingIssues 保持一致,外加 Linked-issue。
    prLinkage(number) {
      const entry = request("GET", `/projects/${project}/merge_requests/${number}`);
      const body = entry.description ?? "";
      const numbers = new Set();
      for (const match of body.matchAll(CLOSE_KEYWORD)) {
        numbers.add(Number(match[1]));
      }
      return [...numbers].map((issueNumber) => ({ number: issueNumber, repository: repo }));
    },

    pullRequestBodyEvidence(number) {
      const entry = request("GET", `/projects/${project}/merge_requests/${number}`);
      return {
        id: String(entry.iid),
        headRefOid: entry.sha ?? "",
        body: entry.description ?? "",
        editCount: 0,
        editBodies: [],
      };
    },

    pullRequestBodyUpdate({ id, body }) {
      const entry = request("PUT", `/projects/${project}/merge_requests/${id}`, {
        body: { description: body },
      });
      return {
        id: String(entry.iid),
        headRefOid: entry.sha ?? "",
        body: entry.description ?? "",
        editCount: 0,
        editBodies: [],
      };
    },
  };
}
