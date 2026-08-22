# gsd-loop: build

Each pass does one thing, then stops: repair one bounced PR, or take one
issue from ready to open-PR. Your loop runner provides the repetition; this
playbook provides the unit.

Pair it with a review loop running the `loop/review.md` playbook in its own
session. Both can share a GitHub token — the reviewer never touches git, so
there's nothing to race.

## Ground rules before touching anything

- Confirm the repo (`gh repo view --json nameWithOwner`) and that `origin`
  answers.
- Look up the default branch —
  `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` — and
  use what it says, whatever it says.
- A pass never checks its branch out in the repository's main working tree.
  Each `gsd/NNN-*` branch lives in a dedicated git worktree at a predictable
  sibling path, so the main tree stays on the default branch and dependency
  installs never touch it:

```bash
MAIN_TREE=$(git rev-parse --show-toplevel)
WORKTREES_DIR="$(dirname "$MAIN_TREE")/$(basename "$MAIN_TREE")-worktrees"
# one directory per branch, slashes flattened:
#   branch gsd/NNN-short-slug  →  $WORKTREES_DIR/gsd-NNN-short-slug
```

  Create it with `git worktree add` (see "Implement") and run every
  checkout-side operation from inside it — installs, builds, tests, commits,
  pushes, `gh pr create` — directly or via `git -C`. Because the path derives
  from the branch name, two concurrent passes on different issues occupy
  different worktrees, and a resumed pass lands back in the same directory.
  If `git worktree add` fails — worktrees unsupported or blocked on this
  host — fall back to checking the branch out in the main tree under the
  dirty-worktree guards below, and say so in the pass report and the result
  line's `reason`. Everything else about the pass is unchanged.
- Guarantee the queue/review label vocabulary exists (repeat-safe,
  non-destructive):

```bash
for l in gsd:ready gsd:blocked gsd:approved gsd:rework gsd:escalated; do
  gh label create "$l" --color ededed 2>/dev/null || true
done
```

## Pick up after a dead pass

A pass can die on any line, so recovery reads git and GitHub state rather
than trusting memory. Sweep stale worktrees first, then classify what is
left:

- **Stale `gsd/NNN-*` worktrees.** List them with
  `git worktree list --porcelain`. For each one on a `gsd/NNN-*` branch,
  check the branch's PR
  (`gh pr list --head BRANCH --state all --json number,state`) and whether
  the branch still exists on origin (`git ls-remote --heads origin BRANCH`).
  If the PR is merged or closed, or the branch is gone from origin, remove
  the worktree and prune its administrative entry:

```bash
git worktree remove PATH   # inspect any leftovers before adding --force
git worktree prune
```

  A merged PR's worktree is debris, not state — clear it before claiming
  new work, so no stale entry lingers under `.git/worktrees/`.
- **Uncommitted changes in a `gsd/NNN-*` worktree, PR open** → a repair
  pass died. Re-enter the repair flow below for that PR, working in that
  worktree.
- **Uncommitted changes in a `gsd/NNN-*` worktree, no PR** → a build pass
  died. Re-check that issue is still open, still `gsd:ready`, still yours;
  if so, pick up at "Implement" in that worktree. If not, leave everything
  in place, report, stop.
- **Uncommitted changes on a `gsd/NNN-*` branch in the main tree** → a
  fallback-mode pass (or one from before worktrees) died there. The same
  two verdicts above apply to the main tree.
- **Uncommitted changes anywhere else** → not the loop's doing. Name the
  files, stop. Stashing, resetting, or committing someone else's work is
  forbidden.
- **Clean trees, but a `gsd/NNN-*` branch (local or on origin) exists for an
  open issue assigned to you with no PR** → a pass died between commit/push
  and PR creation. Reuse the branch's worktree if one exists — create it
  otherwise, resuming the branch as-is — then diff it against the issue's
  outcomes and continue from "Implement" or "Open the PR" as appropriate.
