# T3 Factory fork runbook

Procedures for maintaining the `factory` branch. Run commands from the repository root. For why the fork is shaped this way, read [the internals page](../internals/factory.md). The fork's default branch is `factory`. Version 1 lives on `feat/t3factory` and the tag `factory-v1-final`; anything still working on v1 must open pull requests with `--base feat/t3factory`, because `gh pr create` defaults to the repository's default branch.

## Run Factory on its own home

A home is the directory T3 keeps its database, settings and workflows in. Give Factory a new one so it never touches an existing T3 Code or T3 Factory v1 install:

```sh
node scripts/factory-home.ts init --home <dir>
```

`init` creates `<dir>`, turns on `workflowsEnabled` in `<dir>/userdata/settings.json`, installs the workflow pack into `<dir>/workflows`, and prints the commands to run next. Start the server and the web app together from the checkout:

```sh
vp run dev --home-dir "<dir>"
```

It loads the pack from `<dir>/workflows`, picks free ports, and prints a `pairingUrl:` line; open that link in a browser. To get a new pairing link later, run `node apps/server/src/bin.ts pair --base-dir "<dir>"`. A path such as `~/.t3factory-v2` works for `<dir>`. This runs the development build from the checkout; a packaged desktop build of T3 Factory does not exist yet.

- Never point `init` or the dev server at a home that is in use, and never start Factory against `~/.t3/userdata` or `~/.t3factory`. The first is T3 Code's home; the second is the live v1 install.
- `init` refuses a home that already has a database (`userdata/statev2.sqlite` or legacy `userdata/state.sqlite`). Pass `--existing` only to run it again on a home Factory created.
- Add `--skills <skills-dir>` to also install the Orchestrator skill, as `<skills-dir>/t3factory-orchestrator`. Use the folder your agent reads skills from.
- `node scripts/factory-home.ts status --home <dir>` says whether workflows are on and whether each pack file is current. It exits 1 when either is not.

## Install only the pack

To use the workflows in a home that runs stock T3 Code, install the pack alone. The Work page needs the fork's server; the pack does not.

```sh
node scripts/factory-pack.ts install --home <dir> [--skills <skills-dir>] [--force]
node scripts/factory-pack.ts status --home <dir>
node scripts/factory-pack.ts uninstall --home <dir>
```

The home must already exist. `install` writes `<dir>/workflows` and records what it wrote in `.factory-pack.json`. Workflows must be on in that home (**Settings → Labs → Workflows**).

`install` copies every workflow file under `factory/workflows/`, including `lib/`, so a new workflow file in the pack ships with no list to update. That is `factory-task`, `factory-intake`, `factory-signals`, `factory-sync-upstream`, `factory-brief`, `factory-experiment`, `factory-self-repair` and `factory-metrics`, and the helpers `lib/records.ts`, `lib/risk.ts`, `lib/ledger.ts`, `lib/metrics.ts`, `lib/placement.ts` and `lib/signals.ts`.

The server reloads changed top-level workflow files without a restart, but not the helpers under `lib/`: an update that changes one needs a server restart, and `install` prints a line saying so when it applies.

- Running `install` again updates the pack files and removes ones the pack no longer ships.
- A file in `workflows` that is not from the pack and differs from it is a conflict: nothing is written, and the paths are listed. `--force` overwrites them.
- `status` prints `same`, `changed`, `missing` or `stale` per file and exits 1 unless all are `same`.
- `uninstall` removes only the files the manifest lists, and prints a restart warning if it removed helpers under `lib/`.
- The skill is copied by `install` and left alone by `status` and `uninstall`.

`factory-task` and `factory-task-part` are at version 5 and `factory-intake` at version 2, and the pack ships no earlier version of them. The server holds a changed file back while unfinished runs still use a version it would remove, so update a home only when no run of an old version is unfinished. `t3 workflow list` shows which runs have not ended. This update also changes files under `lib/`, so restart the server after installing it.

For `factory-task` and `factory-task-part`, let unfinished runs end, or cancel them on the Workflows page, before installing the pack. For `factory-intake`, whose tick starts every five minutes, cut over in this order:

