# Factory role qualification v1.0.0

Bounded dataset for [#80](https://github.com/baladithyab/t3code-factory/issues/80).
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