- **Abandoned claims.** Find them:

  ```bash
  gh issue list --state open --label gsd:ready --assignee "@me" --limit 200 \
    --json number,closedByPullRequestsReferences
  ```

  Any with no open linked PR and no `gsd/NNN-*` branch anywhere: unassign
  (`gh issue edit NUMBER --remove-assignee @me`) so the queue reclaims it.
  If its PR was closed unmerged, additionally apply `gsd:escalated` with a
  comment — whether to rebuild is a human call.

## Repair queue takes priority

```bash
gh pr list --state open --label gsd:rework --limit 200 \
  --json number,title,headRefName,headRefOid,labels,updatedAt,url
```

Ignore anything also carrying `gsd:escalated` — those PRs have exited
automation until a human clears them.

Take the stalest remaining PR, resolve its linked issue and authenticated
reviewer identity, then pull its most recent trusted verdict:

```bash
REVIEWER_LOGIN=$(gh api user --jq .login)
ISSUE=LINKED_ISSUE
gh pr view NUMBER --json headRefOid --jq .headRefOid
REVIEWER_LOGIN="$REVIEWER_LOGIN" ISSUE="$ISSUE" \
  gh api --paginate --slurp \
  "repos/OWNER/REPO/issues/NUMBER/comments?per_page=100" \
  --jq '[.[][] | select(.user.login == env.REVIEWER_LOGIN and ((.body | split("\n")[0]) | startswith("gsd-loop verdict for ")) and ((.body | split("\n")[0]) | endswith(" issue #" + env.ISSUE)))] | last'
```

Work the repair inside the PR branch's worktree: reuse the one a dead pass
left, or create it with `git worktree add "$WORKTREES_DIR/BRANCH" BRANCH`
(flattening the branch's `/` in the directory name). All fixes, checks, and
pushes run from there — the main tree never changes branches.

- A verdict's first line must pin both its SHA and linked issue as
  `gsd-loop verdict for COMMIT_SHA issue #ISSUE`; ignore comments by any other
  author or pinned to another issue.
- Trusted verdict SHA already matches the head? The label outlived its verdict
  (fixes were pushed but the label removal died). Re-fetch the final PR head as
  `HEAD_SHA` and run
  `node LINKAGE_SYNC ISSUE --repo OWNER/REPO --pr NUMBER --head HEAD_SHA`.
  Only after that guard passes, drop `gsd:rework`, stop — the reviewer will take
  it from here.
- Can't check out the branch (deleted head, vanished fork, worktree creation
  refused)? Comment what happened, trade `gsd:rework` for `gsd:escalated`,
  stop.
- Otherwise: address only the verdict's "Blocking" items, run the checks
  that cover them. Before pushing, inspect the complete PR diff against the
  default-branch baseline. If it changes a dependency manifest or lockfile,
  repeat the baseline-versus-branch audit policy under "Prove it"; repair
  commits do not inherit stale audit evidence. Push only after required gates
  pass. After any repository-required post-PR validation, re-fetch the final PR
  head as `HEAD_SHA` and run
  `node LINKAGE_SYNC ISSUE --repo OWNER/REPO --pr NUMBER --head HEAD_SHA`.
  Only after that guard passes, remove `gsd:rework` and comment a summary containing
  `Dependency audit for HEAD_SHA: baseline compared` immediately followed by
  the normalized fenced `gsd-loop/dependency-audit-v1` JSON described under
  "Prove it", using the full pushed head SHA. Stop.