1. Set `enabled` to `false` in every intake binding.
2. Let the version 1 ticks end, and cancel any that paused.
3. Start by hand any task that a cancelled tick captured but did not start; it is in **Ready** with no attempt. A cancelled tick can leave such a task, and nothing else starts it.
4. Install the pack, add `authors` to each binding whose issues should start, and set `enabled` back to `true`. A binding without `authors` captures issues and starts none.

## Take a new upstream nightly

`origin/main` mirrors upstream. The steps keep upstream's history intact and move `factory` only when everything passes. Two tools shorten the work; the manual steps below remain the reference.

Start with the plan. It leaves the worktree and refs unchanged. In a partial clone it stays offline by default; add `--fetch-missing` to let Git download blobs needed to predict conflicts.

```sh
node scripts/factory-sync.ts plan --ref <tag>
```

It prints whether the tree is clean, whether the ref exists, the merge base, and one `conflict` line per file a merge would conflict in, marked `seam`, `generated`, `owned` or `outside`. It ends with `factory-sync: ok` and exits 0, or says how many problems it found and exits 1. A dirty tree, an unknown ref, no merge base and any `outside` conflict are problems; conflicts in seams, generated files and fork-owned files are expected.

To have an agent do the merge, start the workflow `factory-sync-upstream` on the project that holds the fork:

```sh
t3 workflow start factory-sync-upstream --input '{"projectId":"<projectId>","ref":"<tag>"}' --key sync/<tag>
```

An agent does the manual steps in a worktree and opens a pull request. When its checks pass, the workflow asks before merging it, always with a merge commit. When the pull request ran no checks at all, only an answer given in the app merges it. Read the conflicts it reports in that question before you answer.

By hand:

