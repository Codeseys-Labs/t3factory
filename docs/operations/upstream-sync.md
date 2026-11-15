# Syncing with upstream T3 Code

T3 Factory is a fork of [T3 Code](https://github.com/pingdotgg/t3code). Upstream moves by 150 to 470
commits a day, so the fork merges it often and in small steps. This page is the procedure. The
reasons behind it are in [#133](https://github.com/Codeseys-Labs/t3factory/issues/133).

Syncs are merges, never rebases: a rebase would rewrite the published branch that build manifests
are bound to.

## When to sync

- Every week, on Monday.
- Sooner, ahead of feature work, when any of these holds:
  - 14 days or 1,500 upstream commits since the last sync;
  - a trial merge shows 40 or more conflicting files;
  - upstream changed its `effect` or Node.js version.

The trial merge touches no checkout and makes no commit. Compare upstream with the newest fork
state: the open sync branch when there is one, otherwise the default branch. Against the default
branch alone, a sync that is still in review would be counted again.

```sh
git fetch origin
git fetch upstream
git merge-tree --write-tree --name-only --no-messages <newest fork state> upstream/main | tail -n +2 | sort -u | wc -l
```

## Before you merge

1. `git fetch upstream` and note the commit you will merge. Use that one commit for the whole sync,
   even if upstream moves on.
2. Look at what upstream changed under `.github/workflows/`. A new workflow can act on this
   repository as soon as it is on the default branch. Decide each one's role now.
3. Start from the current default branch:
   `git switch -c t3/upstream-sync-<date> origin/feat/t3factory`.

## Merge

```sh
git merge --no-ff --no-commit <upstream commit>
```

- Resolve by area, one owner per file: orchestration; server wiring, persistence, contracts and MCP;
  server features and packages; web, desktop, mobile, scripts and docs. Then one pass that makes
  every package typecheck.
- The rules: upstream's structure wins where it refactored; the fork's additions stay; where both
  sides fixed the same problem, take upstream's.
- Take upstream's `pnpm-lock.yaml` and run `pnpm install --no-frozen-lockfile`. Regenerate
  `apps/web/src/routeTree.gen.ts`.
- Neutralize every new upstream workflow to `workflow_call` with no caller, add it to
  `scripts/factory-workflow-audit.ts`, and run `node scripts/factory-workflow-audit.ts` until it
  passes.
- Commit the merge with `--no-verify`. The pre-commit hook takes half an hour on a merge this size;
  `check:changed` below carries the same checks for the fork's own changes.

## Review

Nobody can review the full diff. Review what was decided by hand.

1. Save `git show --remerge-diff <merge commit>` and split it by area. Every hunk in it is a
   conflict resolution or a hand edit.
2. Give each area to a reviewer with one question, from a model family that did not do the
   resolving. Questions that found real problems: do the Factory's guards still run on every path
   upstream added; does an existing database upgrade in place; is every entry point still guarded;
   was anything lost from either side; is every screen and control still reachable.
3. List the fork's lines that vanished in conflict regions and have each block classified as
   replaced, removed upstream, intended or lost. A resolution that quietly took upstream's side
   shows up nowhere else.
4. Have a second model confirm a serious finding before anyone fixes it. A logic fix gets a test
   that fails without it.
5. Keep one table of findings, each with a verdict and an outcome, including the declined ones.
6. After the fixes, review the commits made since step 2. The first review says nothing about them.

CodeRabbit cannot review a pull request this large. If a second reviewer is wanted, open a
review-only pull request whose diff is the remerge diff, ask Greptile there once, and close it
unmerged.

## Validate

Follow [T3Factory manual validation](release.md#t3factory-manual-validation), with these points
specific to a sync:

- The base for `check:changed` and for the receipt is the upstream commit you merged. That checks
  the fork's changes on top of upstream. Against the old default branch it would re-check all of
  upstream's files.
- On Windows, pass `--timeout 5400` to `check:changed`: its test step takes about 50 minutes.
- Before recording, package once on Windows into an empty folder:
  `vp run dist:desktop:artifact --distribution factory-preview --output-dir <folder>`. It takes
  three minutes. The receipt's desktop build does not package, so a payload problem would
  otherwise show only after the hosted run, at the packaging receipt.
- `check:changed` runs the tests beside changed files only. If the sync changed anything every
  test loads (a shared setup file, a test config), run the tests of the other packages too, or
  expect the hosted `Test` lane to be the first to try them.
- Record the quick commands first (desktop build, focused tests), then `check:changed`.
- From the first record to `finalize`, change nothing in the checkout. After any failure, fix,
  commit, push, delete the receipt folder and record everything again.
- Dispatch `factory-check.yml` with every lane, including `lane_windows=true`.

Upstream does not run its tests on Windows, so some of its tests fail only there. They go in
`packages/shared/src/testing/windowsQuarantine.json`, which a test setup file applies on Windows
only. That setup file is loaded by the root test configuration (server and the packages that
borrow it) and by desktop's unit project. Desktop's DOM project, web, mobile and client-runtime
have their own setup lists; add the file there before listing one of their tests. Each entry names
an issue and a reason. Never list a test the fork added, and do not edit upstream's test files to
make them pass on Windows. Linux runs every case, so a hang or failure on the hosted lanes is real
and blocks the merge.

## Land it

1. Check that the default branch has not moved: `git fetch origin`, then
   `git merge-base --is-ancestor origin/feat/t3factory HEAD`. If it has, merge it into the sync
   branch and validate again. The receipt belongs to one commit.
2. Merge with `gh pr merge <n> --merge --match-head-commit <sha>`. If the command reports an
   error, read the pull request's state before trying again: the merge may have happened.
3. Confirm the default branch now holds exactly what was validated: `git fetch origin`, then
   `git diff --quiet <validated sha> origin/feat/t3factory`.
4. Retarget every pull request stacked on the sync branch to the default branch, and read each
   one's base back. Deleting a branch closes the pull requests based on it.
5. If a preview is built from this sync, build it from the validated commit with the sync branch
   as its ref, and keep that branch until the build finishes. The build refuses a commit or ref
   that the validation did not name.

## Things that have gone wrong

- **A dependency published during the sync.** `check:changed` installs without the lockfile to find
  unused patches, so a new release can break a strict peer overnight. Look for upstream's fix first
  and cherry-pick it with `-x`.
- **A long command started from an agent's own session.** It dies when the session restarts and
  nothing reports it. Give receipts to a delegate, and check the receipt file before saying a run
  is alive.
- **`bash script.sh` on Windows** can start the WSL shell, which cannot see `C:/` paths. Run the
  commands directly.
- **A shared test setup file that used the global `URL`.** A test file can run in a DOM
  environment, which replaces `URL`; `fileURLToPath` then rejects it and the file fails to load on
  every host. Pass the `import.meta.url` string straight to `fileURLToPath` from `node:url`, and
  build paths from the result with `node:path`.
- **The hosted web test lane lost its browser** when the suite grew by a third in one sync. The lane
  now runs the suite in two halves. If upstream changes how its own CI splits the web tests, check
  the lane again.
- **Packaging on Windows ran a hook upstream never runs there.** Upstream packages Windows from
  Linux, where its after-pack hooks skip themselves. A hook that looks cross-platform can be
  untested on a Windows host. Upstream's release log shows what it actually ships.
- **A vendored file with a 192-character path held every task run** on Windows clones that do not
  set `core.longpaths` ([#142](https://github.com/Codeseys-Labs/t3factory/issues/142)). No test
  could see it: the server test setup turns long paths on for every git child. After a sync, read
  the longest tracked path, `git ls-files | awk '{ print length($0) }' | sort -n | tail -1`, and
  run one task in the built preview before calling the sync done.
- **A test install under `%TEMP%` lost its files overnight**, including its database and the
  `.git` folder of its repository clone. Keep test installs and database backups out of temporary
  folders.
- **Factory migrations.** Read [#132](https://github.com/Codeseys-Labs/t3factory/issues/132) before
  a sync that brings upstream migrations.