If a blocking item can't be fixed without crossing an `X-N` exclusion or
making a product decision, don't. Comment the exact collision, ending with
the sentence that restarts automation ("Resolve this, then remove
`gsd:escalated`."), apply `gsd:escalated`, remove `gsd:rework`, stop.

## Choose an issue

```bash
gh issue list --state open --label gsd:ready --limit 200 \
  --json number,title,labels,body,assignees,createdAt,url \
  --jq '[.[] | select(.assignees | length == 0)]'
```

(The unassigned filter is client-side on purpose — `--search "no:assignee"`
rides a lagging index and can miss an issue you unassigned seconds ago.)

Discard issues labeled `gsd:map`, `gsd:blocked`, or `gsd:escalated`. A map is
planning provenance even if someone accidentally applies `gsd:ready`; it must
never enter the build queue. Discard issues whose body says `Needs #N merged`
unless `#N` is closed *and* its closing PR actually merged
(`gh issue view N --json state,closedByPullRequestsReferences`) — closure
without merged code doesn't satisfy the dependency. Of what's left, take the
oldest.

Empty queue plus empty repair queue = an idle pass. Say so, and steer the
loop runner: self-pacing → longest interval; three idle passes in a row →
suggest shutting the loop down, since only a human filing, unblocking, or
merging creates new work.

## Stake the claim

```bash
gh issue edit NUMBER --add-assignee @me
```

Claim before deep reading, before any code. Immediately re-fetch: if the
issue meanwhile became blocked, someone else's, or lost `gsd:ready`, walk
away and choose again.

Assignment is a courtesy lock, not an atomic one — two sessions on the same
GitHub account can both "win" it. One builder loop per repository, no more.

## Read the contract

`gh issue view NUMBER --comments` for the full body and discussion. The `O-N`
outcomes are the entire job; the `X-N` exclusions are the fence. Hold each
outcome against each exclusion before writing a line. Nothing outside the
contract: no drive-by refactors, no bonus fixes.

An outcome that's ambiguous, collides with an exclusion, or leans on an
unmet dependency goes straight to "Hand it back" — guessing is the one
unrecoverable failure.

## Implement

- Fetch `origin`, then create or resume the branch's worktree (real issue
  number in `NNN`):
  - Origin already has `gsd/NNN-short-slug` → resume it as-is:
    `git worktree add "$WORKTREES_DIR/gsd-NNN-short-slug" gsd/NNN-short-slug`.
    Force-pushing over it is forbidden. If the worktree already exists,
    enter it — never create a duplicate.
  - Otherwise base a new branch on origin's default branch:
    `git worktree add -b gsd/NNN-short-slug "$WORKTREES_DIR/gsd-NNN-short-slug" origin/DEFAULT`.
  - `git worktree add` failed → fall back to the in-tree checkout per the
    ground rules, and say so in the report and result `reason`.
- Work entirely inside the worktree: dependency installs, builds, tests,
  and commits. The main tree stays on the default branch and its installed
  dependencies must not change — verify with
  `git rev-parse --abbrev-ref HEAD` there before and after.
- Follow the codebase's existing architecture, style, and names.
- Logic, data flow, permissions, integrations, or visible behavior changed?
  Tests change with it.
- Everything the contract doesn't mention keeps working exactly as before.
- If the pass fails mid-flight, leave the worktree in place for inspection
  and name its path in the report. Cleanup belongs to a later pass's
  recovery sweep, never to the failing pass.

## Prove it

Run whatever lint, typecheck, build, and focused tests this change implicates
from inside the worktree.
Everything attributable to your diff must pass. When a broad suite fails for
pre-existing unrelated reasons, run the narrow equivalent, keep the output,
and disclose both in the PR.

If the diff changes a dependency manifest or lockfile, audit dependencies in
both the default-branch baseline and the proposed branch using the project's
existing security command or the package manager's machine-readable audit.
Compare advisories by identifier and affected package:

- A new high or critical advisory attributable to the diff blocks the PR.
  Attempt a compatible remediation only when it stays inside the issue
  contract. If none exists, comment the evidence, apply `gsd:escalated`,
  remove your assignment, and stop.
- An audit that cannot run or cannot be compared reliably also escalates; a
  missing result is not a clean result.
- New lower-severity and pre-existing advisories do not block, but the PR must
  disclose them. New moderate findings or audit uncertainty make the risk call
  at least Medium.

