# Benchmarks

The canonical benchmark workflow is generated from `benchmarks/catalog.py` and
implemented by `benchmarks/harness.py`. Run the commands below from the
repository root. The harness builds deterministic BlankClip inputs and writes
JSON plans and results; it does not use hand-written benchmark fixtures.

## One-command local benchmark

Run a fast benchmark against the current checkout with one command:

```sh
python -m benchmarks quick \
  --function Median \
  --format f16
```

The command builds the current checkout with `zig build -Doptimize=ReleaseFast`,
generates the plan, runs the selected cases with three measured iterations and
no warmup, and saves a report to
`benchmarks/results/<commit>-quick.json` with raw plan/result JSON beside it.
Omit `--function` and `--format` to run the complete generated catalog. Use
`--no-build` when `zig-out/lib` is already built and only the benchmark needs to
be repeated:

```sh
python -m benchmarks quick \
  --function Median \
  --format f16 \
  --no-build \
  --iterations 3 \
  --warmup 0
```

Use `--output PATH` to choose a different durable report path. The existing
`reference` and `compare` commands remain the reproducible detached-worktree
workflow for revision measurements.

## Canonical harness workflow

The commands in this section are lower-level building blocks for debugging or
custom integrations; normal local iteration should use the one-command
`python -m benchmarks quick` workflow above.

Discover the zsmooth functions exposed by a built plugin:

```sh
python -m benchmarks.harness discover \
  --plugin-path PATH
```

`PATH` is normally a revision's `zig-out/lib` directory. Discovery prints
canonical JSON to standard output and verifies that the VapourSynth Python
runtime can load the plugin.

Create a deterministic plan:

```sh
python -m benchmarks.harness plan \
  --output PATH \
  --plugin-path PATH \
  [--function NAME] \
  [--format FORMAT]
```

`--function` and `--format` may each be repeated. Omitting `--function`
selects the complete generated catalog. Omitting `--format` selects every
format supported by each selected function. Formats may be restricted to
`u8`, `u16`, `f16`, or `f32`; unsupported function-format pairs are omitted,
and the command fails only when no selected case supports the requested
formats. The plan contains canonical case IDs and a `plan_id`, and its sorted,
canonical JSON serialization is deterministic for the same catalog, functions,
and formats.

Run a plan:

```sh
python -m benchmarks.harness run \
  --plugin-path PATH \
  --plan PATH \
  --output PATH \
  --timing direct \
  --iterations N \
  --warmup N
```

`--timing direct|stream` accepts either timing mode. `--iterations` must be a
positive integer; `--warmup` may be zero to disable warmup. Direct timing clears
cache, builds one graph, and measures one middle-frame `get_frame` request.
Stream timing clears the cache, builds one graph, measures sequential requests
for the plan's frame window, and reports the elapsed time per frame. Graph
construction, cleanup, and cache clearing are outside both timers. Results
contain the plan ID, timing configuration, environment metadata, per-case
samples, millisecond statistics, and median FPS; key ordering and schema are
stable, while measured values naturally vary between runs. Writing `--output`
to a path under the repository preserves the plan or result JSON as a durable
raw artifact.

## Measuring revisions

`benchmarks/benchmark.py` builds each requested revision in a detached
worktree with `zig build -Doptimize=ReleaseFast`, then invokes the canonical
harness against that worktree's `zig-out/lib`. Measure a complete catalog
reference:

```sh
python benchmarks/benchmark.py reference HEAD \
  --timing direct \
  --iterations 7 \
  --warmup 1 \
  --output benchmarks/references/reference.json
```

Compare a candidate with an explicit baseline:

```sh
python benchmarks/benchmark.py compare HEAD main \
  --timing direct \
  --iterations 7 \
  --warmup 1 \
  --format f32 \
  --format f16 \
  --output benchmarks/results/HEAD.json
```

The positional arguments are `CANDIDATE [BASELINE]`; `--candidate` and
`--baseline` are equivalent named options. The candidate defaults to `HEAD`.
When no baseline is supplied, the repository's default branch is selected
(`origin/HEAD`, `main`, or `master`, with local fallbacks). Comparison computes
the Git merge-base of the resolved revisions, maps candidate changes since
that merge-base to affected zsmooth functions, and benchmarks only common
functions. Global build/source changes select the complete catalog; added and
removed functions are reported without attempting an invalid comparison.
Repeated `--format FORMAT` options restrict the selected cases to explicit
formats. The reference command always measures the complete catalog.

Both revision commands write a durable report JSON (by default under
`benchmarks/references/<environment-id>/<commit>.json` or
`benchmarks/results/<candidate-commit>.json`). Reports record resolved
revisions, merge-base and changed-file/function selection, build settings,
timing, environment identity, plan ID, comparison rows, and paths to the raw
plan/results. Durable raw copies remain beside the report; temporary detached
worktrees and intermediate files are removed after a run by default. Pass
`--keep-worktrees` to retain the temporary root and its intermediate JSON for
archival or inspection.

The workflow requires Zig for the `ReleaseFast` builds and a Python runtime
with the VapourSynth package importable. Use `--python PATH` (or
`VAPOURSYNTH_PYTHON`) when the VapourSynth runtime is not the `python`
executable being used. The harness sets the plugin search path from
`--plugin-path`; no separate runner, stream tool, or hand-written case files
are required.
