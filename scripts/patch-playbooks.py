import io

def patch(path, pairs):
    s = io.open(path, encoding="utf-8", newline="").read()
    # 行尾自适应:文件是 CRLF 时把 old/new 里的 \n 全部转成 \r\n 再匹配。
    crlf = "\r\n" in s
    def adapt(t):
        return t.replace("\n", "\r\n") if crlf else t
    for old, new, count in pairs:
        old_a, new_a = adapt(old), adapt(new)
        found = s.count(old_a)
        if found == 0 and count == 1:
            print(f"  skip (already applied): {old[:50]!r}")
            continue
        assert found == count, f"{path}: expected {count} of {old[:60]!r}, found {found} (crlf={crlf})"
        s = s.replace(old_a, new_a)
    io.open(path, "w", encoding="utf-8", newline="").write(s)
    print(f"patched {path} ({len(pairs)} rules, crlf={crlf})")

LABELS_OLD = """for l in gsd:ready gsd:blocked gsd:approved gsd:rework gsd:escalated; do
  gh label create "$l" --color ededed 2>/dev/null || true
done"""
LABELS_NEW = """node FORGE ensure-labels \\
  --labels gsd:ready --labels gsd:blocked --labels gsd:approved \\
  --labels gsd:rework --labels gsd:escalated \\
  --repo OWNER/NAME"""

# ---------------- spec.md ----------------
patch("loop/spec.md", [
    (
        "- Verify which repository you're filing into: `gh repo view --json nameWithOwner`.",
        "- Verify which repository you're filing into: `node FORGE repo --repo OWNER/NAME`\n"
        "  (returns `nameWithOwner` and `defaultBranch`).",
        1,
    ),
    (LABELS_OLD, LABELS_NEW, 1),
    (
        'gh issue create --title "TITLE" --body-file /path/to/draft.md',
        'node FORGE issue-create --title "TITLE" --body-file /path/to/draft.md --repo OWNER/NAME',
        1,
    ),
])

# ---------------- build.md ----------------
patch("loop/build.md", [
    (
        "- Confirm the repo (`gh repo view --json nameWithOwner`) and that `origin`\n"
        "  answers.\n"
        "- Look up the default branch —\n"
        "  `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` — and\n"
        "  use what it says, whatever it says.",
        "- Confirm the repo (`node FORGE repo --repo OWNER/NAME`) and that `origin`\n"
        "  answers.\n"
        "- Look up the default branch —\n"
        "  `node FORGE repo --repo OWNER/NAME` returns `defaultBranch` — and\n"
        "  use what it says, whatever it says.",
        1,
    ),
    (LABELS_OLD, LABELS_NEW, 1),
    (
        "(`gh pr list --head BRANCH --state all --json number,state`)",
        "(`node FORGE pr-list --head BRANCH --state all --repo OWNER/NAME`)",
        1,
    ),
    (
        'gh issue list --state open --label gsd:ready --assignee "@me" --limit 200 \\\n'
        '    --json number,closedByPullRequestsReferences',
        "node FORGE issue-list --state open --label gsd:ready --assignee @me \\\n"
        "  --repo OWNER/NAME",
        1,
    ),
    (
        "unassign\n"
        "  (`gh issue edit NUMBER --remove-assignee @me`) so the queue reclaims it.",
        "unassign\n"
        "  (`node FORGE issue-edit NUMBER --remove-assignee @me --repo OWNER/NAME`)\n"
        "  so the queue reclaims it.",
        1,
    ),
    (
        'gh pr list --state open --label gsd:rework --limit 200 \\\n'
        '  --json number,title,headRefName,headRefOid,labels,updatedAt,url',
        "node FORGE pr-list --state open --label gsd:rework --repo OWNER/NAME",
        1,
    ),
    (
        'REVIEWER_LOGIN=$(gh api user --jq .login)\n'
        'ISSUE=LINKED_ISSUE\n'
        'gh pr view NUMBER --json headRefOid --jq .headRefOid\n'
        'REVIEWER_LOGIN="$REVIEWER_LOGIN" ISSUE="$ISSUE" \\\n'
        '  gh api --paginate --slurp \\\n'
        '  "repos/OWNER/REPO/issues/NUMBER/comments?per_page=100" \\\n'
        "  --jq '[.[][] | select(.user.login == env.REVIEWER_LOGIN and ((.body | split(\"\\n\")[0]) | startswith(\"gsd-loop verdict for \")) and ((.body | split(\"\\n\")[0]) | endswith(\" issue #\" + env.ISSUE)))] | last'",
        'REVIEWER_LOGIN=$(node FORGE whoami --repo OWNER/REPO)\n'
        'ISSUE=LINKED_ISSUE\n'
        'node FORGE pr-view NUMBER --repo OWNER/REPO | jq -r .headRefOid\n'
        'REVIEWER_LOGIN="$REVIEWER_LOGIN" ISSUE="$ISSUE" \\\n'
        '  node FORGE pr-comments NUMBER --repo OWNER/REPO | jq \\\n'
        '  --arg reviewer "$REVIEWER_LOGIN" --arg issue "$ISSUE" \\\n'
        "  '[.[] | select(.author.login == $reviewer and ((.body | split(\"\\n\")[0]) | startswith(\"gsd-loop verdict for \")) and ((.body | split(\"\\n\")[0]) | endswith(\" issue #\" + $issue)))] | last'",
        1,
    ),
    (
        'gh issue list --state open --label gsd:ready --limit 200 \\\n'
        '  --json number,title,labels,body,assignees,createdAt,url \\\n'
        "  --jq '[.[] | select(.assignees | length == 0)]'",
        "node FORGE issue-list --state open --label gsd:ready --assignee none \\\n"
        "  --repo OWNER/NAME",
        1,
    ),
    (
        "(The unassigned filter is client-side on purpose — `--search \"no:assignee\"`\n"
        "rides a lagging index and can miss an issue you unassigned seconds ago.)",
        "(The unassigned filter is client-side on purpose — forge-side \"no assignee\"\n"
        "searches ride a lagging index and can miss an issue you unassigned seconds ago.)",
        1,
    ),
    (
        "(`gh issue view N --json state,closedByPullRequestsReferences`)",
        "(`node FORGE issue-view N --repo OWNER/NAME`)",
        1,
    ),
    (
        "gh issue edit NUMBER --add-assignee @me",
        "node FORGE issue-edit NUMBER --add-assignee @me --repo OWNER/NAME",
        1,
    ),
    (
        "`gh issue view NUMBER --comments` for the full body and discussion.",
        "`node FORGE issue-view NUMBER --repo OWNER/NAME` for the body plus\n"
        "`node FORGE issue-comments NUMBER --repo OWNER/NAME` for the discussion.",
        1,
    ),
    (
        "run `gh pr create --body-file`\n"
        "there with a compact body containing:",
        "run `node FORGE pr-create --title \"...\" --body-file /path/to/body.md \\\n"
        "  --head gsd/NNN-short-slug --repo OWNER/NAME` there with a compact body containing:",
        1,
    ),
    (
        'gh issue comment NUMBER --body "..."\n'
        'gh issue edit NUMBER --add-label gsd:blocked --remove-assignee @me',
        'node FORGE issue-comment NUMBER --body "..." --repo OWNER/NAME\n'
        'node FORGE issue-edit NUMBER --add-label gsd:blocked --remove-assignee @me \\\n'
        '  --repo OWNER/NAME',
        1,
    ),
])