After the change is committed, pin the comparison evidence to the full proposed
head SHA. Evidence without that exact SHA is stale and cannot be reused by a
later repair commit. Normalize the evidence as one fenced JSON object: use
schema `gsd-loop/dependency-audit-v1`; record the full default-branch baseline
and proposed head SHAs; and include an `audits` array. Each audit names the
sorted changed `manifests` it covers, its `directory`, the exact nonempty
`command` argv used unchanged at both commits, and `baselineAdvisories` plus
`headAdvisories`. Advisory entries contain only lowercase `severity`, `id`,
and `package`; sort them by `id` then `package` and reject duplicate
identifier/package pairs. Every changed dependency manifest or lockfile must
appear exactly once.

Read your own `git diff` and `git status` end to end. Unrelated files or
anything secret-shaped in the diff = full stop.

## Open the PR

First re-confirm the issue is still open and `gsd:ready` — a human may have
pulled it mid-build. If they did, comment what the branch contains, skip the
PR, stop. Otherwise push from the worktree and run `gh pr create --body-file`
there with a compact body containing:

- The change and its motivation
- `Closes #NNN` (real number)
- A one-row-per-outcome evidence table for `O-N`
- A compact untouched-confirmation for every `X-N`, then the line
  `Side effects beyond the contract: none`
- Which automated checks ran, with results
- `Dependency audit for HEAD_SHA: baseline compared` followed immediately by
  the normalized fenced JSON object for any dependency manifest or lockfile
  change, using the full proposed head SHA, or
  `Dependency audit: not applicable` otherwise
- Whether the issue's manual walkthrough passed; reference it instead of
  copying every step into the PR
- A justified risk call: Low / Medium / High

If the side-effects line would be a lie, stop and get the issue amended
first.

Repository-required post-PR validation may add a commit or rewrite PR metadata.
After every such gate finishes, re-fetch the final PR head as `HEAD_SHA`, then
run:

```bash
node LINKAGE_SYNC ISSUE --repo OWNER/REPO --pr NUMBER --head HEAD_SHA
```

This repeat-safe guard preserves the current PR body and restores its explicit
`Closes #NNN` marker when another tool removed it. A stale head, concurrent body
change, or failed verification blocks the pass. Do not report successful handoff
until the guard passes. Then drop the PR URL as an issue comment. Merge-time
closure is `Closes #NNN`'s job — never close the issue by hand, never merge,
never arm auto-merge. Leave the worktree in place after a successful pass;
the recovery sweep removes it once the PR merges or the branch is deleted.
Stop.

## Hand it back

When only a human can answer, ask exactly one answerable question in an
issue comment, then in a single command label and release:

```bash
gh issue comment NUMBER --body "..."
gh issue edit NUMBER --add-label gsd:blocked --remove-assignee @me
```

The comment closes with the resumption instruction: "Answer above, then
remove `gsd:blocked`." Leave `gsd:ready` on — the picker already skips
`gsd:blocked`, so the issue resurfaces the moment a human answers and
unlabels.

"This is unclear" is not a question. Name the decision, the options, and the
`O-N` it gates. Then stop, so the next pass is free to work something else.

## Report the pass

The final response must end with exactly one machine-readable line and no text
after it:

```text
GSD_LOOP_RESULT={"lane":"build","status":"work|idle|blocked","reason":"short-reason"}
```

Use `work` when the pass changed GitHub or git state, including a hand-back or
escalation; use `idle` only when both queues are empty; use `blocked` when a
preflight, permission, dirty-worktree, or malformed-contract condition prevents
the pass from safely reaching one of those outcomes. Here `dirty-worktree`
means unexpected uncommitted changes the recovery states above cannot resolve
— in the main tree or anywhere else — never state the loop produced itself.
When the pass ran in fallback mode, say so in `reason` (e.g.
`worktree-fallback`); when a failed pass leaves a worktree behind, name its
path in the report above the result line.
