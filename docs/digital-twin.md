# Codebase Digital Twin

The Digital Twin is CodeSentinel's structured representation of a repository:
files, symbols, relationships and components, all derived from the code itself.
Nothing in it is inferred by an LLM. Every row is produced by a parser or by a
query over rows a parser produced.

## Layers of the model

| Layer | Table | Produced by |
| --- | --- | --- |
| Files | `files` | scanner discovery (`src/scanner/discovery.ts`) |
| Symbols | `symbols` | AST-ish parsers (`src/twin/parsers/`) |
| Relationships | `code_edges` | `src/twin/indexer.ts` |
| Components | `components` | `src/twin/components.ts` |
| Index bookkeeping | `index_state` | `src/twin/indexer.ts` |

Parsing never executes repository code. Files are read as text and analysed
statically, so an untrusted repository cannot run anything inside CodeSentinel.

## Relationships

`code_edges` stores typed edges between opaque string keys rather than foreign
keys, so an edge can point at things that are not rows: a package, an HTTP
route, a database table.

| Key form | Meaning |
| --- | --- |
| `path/to/file.ts` | a file |
| `path/to/file.ts#symbolName` | a symbol within a file |
| `pkg:<name>` | an external package |
| `api:<METHOD> <path>` | an HTTP route the repository exposes |
| `db:<table>` | a database table (or `db:(unknown)`) |

Edge types: `imports`, `calls`, `depends_on`, `tests`, `exposes_api`,
`uses_database`, `contains_finding`. Each edge carries `evidence` (the source
line that justified it) and a `confidence` of `certain` or `probable`.

**Unresolvable relationships produce no edge.** If an import specifier cannot be
resolved to a file in the repository or to a declared dependency, nothing is
written. A missing edge is always preferable to an invented one.

## Components

A 16-file demo repository is readable as a file graph. An 800-file repository is
not — it renders as a hairball that tells you nothing. So files are grouped into
logical **components** before anything is drawn.

Grouping rules (`componentRootOf` in `src/twin/components.ts`):

- a leading source root (`src`, `lib`, `app`, `packages`, `source`) is stripped,
  so `src/routes/auth.js` becomes the `routes` component;
- up to two directory levels are kept, so `src/services/billing/invoice.js`
  becomes `services-billing` rather than collapsing into `services`;
- root-level files (and files directly under a bare source root) group under
  `root`.

Each component is assigned one of eight layers — Frontend, API, Services, Data,
Infrastructure, Tests, Config, Other — by `layerOf`, first match wins, ordered
most-specific first. `detectArchitecture` (used by the AI architecture
explanation) calls the same `layerOf`, so the map and the prose cannot describe
the same repository with two different vocabularies.

A component's `dependencyCount` is the number of distinct *other* components its
files genuinely import, counted from `imports` edges. Self-imports and
unresolved imports do not count.

## Component risk score

Risk is a 0–100 number with a stated reason for every point. It is stored on the
component together with a `riskFactors` array, and the UI must show those
factors rather than the bare number — a score nobody can interrogate is a score
nobody should trust.

| Factor | Points | Cap |
| --- | --- | --- |
| Open findings | `critical×10 + high×5 + medium×2 + low×0.5` | 35 |
| Dependents | `log2(n + 1) × 7` | 20 |
| Test gap | `untestedFiles / fileCount × 20` | 20 |
| Change frequency | `log10(commits + 1) × 8` | 12 |
| Security sensitivity | flat `13` if the component handles auth, sessions, permissions, crypto, payments or admin | 13 |

The total is capped at 100 and banded:

| Band | Score |
| --- | --- |
| `critical` | ≥ 65 |
| `high` | ≥ 40 |
| `medium` | ≥ 18 |
| `low` | below 18 |

Why these shapes:

- **Findings dominate but cannot saturate.** 35 of 100 points means a component
  with many findings and no exposure still ranks below one with findings *and*
  dependents *and* no tests. Severity is what CodeSentinel measured, so it is
  weighted most heavily.
- **Dependents are logarithmic.** The difference between 1 and 4 dependents is
  meaningful; the difference between 40 and 80 is not. Blast radius grows fast
  at the start and then stops being informative.
- **The test gap is proportional, not absolute.** Two untested files out of two
  is a bigger problem than two untested files out of forty.
- **Churn is the weakest signal** (12 points) because a frequently changed file
  is not necessarily a risky one — it is only a hint that a mistake here is
  likely to be made again soon.
- **Security sensitivity is a flat bump**, not a multiplier. A path matching
  `auth|session|payment|crypto|permission|admin` raises the floor without
  drowning out measured evidence.

Test files are never marked security-sensitive, even when they exercise auth:
the test for a login flow is not itself an attack surface, and counting it as
one pushes real hotspots down the heatmap.

Rebuilds are a full replace of the repository's `components` rows. The set is
small (tens of rows) and entirely derived, so replacement is cheaper and safer
than diffing.

### Worked example (demo fixture)

From the 16-file demo repository, `src/routes/` scores 75 (`critical`):

```
+30.0  Open findings          1 critical, 4 high, 2 medium
+13.0  Security sensitive     Handles authentication, payments, permissions or crypto
+20.0  Test gap               2 of 2 files have no test covering them
+ 7.0  Dependents             1 component imports this one
```

## Incremental indexing

Re-indexing an unchanged repository must not re-parse it. `index_state` stores a
`contentHash` per file; on each run:

1. files whose hash is unchanged are skipped entirely (no parse, no writes);
2. files whose hash changed have their symbols and outgoing edges deleted by
   `fromKey`/`filePath` and rewritten;
3. files that disappeared are swept out of `symbols`, `code_edges` and
   `index_state`.

Measured on the demo repository: **cold index 298 ms** (16 files parsed) →
**warm re-index 15 ms** (0 parsed, 16 unchanged), producing identical symbol and
edge counts.

Components are rebuilt after each index pass, from the scan currently being
persisted. The scan id is passed explicitly rather than looked up, because the
rebuild runs while that scan is still `running` — resolving "the latest
completed scan" there would silently describe the *previous* scan, whose file
rows have already been pruned.

## Current baseline

Indexing `fixtures/demo-repo` (16 files, 329 LOC) produces:

- 35 symbols
- 50 edges — 19 `calls`, 14 `imports`, 10 `depends_on`, 4 `exposes_api`,
  2 `tests`, 1 `uses_database`
- 7 components:

| Component | Layer | Files | Deps | Dependents | Findings | Untested | Risk |
| --- | --- | --- | --- | --- | --- | --- | --- |
| routes | API | 2 | 2 | 1 | 10 | 2 | 75 critical |
| services | Services | 2 | 1 | 1 | 8 | 2 | 75 critical |
| lib | Services | 3 | 0 | 4 | 8 | 2 | 64.6 high |
| auth | Services | 2 | 1 | 3 | 3 | 1 | 57 high |
| root | Infrastructure | 3 | 0 | 0 | 11 | 3 | 55 high |
| frontend | Frontend | 2 | 3 | 0 | 2 | 2 | 43 high |
| tests | Tests | 2 | 2 | 0 | 0 | 0 | 0 low |

Regenerate with `npx tsx scripts/scan-demo.ts`.

## Supported languages

TypeScript, JavaScript and Python are parsed. Any other language yields an empty
parse result rather than an error, so an unsupported file still appears in the
file layer with no symbols attached. Adding a language means implementing one
parser module against the interface in `src/twin/parsers/types.ts` and
registering it — no other part of the system changes.