# ---------------- review.md ----------------
patch("loop/review.md", [
    (
        "for l in gsd:approved gsd:rework gsd:escalated; do\n"
        '  gh label create "$l" --color ededed 2>/dev/null || true\n'
        "done",
        "node FORGE ensure-labels \\\n"
        "  --labels gsd:approved --labels gsd:rework --labels gsd:escalated \\\n"
        "  --repo OWNER/NAME",
        1,
    ),
    (
        'gh pr list --state open --limit 200 \\\n'
        '  --json number,title,labels,isDraft,headRefName,headRefOid,updatedAt,url',
        "node FORGE pr-list --state open --repo OWNER/NAME",
        1,
    ),
    (
        "retrieve the complete author-bearing comment trail with GraphQL pagination:\n"
        "\n"
        "```bash\n"
        "REVIEWER_LOGIN=$(gh api user --jq .login)\n"
        "gh api graphql --paginate --slurp \\\n"
        "  -F owner=OWNER -F name=REPO -F number=NUMBER \\\n"
        "  -f query='\n"
        "    query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {\n"
        "      repository(owner: $owner, name: $name) {\n"
        "        pullRequest(number: $number) {\n"
        "          author { login }\n"
        "          body\n"
        "          baseRefOid\n"
        "          headRefOid\n"
        "          comments(first: 100, after: $endCursor) {\n"
        "            nodes { author { login } body isMinimized }\n"
        "            pageInfo { hasNextPage endCursor }\n"
        "          }\n"
        "        }\n"
        "      }\n"
        "    }' > PR_EVIDENCE\n"
        "```",
        "retrieve the complete author-bearing comment trail through the forge\n"
        "(the backend paginates; the projection is forge-neutral):\n"
        "\n"
        "```bash\n"
        "REVIEWER_LOGIN=$(node FORGE whoami --repo OWNER/REPO)\n"
        "node FORGE pr-evidence NUMBER --repo OWNER/REPO > PR_EVIDENCE\n"
        "```\n"
        "\n"
        "`PR_EVIDENCE` is one JSON object: `{author: {login}, body, baseRefOid,\n"
        "headRefOid, comments: [{author: {login}, body, isMinimized}]}`.",
        1,
    ),
    (
        "jq --arg reviewer \"$REVIEWER_LOGIN\" --arg header \"$VERDICT_HEADER\" --arg contract \"Contract: $CONTRACT_SHA\" \\\n"
        "  '[.[].data.repository.pullRequest.comments.nodes[]\n"
        "    | select(.author.login == $reviewer and ((.body | split(\"\\n\")[0]) == $header) and ((.body | split(\"\\n\")[1]) == $contract))]' \\\n"
        "  PR_EVIDENCE",
        "jq --arg reviewer \"$REVIEWER_LOGIN\" --arg header \"$VERDICT_HEADER\" --arg contract \"Contract: $CONTRACT_SHA\" \\\n"
        "  '[.comments[]\n"
        "    | select(.author.login == $reviewer and ((.body | split(\"\\n\")[0]) == $header) and ((.body | split(\"\\n\")[1]) == $contract))]' \\\n"
        "  PR_EVIDENCE",
        1,
    ),
    (
        "gh issue view ISSUE --repo OWNER/REPO --json body | jq -j .body > ISSUE_BODY",
        "node FORGE issue-body ISSUE --repo OWNER/REPO > ISSUE_BODY",
        1,
    ),
    (
        'node OUTCOME_SYNC ISSUE pending --repo OWNER/REPO --pr NUMBER --head HEAD_SHA\n'
        'test "$(gh pr view NUMBER --json headRefOid --jq .headRefOid)" = "HEAD_SHA"\n'
        "if gh pr view NUMBER --json labels --jq '.labels[].name' | grep -Fxq gsd:approved; then\n"
        '  gh pr edit NUMBER --remove-label gsd:approved\n'
        "fi",
        'node OUTCOME_SYNC ISSUE pending --repo OWNER/REPO --pr NUMBER --head HEAD_SHA\n'
        'test "$(node FORGE pr-view NUMBER --repo OWNER/REPO | jq -r .headRefOid)" = "HEAD_SHA"\n'
        'if node FORGE pr-view NUMBER --repo OWNER/REPO | jq -r ".labels[]" | grep -Fxq gsd:approved; then\n'
        '  node FORGE pr-edit NUMBER --remove-label gsd:approved --repo OWNER/REPO\n'
        "fi",
        1,
    ),
    (
        "Resolve the linked issue through GitHub's own linkage, with body-parsing of\n"
        "`Closes #NNN` only as a fallback. Do this once per candidate, before the CI\n"
        "gate and outcome invalidation described above:\n"
        "\n"
        "```bash\n"
        "gh pr view NUMBER --json closingIssuesReferences \\\n"
        "  --jq '.closingIssuesReferences[] | {number, repository: .repository.nameWithOwner}'\n"
        "```",
        "Resolve the linked issue through the forge's own linkage (GitHub resolves\n"
        "`Closes #NNN` server-side; GitLab is parsed from the merge-request\n"
        "description with the same close keywords), with body-parsing only as a\n"
        "fallback. Do this once per candidate, before the CI gate and outcome\n"
        "invalidation described above:\n"
        "\n"
        "```bash\n"
        "node FORGE pr-linkage NUMBER --repo OWNER/REPO\n"
        "```",
        1,
    ),
    (
        "gh pr view NUMBER --json files --jq '[.files[].path]'",
        "node FORGE pr-files NUMBER --repo OWNER/REPO",
        1,
    ),
    (
        "gh pr view NUMBER --json headRefOid,mergeable,mergeStateStatus\n"
        'gh pr checks NUMBER --required --json bucket,name,state,link',
        "node FORGE pr-merge-state NUMBER --repo OWNER/REPO\n"
        "node FORGE pr-checks NUMBER --repo OWNER/REPO",
        1,
    ),
    (
        "`gh pr checks` has semantic exit codes — don't treat nonzero as a crash.\n"
        "Exit 8 = still pending. Exit 1 with `no required checks reported` (or\n"
        "`no checks reported`) on stderr = the repo defines no required checks, which\n"
        "is the escalation case below, not an error.\n",
        "`FORGE pr-checks` returns `{state, enforced, checks}` where `state` is\n"
        "`passing | failing | pending | none`. `pending` = still running; `none`\n"
        "(or `enforced: false`) = the repo defines no required checks, which is the\n"
        "escalation case below, not an error. The command encodes the same semantic\n"
        "exit codes internally — don't treat nonzero as a crash.\n",
        1,
    ),
    (
        "One comment via `gh pr comment NUMBER --body-file`:",
        "One comment via `node FORGE pr-comment NUMBER --body-file /path/to/verdict.md\n"
        "--repo OWNER/REPO`:",
        1,
    ),
    (
        "No formal GitHub review approvals or change-requests — the loop may share\n"
        "the PR author's token, and GitHub refuses self-review. The verdict comment,\n",
        "No formal review approvals or change-requests — the loop may share\n"
        "the PR author's token, and the forge refuses self-review. The verdict comment,\n",
        1,
    ),
])

# ---------------- discover.md — GitHub-only capability note ----------------
patch("loop/discover.md", [
    (
        "# gsd-loop: discover\n",
        "# gsd-loop: discover\n"
        "\n"
        "> **Forge support (forge abstraction fork):** this playbook depends on\n"
        "> GitHub-native sub-issue and dependency APIs. It currently runs on GitHub\n"
        "> only; spec, build, and review are forge-neutral. Porting discover requires\n"
        "> a body-managed membership fallback for forges without sub-issues.\n",
        1,
    ),
])
print("ALL PLAYBOOK PATCHES APPLIED")
