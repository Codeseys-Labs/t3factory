# Test signal

Runs the Macroscope `test-signal` check ([`.macroscope/check-run-agents/test-signal.md`](../../.macroscope/check-run-agents/test-signal.md)) on real and synthetic test diffs, and checks that a cheap model flags low-signal tests and leaves good ones alone. Use it to cut the check to the fewest words that still work.

The model gets the check body, the PR's test diff, `read_file` and `grep` at the PR head, and `post_comment`. The wrapper prompt around the body is a stand-in for Macroscope's, which is not public.

## Run

```sh
cd evals
pnpm test-signal --out runs/baseline
pnpm test-signal --out runs/cut --prompt /path/to/variant.md --case new-table-row
```

- Models go through the `vibeproxy` CLIProxyAPI provider in `~/.codex/config.toml`. Default models: `gpt-6.1-terra` and `gpt-6-luna`. Pass `--model` once per model to change them.
- Flags: `--prompt <file>` (a variant of the check, default the real one), `--case <id>` (repeatable), `--samples <n>` (default 2, and a 3rd when the first 2 disagree), `--concurrency <n>` (default 6), `--reasoning <level>` (default `low`, as the check runs).
- A bad case passes when a comment lands inside a target test. A guard case passes when the check posts nothing and replies exactly `All clear`.
- `summary.md` gives the prompt hash and word count, then per model: bad cases caught, guards clean, errors, and tokens.
- Cost: proxy quota only, about 0.5M tokens for a full run on both models.

## Offline fixture preflight

From `evals/`, run without reading proxy configuration or calling a model:

```sh
pnpm test-signal --preflight --case mock-call-mirror --out /path/outside/checkout/preflight \
  --inspect packages/client-runtime/src/state/threadRequests.ts
```

`--case` is repeatable; unknown IDs and empty selections fail. Omit it to inspect every case.
`--inspect <path>` is repeatable and requires preflight; it additionally requires that source
path to be readable in every selected case. Use separate invocations for case-specific context.
All Git operations disable lazy fetching (`GIT_NO_LAZY_FETCH=1`); hydrate exact historical
objects separately. Missing objects and failed Git commands are errors, never `File not found`
or `No matches`. A genuinely absent historical path and a successful grep with no matches keep
those tool responses. Current `AGENTS.md` and `docs/internals/testing.md` override historical
policy, and synthetic insertions override their historical files for reads and searches.

Each selected case writes a directory under `--out` containing:

- `test.diff`: the nonempty first-parent test diff, or synthetic insertion diff with actual paths.
- `targets.json`: every configured title's exact grader range and added lines within it. Guard
  cases have no configured targets and retain an empty array.
- `provenance.json`: full head/tree/first-parent identities, before/head blob identities and
  content hashes, overlay hashes, current runner/case/grader/prompt/rule hashes, and runtime.
- `served-files.json`: source identities and read/grep evidence for selected test paths, current
  rules, target paths and any `--inspect` paths.
- `offline-preflight.json`: completion or failure and the explicit inspection limits. A failed
  rerun invalidates earlier artifacts in that case directory; require `status: "complete"`.

Both preflight and model runs reject missing commits/blobs/targets, empty real diffs, targets
with no added lines, and synthetic anchors occurring zero or multiple times before proxy setup.
Normal model runs also abort a sample if a later tool request reaches unavailable source.

Completion proves only the bounded fixture inputs inspected by this invocation. It does not
establish arbitrary historical source closure: a later read or grep in an uninspected scope
can still fail offline. Historical test bodies are review input and are not executed. Preflight
does not qualify a model, establish original PR intent or fail-before/pass-after model behavior,
or change Factory dataset readiness labels. Model results remain separate evidence.

## Add a case

Add an entry to `cases.ts`. A `real` case names a merged commit and its test paths. A `synthetic` case inserts one test after an anchor string in a real file. Bad cases list the titles of the tests to flag.
