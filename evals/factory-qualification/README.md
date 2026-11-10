# Factory role qualification v1.0.0

Bounded dataset for [#80](https://github.com/Codeseys-Labs/t3factory/issues/80).
This increment contains **60 authored scenarios**, not the requested target of 120.
None has been run on a model as part of this increment. Source paths, source hashes,
original case IDs, and acceptance contracts make the curation reviewable.

| Role                            | Included | Target | Remaining |
| ------------------------------- | -------: | -----: | --------: |
| Triage / selection              |       10 |     20 |        10 |
| Prerequisites / evidence        |       12 |     25 |        13 |
| Coordination / recovery         |       15 |     30 |        15 |
| Implementation / test repair    |       13 |     25 |        12 |
| Independent review / acceptance |       10 |     20 |        10 |
| Total                           |       60 |    120 |        60 |

The split is 30 development / 15 calibration / 15 holdout. The exact split remainder
is 30 / 15 / 15. `v1/protocol.json` records the base source commit, issue excerpts,
counts and remaining coverage areas; each case pins the reviewed file's hash,
including any subsequent grader corrections. Expanding coverage requires new independent
mechanisms and reviewed fixtures; rephrasing a scenario does not fill a slot.

## Execution routes

| Route           | Count | Readiness           | Actual scope                                                                                |
| --------------- | ----: | ------------------- | ------------------------------------------------------------------------------------------- |
| `mcp-replay`    |    20 | `ready`             | Existing runner, tool events and its existing grader; simulated shell and task results      |
| `test-signal`   |     5 | `blocked-fixture`   | Offline preflight available; local object hydration and source-access verification required |
| `decision-spec` |    10 | `unrunnable-driver` | Advisory input and acceptance rubric; no decision adapter or grader                         |
| `native-spec`   |    25 | `unrunnable-driver` | Concrete seed files, tasks and file/checkpoint/lifecycle assertions; no native driver       |

`ready` means runnable replay infrastructure exists. It is not a passing sample,
model entitlement, native-agent qualification, or independent task acceptance.
Native specifications require actual result-tree files, service-observed immutable
checkpoint identity and recorded native CLI/provider/build identity. Implementation
specifications also require a failing seed assertion and actual focused checks after
repair. These are required future artifacts, not fabricated execution records.
The JSON includes seed file contents; it does not materialize or execute them.
Large-file and lifecycle recipes need a hydrator/service sandbox as recorded in
each specification's missing prerequisites.

### Offline native adapter

`native.ts` supports only `repair-cache-expiry` and `native-parent-child-review`.
It creates a new external standalone Git repository from the selected **committed**
catalog seed, with sibling `repo/`, `evidence/`, and `export/` directories. The
output's parent must already exist; existing output and evaluation artifacts are
never overwritten. No dependencies, remotes, hook templates, setup, or T3 launch
are involved. From the repository root, with the pinned toolchain:

```powershell
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/native.ts hydrate --case repair-cache-expiry --out C:/evidence/cache-sample-1
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/native.ts evaluate --sample C:/evidence/cache-sample-1 --result-commit <exact-result-SHA>
```

Both hydration and evaluation of `native-parent-child-review` require
`--include-holdout`. This published holdout remains exposed. Successful hydration
returns `blocked` with `stage: "hydrated"` and exits 2; it only prepares a seed.
Evaluation reads the catalog at the receipt's recorded source commit, so later
catalog edits do not redefine an existing sample. Missing source objects block it.
Evaluation exports Git objects at the
seed and supplied result commits, checks every path/mode/blob for ownership, and
runs fixed Node `node:test` probes against each export. Cache additionally runs
`tests/cache.test.ts`; it must contain passing tests. Commands come from this
adapter, never package scripts or captured argv. A trusted runner collects structured
Node test events from separate test processes; candidate stdout cannot supply test
counts. Fixed probes must complete all named assertions. Test processes use a minimal
environment and Node permissions restricting reads and denying subprocess/network
access. These probes are mechanical checks, not a security sandbox or model evidence.

Optional `evidence/capture.json` contains `subject` and `reviewer`, each with
`taskStatus`, `run`, and `checkpoint` artifact references; plus `review`,
`subjectProtocol`, `reviewerProtocol`, `reviewTreeBefore`, and `reviewTreeAfter`.
Every reference has `path` (relative to evidence), `sha256`, `sourceKind`, and
`complete: true`. Task results use `mcp_result`; raw run/checkpoint objects use
`service_snapshot`; protocols use `native_protocol` NDJSON; the structured reviewer
response uses `review_response`; before/after Git porcelain status uses
`process_output`. The reviewer response binds `reviewerTaskId`, `reviewerThreadId`,
`reviewerTerminalRunId`, `reviewedSubjectTuple` (`taskId`, `childThreadId`,
`terminalRunId`, `baseCommit`, `resultCommit`), `verdict`, and `findings`.
Only an approval with no findings and unchanged clean reviewer evidence passes
record consistency. Current service schemas decode task/run/checkpoint records;
their IDs, checkpoint root nodes, selected models/options, and resolved checkpoint refs must agree.
Continuation ancestry is not established by these consistency checks.

**This slice cannot produce a passing native sample.** Hashes check byte consistency,
not authenticity or attestation. Raw provider model/session identity, service/build
provenance, historical parent/child operations and sequence coverage, reviewer session
independence, candidate before-fix regression provenance, and absence of product
acceptance/publication remain unverified. Their gates stay `missing`, even when
supplied records are internally consistent. Missing capture blocks; malformed,
truncated, mismatched, rejected, or dirty-review capture fails. A subsequent parent
stage must collect and validate these records through normal T3 execution; creation
of a top-level parent requires a separate explicit user request.

`evidence/evaluation/` retains raw process output, trusted probe source, file
manifests, and `outcome.json`. Evaluation exits 1 for `fail`, 2 for `blocked`, and
3 for `infrastructure_error`; import/permission/spawn failures cannot satisfy the
expected seed assertion failure. A machine evaluator has a null task tuple and
cannot replace the subject's checkpoint. Self-tests and handcrafted repairs do not
establish native qualification. Catalog readiness labels remain unchanged.

For historical `test-signal` references, hydrate the exact source objects and use
the runner's [offline preflight](../test-signal/README.md#offline-fixture-preflight)
with the case's original reference ID and inspected context paths. Require a fresh
successful receipt for the checkout being evaluated. A bounded preflight covers its
selected files; broader historical reads or searches can still fail when objects
are unavailable. Local preflight evidence does not change the catalog's readiness
labels or establish model quality.

## Offline use

Use the checkout's pinned **Node 26.12.1 / pnpm 12.14.0**. From the repository root:

```powershell
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/run.ts
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 pnpm exec vp test run evals/factory-qualification/dataset.test.ts
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/run.ts --split calibration
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/run.ts --split holdout --include-holdout
```

The default selector includes development only. Holdout requires both flags. The
validator checks all splits for integrity but does not run any scenario. Export
only ready MCP references, preserving the existing payload and grader exactly:

```powershell
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 node evals/factory-qualification/run.ts --export-replay > C:/evidence/qualification-development.ndjson
```

Then, from `evals/`, use the existing runner for a free request-build check:

```powershell
vp env exec --node 26.12.1 --package-manager pnpm@12.14.0 pnpm mcp-tool-use --cases C:/evidence/qualification-development.ndjson --dry-run
```

The export command does not call a model. The existing runner calls paid models
without `--dry-run`; authorization and predeclared sampling remain separate.
Do not run the original runner without `--cases` for this dataset: its broader
default suite is outside this selection contract. No package scripts were changed.

## Integrity and leakage limits

Cases carry role, family, repository example, severity, difficulty, origin, split,
route, expected/forbidden actions, state transitions and explicit execution readiness.
The validator rejects duplicate IDs/references/scenarios, wrong role/split totals,
cross-split family/example reuse, substituted references, changed source hashes, unsafe
seed paths, blank contracts and unsupported execution claims. Native specifications
must retain checkpoint and runtime identity gates plus the role's behavior, test,
ownership, lifecycle, preservation or review gates. These labels require future
artifact checks; they do not execute or prove those assertions. Original scenario variants are not
counted twice: for example only one not-modeled Work kind is included.

All reused MCP and test-signal scenarios stay in development. Related snapshot
fan-out/fan-in scenarios share a family. Calibration/holdout use distinct synthetic
repository examples and mechanisms. The split is manually curated, not random.
Source grounding can span splits: the shared T3 implementation is a reference,
not a separate held-out repository. Family labels are human judgments; integrity
tests cannot establish semantic independence or real-world representativeness.

**This holdout is not sealed.** Its inputs, seeds and assertions are committed and
visible to developers and agents. The selector prevents accidental default use,
not access. Existing development suites may already have influenced current
instructions. Before confirmatory evaluation, an independent custodian must create
private behavior tests, freeze rubrics and quality floors, audit family separation,
record prior exposure and seal a fresh holdout. No leakage-free qualification is
claimed here. `hidden-tests.json` names a future driver artifact; these published
assertions themselves are not hidden tests.

Hashes pin the inspected source files so changes force re-review. They do not prove
that a historical test fixture is available, that a native task ran, or that an
external issue still has the same text. The test-signal references resolve locally
by ID; their historical commit trees were not fetched or exercised in this increment.

To re-pin after an intended edit, confirm the case's `source.anchor` text still occurs
in the file, then set its `source.sha256` to the file's new SHA-256. `vp run check:changed`
runs `dataset.test.ts` whenever a pinned file or `v1/cases.json` changes.
