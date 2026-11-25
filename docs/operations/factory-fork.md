# T3 Factory fork runbook

Procedures for maintaining the `factory` branch. Run commands from the repository root. For why the fork is shaped this way, read [the internals page](../internals/factory.md).

## Run Factory on its own home

A home is the directory T3 keeps its database, settings and workflows in. Give Factory a new one so it never touches an existing T3 Code or T3 Factory v1 install:

```sh
node scripts/factory-home.ts init --home <dir>
```

`init` creates `<dir>`, turns on `workflowsEnabled` in `<dir>/userdata/settings.json`, installs the workflow pack into `<dir>/workflows`, and prints the two commands to run next:

```sh
node apps/server/src/bin.ts serve --base-dir "<dir>"
node apps/server/src/bin.ts pair --base-dir "<dir>"
```

Open the pairing link `pair` prints in a browser. A path such as `~/.t3factory-v2` works for `<dir>`.

- Never point `init` or `serve` at a home that is in use, and never start Factory against `~/.t3/userdata` or `~/.t3factory`. The first is T3 Code's home; the second is the live v1 install.
- `init` refuses a home that already has a database. Pass `--existing` only to run it again on a home Factory created.
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

The server reloads changed top-level workflow files without a restart, but not the helpers under `lib/`: an update that changes one needs a server restart, and `install` prints a line saying so when it applies.

- Running `install` again updates the pack files and removes ones the pack no longer ships.
- A file in `workflows` that is not from the pack and differs from it is a conflict: nothing is written, and the paths are listed. `--force` overwrites them.
- `status` prints `same`, `changed`, `missing` or `stale` per file and exits 1 unless all are `same`.
- `uninstall` removes only the files the manifest lists.
- The skill is copied by `install` and left alone by `status` and `uninstall`.

## Take a new upstream nightly

`origin/main` mirrors upstream. The steps keep upstream's history intact and move `factory` only when everything passes.

1. Fetch the tags and pick the newest nightly, `<tag>`.
2. `git switch -c sync/upstream factory`, then `git merge <tag>`.
3. Resolve conflicts. They should only be in the files listed under `seams` in `factory/seams.json`; keep both sides' lines. For a generated file, take upstream's version; the next step rebuilds it.
4. Regenerate the generated files: the route tree (the web build or dev server rewrites it) and, with `vp run i18n:generate` in `apps/web`, `apps/mobile` and `apps/desktop`, the translation catalogs.
5. `node scripts/factory-i18n.ts merge --base <tag>` rebuilds every catalog as upstream's plus Factory's keys with their translations.
6. `node scripts/factory-i18n.ts check --base <tag>`, then `node scripts/factory-seams.ts --base <tag>`. If a seam no longer differs from upstream, it is stale: remove it from `factory/seams.json`.
7. Run the checks the [CI](#what-factory-ci-checks) runs, below, and fix what broke.
8. `git switch factory`, then `git merge --ff-only sync/upstream`.

Do not hand-merge `pnpm-lock.yaml`; Factory adds no dependencies, so it must equal upstream's.

## Development server inside the checkout

When the dev server's home is inside the checkout, the default for `vp run dev` in a worktree, the worktrees that workflow agents work in are created under `<checkout>/.t3/worktrees`, and tools that walk the repository can stall on them. This was seen with `vp run i18n:generate`, whose `gt generate` hangs in its package-version check until it is run as `gt --skip-version-check generate` or those worktrees are removed. A real install keeps its home outside the repository and is not affected.

## Add a translated string

Write the string in Factory code through `gt-react` as upstream's [translation page](../internals/14_i18n.md) describes. Then:

1. Run `vp run i18n:generate` in the app (`apps/web`, `apps/mobile` or `apps/desktop`).
2. Run `node scripts/factory-i18n.ts merge --base origin/main`. It lists the app's Factory keys in `factory/i18n/<app>/source.json` with their English, and prints how many are untranslated per locale. Pass `--app web`, `--app mobile` or `--app desktop` (repeatable) to limit the apps.
3. Add each key and its translation to `factory/i18n/<app>/<locale>.json`, one file per locale. Keys are the generated hashes.
4. Run `merge` again, then `node scripts/factory-i18n.ts check --base origin/main`.

`check` fails when a catalog is not upstream's plus Factory's sorted keys, when a Factory key is missing, when `source.json` is stale, or when an overlay disagrees with its catalog. It also fails on a locale's translation that is absent, or identical to English while the English has letters outside its `{placeholders}`; a string such as `{task} {title}, {column}` may stay as it is. A translation must keep every placeholder name and every embedded element of the English. Word order and the number of text segments may differ. `--base` defaults to `origin/main`.

## What Factory CI checks

`.github/workflows/factory.yml` runs on pull requests and pushes to `factory`, and by hand. Upstream's workflows are disabled in the fork. It checks, in order:

- the lockfile equals `origin/main`'s;
- `node scripts/factory-seams.ts --base origin/main`;
- typecheck of contracts, server, web, scripts and evals;
- the server's `factory` tests, the seam, pack, home and i18n script tests, and `evals/factory-pack`;
- the web `src/factory` unit tests;
- `vp run i18n:check`, upstream's catalog check;
- `node scripts/factory-i18n.ts check`, the fork's translations.
