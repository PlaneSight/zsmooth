# Performance Roadmap

## Purpose

This roadmap addresses the Zig 0.16 loop-autovectorization regression (#23) and
FP16 performance uncertainty (#29). The intended architecture is explicit SIMD
for hot pixel kernels, with scalar implementations retained as correctness
oracles and for borders and tails.

Performance changes are not accepted on source appearance alone. Each milestone
must preserve filter output semantics and establish a reproducible measurement
baseline before choosing a target-specific implementation.

## Engineering constraints

- Keep scalar reference paths for every algorithm and test SIMD paths against
  them, including borders, tails, chroma, and interlaced behavior.
- Keep integer formats in integer arithmetic throughout their hot loops. Widen
  FP16 storage to FP32 only at a deliberate load/compute/store boundary when
  target-specific measurements justify it.
- Use explicit `@Vector` kernels for main loops. Every kernel writes its
  borders and uses a scalar tail unless an overlapping vector tail is proven
  safe for that filter's output contract.
- Preserve ordered tie behavior when replacing scalar candidate-selection
  chains with vector masks.
- Do not use `target=native` for distributed artifacts. Continue supporting the
  packaged Haswell, Zen 4, and AArch64 targets until a measured replacement is
  available.
- Keep CPU-feature selection outside row and pixel loops. A future fat binary
  may dispatch whole plane kernels once during filter initialization.

## Current baseline

The following work has already landed:

- RemoveGrain has explicit vector interiors with scalar borders and tails for
  all non-FP16 modes. Modes 13--16 use dedicated parity traversal and copy the
  untouched field separately.
- Repair has explicit SIMD coverage for its non-FP16 modes.
- `vec.store` writes complete vectors directly rather than issuing a source
  lane loop.
- FP16 benchmark cases are derived from each Zsmooth FP32 benchmark case, and
  RemoveGrain includes interlaced modes 13--16.
- The benchmark runner supports isolated revision comparison and defaults to
  fast, direct-frame samples for local iteration.
- Clense, TemporalRepair mode 0, and VerticalCleaner mode 2 retain their
  FP16-storage to FP32-vector-compute paths. VerticalCleaner mode 1 now uses
  an exact native-FP16 median vector path only when the compile target
  advertises `fullfp16`; other targets retain its widened path. RemoveGrain
  and Repair have selected native-FP16 vector modes.
- Several vectorized filters have safer non-overlapping tail handling, while
  CNR4 has hoisted invariant vector loads and unrolled temporal loops.

This baseline establishes implementation coverage. The current target-specific
evidence is deliberately narrow: on an Apple M5 / Zig 0.16.0 host,
three-sample direct-frame tests measured native RemoveGrain at 2.430x of
scalar across ten F16 cases, while a seven-sample comparison of `6618c60` and
`b5eee37` measured VerticalCleaner F16 mode 1 at 1.702x of its prior
F32-widened vector path (1.285x over the two VerticalCleaner cases). These
reports are local latency signals, not a cross-target compiler policy.

## Current decisions and blockers

- No rolling-grid-loader change is justified yet. The captured release artifact
  confirms vector FP16 arithmetic in the plugin, but it is not a focused
  before/after counter or disassembly experiment for RemoveGrain addressing.
  The existing explicit row/vector loops remain clearer and are retained.
- Clense's direct-frame FP16 comparison is blocked on this host because its
  fixture constructs the unavailable external `rgsf.Clense` reference even
  when only the Zsmooth output is selected. This is an environment limitation,
  not a Zsmooth performance result.
- The fat-plugin experiment is deferred. Separate Haswell, Zen 4, and AArch64
  artifacts remain the supported release model until hardware measurements
  demonstrate that coarse dispatch improves its binary-size and maintenance
  tradeoff.
- No x86 or non-Apple-AArch64 policy follows from the local measurements.

## Milestone 1: Reproducible measurement baseline

**Goal:** make compiler, target, data-type, and implementation decisions from
comparable evidence.

1. Compare the same revision pairs on Zig 0.15.2, Zig 0.16.x, and the selected
   development compiler.
2. Run the matrix on Haswell/AVX2, Zen 4/AVX-512, and AArch64 NEON where
   hardware is available.
3. Include U8, U16, F16, and F32 cases for representative RemoveGrain modes,
   Repair, Median, Clense, VerticalCleaner, and TemporalMedian.
4. Use `benchmarks/compare_revisions.ts` for baseline-versus-candidate runs.
   Fast direct-frame mode is the local default and is suitable for quick
   relative signals; keep it separate from full-stream throughput reports.
5. Record FPS and frame latency from the harness. For hot-kernel decisions,
   also collect cycles/output-pixel, instructions/output-pixel, branch misses,
   binary size, and annotated disassembly with an appropriate platform tool.

**Exit criteria**

- Each reported comparison records compiler revision, target/CPU, optimization
  mode, benchmark command, frame dimensions, format, and sample count.
- A report distinguishes fast direct-frame latency from `vspipe` throughput.
- The data identifies the first regression or win worth changing; no policy is
  selected solely from a single laptop run.

## Milestone 2: Complete and validate core SIMD coverage

**Goal:** eliminate remaining dependence on scalar autovectorization in the
highest-value neighborhood kernels.

1. Maintain RemoveGrain's current explicit-SIMD structure: vector main loop,
   scalar borders, scalar tail, comptime mode specialization, and one runtime
   dispatch into that specialized mode.
2. Finish only the FP16 RemoveGrain modes that measurements show are material:
   5--12, 18--19, 21, and 23--24 currently remain scalar.
3. Finish only the FP16 Repair modes that measurements show are material:
   5--10, 15--16, 18--19, 21, and 23--24 currently remain scalar.
4. Keep vector candidate selection branchless and preserve the existing RGVS
   tie priority through ordered `@select` operations.
5. Extend scalar-versus-SIMD tests to every newly vectorized mode, vector width
   boundary, stride, and interlaced field case.

**Exit criteria**

- Every promoted mode has an explicit scalar-reference equivalence test.
- Benchmark data shows the mode is not a regression on its intended target.
- The generated hot loop contains vector loads, arithmetic, and stores rather
  than compiler-reconstructed scalar lane operations.

## Milestone 3: Establish an FP16 compute policy

**Goal:** select native FP16 or FP16-to-FP32 kernels per target from evidence.

1. For each candidate kernel, benchmark native FP16 vectors against one-time
   FP16 load widening, FP32 vector compute, and FP16 store narrowing.
2. Inspect conversion count, spills, vector width, and instruction selection in
   release disassembly.
3. Document the required output contract before enabling a widened path: exact
   equality where possible, otherwise an explicitly approved FP16 tolerance.
4. Centralize only the storage/compute boundary helpers. Do not put runtime
   feature checks or per-pixel type decisions into generic hot-loop helpers.
5. Retain a scalar FP16 fallback for correctness and unsupported targets.

**Exit criteria**

- Each supported target has a documented winning FP16 strategy for the kernels
  where it matters.
- Native FP16 remains available only where it is measured to be beneficial or
  required for output compatibility.
- Integer kernels remain free of floating-point conversion in their hot paths.

## Milestone 4: Investigate secondary loop and memory improvements

**Goal:** remove measurable overhead without obscuring the vector kernels.

1. Inspect RemoveGrain and Repair disassembly and counters for surviving bounds
   checks, address recomputation, or register spills.
2. If evidence supports it, replace repeated interior subslices with a
   pointer-based or rolling-row grid loader whose outer loop proves legality.
3. Hoist row bases and other loop invariants only when this improves generated
   code or measured cycles/pixel.
4. Recheck tails and borders after every address-calculation change.

**Exit criteria**

- Each change has before/after assembly or counter evidence and a scalar
  equivalence test.
- No optimization removes the explicit border-write contract.

## Milestone 5: Broader measured rollout

**Goal:** apply the proven kernel pattern to filters with measured regressions.

Priority order:

1. Remaining FP16 RemoveGrain and Repair modes.
2. Clense and VerticalCleaner FP16 paths and any non-FP16 regression found by
   the measurement matrix.
3. DegrainMedian, TemporalRepair, and TemporalMedian where their memory and
   sorting behavior still leaves a measured opportunity.
4. Other filters only after a benchmark regression identifies them as a
   priority.

Each rollout uses a whole plane or row kernel as the SIMD unit. It must not
introduce indirect calls for individual loads, comparisons, or arithmetic
operations.

## Milestone 6: Optional multiversioning experiment

**Goal:** evaluate a portable fat-plugin design without disrupting the current
artifact model.

1. Keep separate Haswell, Zen 4, and AArch64 artifacts as the supported
   release path.
2. Prototype a separate experimental binary containing a baseline kernel and
   selected AVX2, AVX-512, and/or NEON plane-kernel variants.
3. Detect CPU features once at plugin or filter initialization, select a table
   of complete plane-kernel functions, and store it in filter state.
4. Compare output, throughput, binary size, and instruction-cache behavior
   against the existing target-specific artifacts.
5. Do not wait for Zig issue #1018. If the experiment is justified before
   first-class function multiversioning arrives, use explicit coarse function
   pointers; migrate only if the language feature provides a demonstrated
   benefit.

**Exit criteria**

- The fat binary is faster or operationally simpler enough to justify its
  binary-size and maintenance cost.
- Dispatch occurs outside hot loops and individual selected kernels retain
  comptime specialization and inlining internally.
- Separate artifacts remain available unless the experiment meets the same
  compatibility and performance bar on all release platforms.

## Release gate

Before presenting an optimization as complete:

- Run scalar/vector correctness tests in Debug and at least one release mode.
- Run the relevant benchmark matrix against the recorded baseline.
- Inspect release code generation for the changed hot loop.
- Update benchmark documentation and the changelog with measured results, the
  target scope, and any FP16 compatibility decision.
- Do not expand scope from a local improvement to a global policy without
  cross-target evidence.