1. Fetch the tags and pick the newest nightly, `<tag>`.
2. `git switch -c sync/upstream factory`, then `git merge <tag>`.
3. Resolve conflicts. They should only be in the files listed under `seams` in `factory/seams.json`; keep both sides' lines. For a generated file, take upstream's version; a later step rebuilds it. Commit the merge before going on: the two Factory tools compare against the merge base of `HEAD`, so run before the commit they treat every new upstream string as Factory's.
4. `vp i --frozen-lockfile`, so the generators and checks run on upstream's new dependencies.
5. Regenerate the generated files: the route tree (the web build or dev server rewrites it) and, with `vp run i18n:generate` in `apps/web`, `apps/mobile` and `apps/desktop`, the translation catalogs.
6. `node scripts/factory-i18n.ts merge --base <tag>` rebuilds every catalog as upstream's plus Factory's keys with their translations.
7. `node scripts/factory-i18n.ts check --base <tag>`, then `node scripts/factory-seams.ts --base <tag>`. If a seam no longer differs from upstream, it is stale: remove it from `factory/seams.json`.
8. Run the checks the [CI](#what-factory-ci-checks) runs, below, and fix what broke.
9. `git switch factory`, then `git merge --ff-only sync/upstream`, or a plain `git merge sync/upstream` when `factory` moved in the meantime; after a plain merge repeat steps 6 to 8 on `factory`.
10. Push the tag's commit to `origin/main` first, then `factory`. CI compares against `origin/main`, so it must already be the tag.

How often: run the plan against the newest nightly every day, and merge on Monday and Thursday, or sooner when the plan predicts seam conflicts. Keep one sync open at a time. After a sync that needed more than one round of fixes, merge daily until two go through clean. The first real sync, 102 upstream commits that touched 6 of the 11 seam files, merged with no conflict.

Do not hand-merge `pnpm-lock.yaml`; Factory adds no dependencies, so it must equal upstream's.

## Development server inside the checkout

When the dev server's home is inside the checkout, the default for `vp run dev` in a worktree, the worktrees that workflow agents work in are created under `<checkout>/.t3/worktrees`, and tools that walk the repository can stall on them. This was seen with `vp run i18n:generate`, whose `gt generate` hangs in its package-version check until it is run as `gt --skip-version-check generate` or those worktrees are removed. A real install keeps its home outside the repository and is not affected.

## Add a translated string

Write the string in Factory code through `gt-react` as upstream's [translation page](../internals/14_i18n.md) describes. Then:

1. Run `vp run i18n:generate` in the app (`apps/web`, `apps/mobile` or `apps/desktop`).
2. Run `node scripts/factory-i18n.ts merge --base origin/main`. It lists the app's Factory keys in `factory/i18n/<app>/source.json` with their English, and prints how many are untranslated per locale. Pass `--app web`, `--app mobile` or `--app desktop` (repeatable) to limit the apps.
3. Add each key and its translation to `factory/i18n/<app>/<locale>.json`, one file per locale. Keys are the generated hashes.
4. Run `merge` again, then `node scripts/factory-i18n.ts check --base origin/main`.

`merge` prunes any overlay key that upstream now defines in `en.json`. `check` fails when a catalog is not upstream's plus Factory's sorted keys, when a Factory key is missing from an overlay, when `source.json` is stale, or when an overlay disagrees with its catalog. A translation must keep every placeholder name and every embedded element of the English; word order and the number of text segments may differ. `--base` defaults to `origin/main`.

## Pinned third-party assets

`factory/vendor/manifest.json` pins CLIProxyAPI and its Management Center by exact version, with the URL, size and SHA-256 of each platform's file and of each licence text. The server installs them on request from **Work → Model proxy**. A packaged build has no checkout manifest, so it cannot install the proxy and refuses with `no-checkout`. The pack installer does not install the proxy or copy the manifest. Use [`scripts/factory-vendor.ts`](../../scripts/factory-vendor.ts) by hand to check the manifest or fetch the pinned bytes into a separate folder without installing them:

```sh
node scripts/factory-vendor.ts check
node scripts/factory-vendor.ts status [--dir <dir>]
node scripts/factory-vendor.ts fetch --dir <dir>
```

- `check` validates the manifest without the network. It prints `ok <name> <version>` per component, or one `invalid <problem>` line per problem and exits 1. CI runs the same check through `scripts/factory-vendor.test.ts`.
- `status` prints `pinned <label> <bytes> <sha256>` for each of the eight files. With `--dir` it compares a folder that `fetch` made and prints `same`, `missing`, `size`, `hash`, `not-file` or `unreadable` per file, exiting 1 unless all are `same`. It only reads.
- `fetch --dir <dir>` creates `<dir>`, downloads each file into `<dir>/<name>-<version>/`, and writes it only once its size and SHA-256 match. It prints `fetched <label> <file>` per file. On any failure it prints the failing line, removes every file and folder that run created, and exits 1; a removal that fails adds a `cleanup failed <path>` line. A killed process is not cleaned up.

`fetch` refuses, with one `refused:` line and nothing created: a `<dir>` that already exists in any form (a folder, empty or not, a file, a link or junction, a dangling link); one whose parent is not an existing folder; one inside the checkout, `~/.t3` or `~/.t3factory`, with links resolved and, on Windows and macOS, letter case ignored; and on Windows a network or device path, one starting with `\\` or `//`. It follows at most three redirects, each over https with no credentials and no port other than 443, and only to `github.com`, `raw.githubusercontent.com` or `release-assets.githubusercontent.com`. A file larger than 100 MiB fails.

To move a pin:

1. Pick the newest release of each component that is not a draft or prerelease and was published at least 168 hours before you download it. Check the console's `requires` range against the proxy version. When no release is old enough, keep the current pin.
2. Download each file the manifest names, and the `LICENSE` at the tag, and take each one's size and SHA-256. They should match GitHub's asset `digest` and, for the proxy, its `checksums.txt`, but a match is not proof: nothing is signed.
3. Edit the manifest: `version`, `publishedAt` (GitHub's publication time), `retrievedAt` (when you took the hashes), both UTC to the second as `YYYY-MM-DDTHH:MM:SSZ`, and each file's URL, `bytes` and `sha256`. The licence must still be MIT.
4. Run `check`, then `fetch --dir` into a new folder outside the checkout to verify the downloads. On Windows, start Factory against a fresh, isolated home and use **Work → Model proxy** to install and start the new pin. Verify the proxy listens only on loopback, the pinned console signs in with a temporary typed management key, and **Usage → Limits** lists **Factory proxy**. Stop it, confirm the listener closes and Usage disconnects, then uninstall. Do not qualify a pin against a live home.

`check` refuses a version that is not an exact `x.y.z`; a `source` other than the component's repository; a `retrievedAt` less than 168 hours after `publishedAt`; platforms other than `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64` for the proxy, or `any` for the console, in that order; a URL that is not exactly the release download for that version (for a licence, the raw file at the tag), so no `latest`, branch, query, port or upper-case letter in the host; a SHA-256 that is not 64 lower-case hex; a size outside 1 byte to 100 MiB; a licence other than MIT; a URL, hash or platform used twice; and any key it does not know.

Once the server reads the new manifest, **Model proxy** shows the pinned and installed versions side by side and says when either has changed. The installed copy stays as it was. To move an environment to the new pin, uninstall with sign-ins kept, then install again. This replaces the proxy and console settings and keys, not the kept sign-ins. There is no upgrade in place or rollback.

Do not remove or replace `factory-proxy/static/management.html` while the proxy is running. The server verifies the pinned file before launch, but the proxy serves it itself and can fetch a replacement if the file disappears. Stop the proxy before repairing the install.

## Model proxy files and recovery

Look under `<dir>/userdata/factory-proxy` in the server's home. `record.json` holds the installed versions and port, not the keys. `config.yaml` holds the proxy settings, `releases/<proxy version>/` holds the executable and both licences, `static/management.html` is the pinned console, and `auth/` holds the sign-ins and account database. The server's secret store is under `<dir>/userdata/secrets`. There is no Factory log of the proxy's output. An uninstall that keeps sign-ins leaves only `auth/` in `factory-proxy`; an uninstall that also removes sign-ins removes the folder.

For `port-in-use`, identify the program listening on the recorded port on that machine. If the dialog shows a process number from an earlier server run, verify that the number still belongs to that proxy before ending anything. Close the program holding the port, then choose **Start** again. The server does not try another port, and it refuses uninstall while a recorded earlier process may still be running and the port is held. If the settings file cannot be read, uninstall with sign-ins kept and install again. The saved console settings are not recovered.

## What Factory CI checks

`.github/workflows/factory.yml` runs on pull requests and pushes to `factory`, and by hand. Upstream's workflows are disabled in the fork. It checks, in order:

- the lockfile equals the merge base with `origin/main`;
- `node scripts/factory-seams.ts --base origin/main` (at most twelve seam files, each within its `maxAdded` line cap, and all of them together within `maxAddedTotal`);
- typecheck of contracts, server, client-runtime, web, mobile, scripts and evals;
- the server's `factory` tests, all `scripts/factory-*.test.ts` tests, and `evals/factory-pack`, which tests every pack workflow: `run`, `sync`, `brief`, `experiment`, `risk`, `self-repair`, `ledger`, `metrics`, `intake`, `signals`, `placement`, `remote-writer` and `reader`;
- upstream seam unit tests (`ws.test.ts`, `RpcAuthorization.test.ts`, `RpcInstrumentation.test.ts`, `rpc.test.ts`, `client.test.ts`);
- the web `src/factory` unit tests and `CommandPalette.logic.test.ts` (Playwright browser seam tests — `CommandPalette*.browser.test.tsx` and `mainAppLocation.browser.test.tsx` — are not run in `factory.yml` because it does not install browser binaries);
- `vp run i18n:check`, upstream's catalog check;
- `node scripts/factory-i18n.ts check`, the fork's translations.

One of those script tests, `scripts/factory-ci.test.ts`, holds every `factory*.yml` workflow to one rule. A workflow that can start by itself (a pull request or a push) names its permissions and may only read, and none may start from a timer, a tag, a release or another workflow. A workflow that builds or publishes starts by hand, on an exact commit, and by nothing else; only then may one of its jobs write.
