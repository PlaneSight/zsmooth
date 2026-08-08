#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { hostname, release as osRelease, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type CliValue = string | string[] | boolean | undefined

type CompilerInfo = {
  requestedPath: string
  actualPath: string
  version: string
  target: string | null
  cpu: string | null
}

type RunnerMetadata = {
  schemaVersion?: number
  timing?: {
    mode?: string
    sampleUnit?: string
    reportedUnit?: string
    reportedValueSemantics?: string
  }
  [key: string]: unknown
}

type Revision = {
  role: 'baseline' | 'candidate'
  name: string
  commit: string
  worktree: string
  pluginPath: string
  compiler: CompilerInfo
  buildOptions: string[]

}
type Summary = {
  cases: number
  geometricMeanSpeedup: number
  deltaPct: number
}

type BenchmarkResult = {
  filter: string
  plugin: string
  format: string
  args: string
  average: number
  stdDev: number
  min: number
  max: number
  median: number
  key: string
}

type Comparison = {
  filter: string
  plugin: string
  format: string
  args: string
  candidateFps: number
  baselineFps: number
  deltaPct: number
  speedup: number
}

const { values: cliArgs } = parseArgs({
  options: {
    baseline: { type: 'string', default: 'main' },
    candidate: { type: 'string', default: 'HEAD' },
    filter: { type: 'string', multiple: true },
    format: { type: 'string', multiple: true },
    plugin: { type: 'string', multiple: true },
    'frame-count-scale': { type: 'string', default: '1.0' },
    iterations: { type: 'string', default: '7' },
    warmup: { type: 'string', default: '1' },
    // Direct get_frame timing is the comparator default. --fast remains
    // accepted for compatibility with existing invocations.
    fast: { type: 'boolean', default: true },
    full: { type: 'boolean', default: false },
    'fast-python': { type: 'string' },
    'fast-frame': { type: 'string', default: '0' },
    perf: { type: 'boolean', default: false },
    optimize: { type: 'string', default: 'ReleaseFast' },
    'baseline-zig': { type: 'string', default: 'zig' },
    'candidate-zig': { type: 'string', default: 'zig' },
    'baseline-build-option': { type: 'string', multiple: true },
    'candidate-build-option': { type: 'string', multiple: true },

    "baseline-zsmooth-namespace": {
      type: 'string',
      default: 'zsmooth',
    },
    "candidate-zsmooth-namespace": {
      type: 'string',
      default: 'zsmooth_simd_f16',
    },
    target: { type: 'string' },
    cpu: { type: 'string' },
    output: { type: 'string', default: 'build/benchmarks/benchmark_comparison.json' },
    'markdown-output': { type: 'string', default: 'build/benchmarks/benchmark_comparison.md' },
    'metadata-output': { type: 'string', default: 'build/benchmarks/benchmark_comparison.metadata.json' },
    'keep-worktrees': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

function optionString(name: string, fallback?: string): string | undefined {
  const value = cliArgs[name] as CliValue
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value[0]
  return fallback
}

function optionStrings(name: string): string[] {
  const value = cliArgs[name] as CliValue
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return [value]
  return []
}


function printHelp(): void {
  console.log(`Compare two revisions using the existing VapourSynth benchmark runner.

Usage:
  bun benchmarks/compare_revisions.ts [options]

Options:
  --baseline <ref>             Baseline ref (default: main, then master fallback)
  --candidate <ref>            Candidate ref (default: HEAD)
  --filter <name>              Repeat to select filters
  --plugin <name>              Repeat to select plugins
  --format <name>              Repeat to select formats
  --frame-count-scale <n>      Scale fixture frame counts (default: 1.0)
  --iterations <n>             Measured iterations, minimum 3 (default: 7)
  --warmup <n>                 Warmup iterations (default: 1)
  --full                       Use full-stream vspipe timing instead of the default direct get_frame timing
  --fast                       Compatibility alias for the default direct get_frame timing
  --fast-python <path>         Python runtime for direct timing (default: $VAPOURSYNTH_PYTHON or python3)
  --fast-frame <n>             Frame requested by direct timing (default: 0)
  --perf                       Linux perf stat counters (cycles, instructions, branch-misses)
  --baseline-zig <path>        Zig executable for the baseline build (default: zig)
  --candidate-zig <path>       Zig executable for the candidate build (default: zig)
  --baseline-build-option <arg>  Repeat to pass an additional Zig build option to baseline
  --candidate-build-option <arg> Repeat to pass an additional Zig build option to candidate
  --baseline-zsmooth-namespace <name>  Plugin namespace used by the baseline fixtures (default: zsmooth)
  --candidate-zsmooth-namespace <name> Plugin namespace used by the candidate fixtures (default: zsmooth_simd_f16)


  --target <triple>            Requested Zig target passed to both builds
  --cpu <name>                 Requested Zig CPU passed to both builds
  --optimize <mode>            Zig optimize mode (default: ReleaseFast)
  --output <path>              Comparison JSON (default: build/benchmarks/benchmark_comparison.json)
  --markdown-output <path>     Comparison Markdown (default: build/benchmarks/benchmark_comparison.md)
  --metadata-output <path>     Additive raw-sample/perf sidecar (default: build/benchmarks/benchmark_comparison.metadata.json)
  --keep-worktrees             Preserve temporary worktrees for inspection
  --help                       Show this help
`)
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  overrides: Record<string, string> = {},
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: { ...process.env, ...overrides } as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}\n${stderr || stdout}`)
  }
  return { stdout, stderr }
}

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return runCommand('git', args, cwd).stdout.trim()
  } catch {
    return undefined
  }
}
function ensurePerfAvailable(enabled: boolean): void {
  if (!enabled) return
  if (process.platform !== 'linux') {
    throw new Error('--perf is supported only on Linux; disable it on this platform')
  }
  const perfVersion = Bun.spawnSync(['perf', '--version'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (perfVersion.exitCode !== 0) {
    throw new Error('--perf requested, but the perf executable is unavailable on PATH')
  }
}

function resolveExecutablePath(requested: string, cwd: string): string {
  const candidate = requested.includes('/') || requested.includes('\\')
    ? resolve(cwd, requested)
    : Bun.which(requested)
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Unable to locate executable ${requested}`)
  }
  return realpathSync(candidate)
}

function compilerInfo(
  requestedPath: string,
  invocationDir: string,
  worktree: string,
  target: string | null,
  cpu: string | null,
): CompilerInfo {
  const actualPath = resolveExecutablePath(requestedPath, invocationDir)
  const versionResult = runCommand(actualPath, ['version'], worktree)
  const version = (versionResult.stdout || versionResult.stderr).trim()
  if (!version) throw new Error(`Compiler ${actualPath} returned no version`)
  return { requestedPath, actualPath, version, target, cpu }
}

function parseRunnerMetadata(value: unknown): RunnerMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Benchmark runner JSON sidecar must contain an object')
  }
  return value as RunnerMetadata
}

function resolveRevision(requested: string, repoRoot: string): { name: string; commit: string } {
  const candidates = [requested]
  if (requested === 'main') candidates.push('master')
  candidates.push(`origin/${requested}`)
  if (requested === 'main') candidates.push('origin/master')

  for (const candidate of candidates) {
    const commit = tryGit(['rev-parse', '--verify', `${candidate}^{commit}`], repoRoot)
    if (commit) return { name: candidate, commit }
  }

  throw new Error(`Unable to resolve revision ${requested}; tried ${candidates.join(', ')}`)
}

function parseInteger(name: string, fallback: string, minimum: number): number {
  const value = Number.parseInt(optionString(name, fallback) ?? fallback, 10)
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`--${name} must be an integer of at least ${minimum}`)
  }
  return value
}

function parseScale(): number {
  const value = Number.parseFloat(optionString('frame-count-scale', '1.0') ?? '1.0')
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('--frame-count-scale must be a positive number')
  }
  return value
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = !quoted
      }
    } else if (char === ',' && !quoted) {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += char
    }
  }

  cells.push(cell.trim())
  return cells
}

function parseResults(csv: string): BenchmarkResult[] {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean)
  if (lines.length < 2) throw new Error('Benchmark runner produced no result rows')

  const header = splitCsvLine(lines[0])
  const expectedHeader = [
    'Filter',
    'Plugin',
    'Format',
    'Args',
    'Average',
    'Standard Deviation',
    'Min',
    'Max',
    'Median',
  ]
  if (header.join('|') !== expectedHeader.join('|')) {
    throw new Error(`Unexpected benchmark CSV header: ${header.join(', ')}`)
  }

  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line)
    if (cells.length !== expectedHeader.length) {
      throw new Error(`Malformed benchmark CSV row: ${line}`)
    }

    const [filter, plugin, format, args, average, stdDev, min, max, median] = cells
    const result = {
      filter,
      plugin,
      format,
      args,
      average: Number.parseFloat(average),
      stdDev: Number.parseFloat(stdDev),
      min: Number.parseFloat(min),
      max: Number.parseFloat(max),
      median: Number.parseFloat(median),
      key: JSON.stringify([filter, plugin, format, args]),
    }
    if (![result.average, result.stdDev, result.min, result.max, result.median].every(Number.isFinite)) {
      throw new Error(`Non-numeric benchmark CSV row: ${line}`)
    }
    return result
  })
}

function geometricMean(rows: Comparison[]): number {
  return Math.exp(rows.reduce((sum, row) => sum + Math.log(row.speedup), 0) / rows.length)
}

function summarize(rows: Comparison[]): Summary {
  const speedup = geometricMean(rows)
  return {
    cases: rows.length,
    geometricMeanSpeedup: speedup,
    deltaPct: (speedup - 1) * 100,
  }
}

function groupedSummary(rows: Comparison[]): Record<string, Summary> {
  const grouped = new Map<string, Comparison[]>()
  for (const row of rows) {
    const existing = grouped.get(row.filter) ?? []
    existing.push(row)
    grouped.set(row.filter, existing)
  }
  return Object.fromEntries([...grouped.entries()].map(([filter, cases]) => [filter, summarize(cases)]))
}

function comparisonMarkdown(
  candidate: Revision,
  baseline: Revision,
  rows: Comparison[],
  summary: Summary,
  byFilter: Record<string, Summary>,
  configuration: Record<string, unknown>,
): string {
  const lines = [
    '# Benchmark comparison',
    '',
    `- Candidate: \`${candidate.name}\` (${candidate.commit})`,
    `- Baseline: \`${baseline.name}\` (${baseline.commit})`,
    `- Cases: ${summary.cases}`,
    `- Timing mode: \`${String(configuration.timingMode)}\` (reported unit: ${String(configuration.reportedUnit)})`,
    ...(configuration.timingMode === 'direct-frame'
      ? ['- Direct-frame values are latency-derived FPS-shaped values, not full-stream vspipe throughput.']
      : []),
    `- Geometric-mean speedup: **${summary.geometricMeanSpeedup.toFixed(3)}x** (${summary.deltaPct >= 0 ? '+' : ''}${summary.deltaPct.toFixed(1)}%)`,
    '',
    '## Configuration',
    '',
    '```json',
    JSON.stringify(configuration, null, 2),
    '```',
    '',
    '## Summary by filter',
    '',
    '| Filter | Cases | Geometric mean | Delta |',
    '| :---: | ---: | ---: | ---: |',
  ]

  for (const [filter, filterSummary] of Object.entries(byFilter)) {
    lines.push(`| ${filter} | ${filterSummary.cases} | ${filterSummary.geometricMeanSpeedup.toFixed(3)}x | ${filterSummary.deltaPct >= 0 ? '+' : ''}${filterSummary.deltaPct.toFixed(1)}% |`)
  }

  lines.push('', '## Cases', '', '| Filter | Plugin | Format | Args | Candidate FPS | Baseline FPS | Delta | Speedup |', '| :---: | :---: | :---: | :--- | ---: | ---: | ---: | ---: |')
  for (const row of rows) {
    lines.push(`| ${row.filter} | ${row.plugin} | ${row.format} | ${row.args} | ${row.candidateFps.toFixed(3)} | ${row.baselineFps.toFixed(3)} | ${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(1)}% | ${row.speedup.toFixed(3)}x |`)
  }

  return `${lines.join('\n')}\n`
}

async function main(): Promise<void> {
  if (cliArgs.help) {
    printHelp()
    return
  }

  const invocationDir = process.cwd()
  const repoRoot = runCommand('git', ['rev-parse', '--show-toplevel'], invocationDir).stdout.trim()
  const baselineRequested = optionString('baseline', 'main') ?? 'main'
  const candidateRequested = optionString('candidate', 'HEAD') ?? 'HEAD'
  const baselineBuildOptions = optionStrings('baseline-build-option')
  const candidateBuildOptions = optionStrings('candidate-build-option')
  const baselineZsmoothNamespace = optionString('baseline-zsmooth-namespace', 'zsmooth') ?? 'zsmooth'
  const candidateZsmoothNamespace = optionString('candidate-zsmooth-namespace', 'zsmooth_simd_f16') ?? 'zsmooth_simd_f16'
  const baselineResolved = resolveRevision(baselineRequested, repoRoot)
  const candidateResolved = resolveRevision(candidateRequested, repoRoot)
  const sameBuildOptions = baselineBuildOptions.length === candidateBuildOptions.length
    && baselineBuildOptions.every((value, index) => value === candidateBuildOptions[index])
  if (baselineResolved.commit === candidateResolved.commit && sameBuildOptions) {
    throw new Error('Candidate and baseline resolve to the same revision and build configuration')
  }

  const iterations = parseInteger('iterations', '7', 3)
  const warmup = parseInteger('warmup', '1', 0)
  const frameCountScale = parseScale()
  const optimize = optionString('optimize', 'ReleaseFast') ?? 'ReleaseFast'
  const baselineZig = optionString('baseline-zig', 'zig') ?? 'zig'
  const candidateZig = optionString('candidate-zig', 'zig') ?? 'zig'
  const target = optionString('target') ?? null
  const cpu = optionString('cpu') ?? null
  const full = cliArgs.full === true
  const perf = cliArgs.perf === true
  ensurePerfAvailable(perf)
  const filters = optionStrings('filter')
  const formats = optionStrings('format')
  const plugins = optionStrings('plugin')
  const keepWorktrees = Boolean(cliArgs['keep-worktrees'])
  const outputJson = resolve(invocationDir, optionString('output', 'build/benchmarks/benchmark_comparison.json') ?? 'build/benchmarks/benchmark_comparison.json')
  const outputMarkdown = resolve(invocationDir, optionString('markdown-output', 'build/benchmarks/benchmark_comparison.md') ?? 'build/benchmarks/benchmark_comparison.md')
  const outputMetadata = resolve(invocationDir, optionString('metadata-output', 'build/benchmarks/benchmark_comparison.metadata.json') ?? 'build/benchmarks/benchmark_comparison.metadata.json')

  const tempRoot = mkdtempSync(join(tmpdir(), 'zsmooth-benchmark-'))
  const revisions: Revision[] = []


  try {
    for (const [role, resolved] of [['baseline', baselineResolved], ['candidate', candidateResolved]] as const) {
      const worktree = join(tempRoot, role)
      runCommand('git', ['worktree', 'add', '--detach', worktree, resolved.commit], repoRoot)
      const requestedCompiler = role === 'baseline' ? baselineZig : candidateZig
      const buildOptions = role === 'baseline' ? baselineBuildOptions : candidateBuildOptions
      const compiler = compilerInfo(requestedCompiler, invocationDir, worktree, target, cpu)
      const buildArgs = ['build', `-Doptimize=${optimize}`, ...buildOptions]
      if (target) buildArgs.push(`-Dtarget=${target}`)
      if (cpu) buildArgs.push(`-Dcpu=${cpu}`)
      runCommand(compiler.actualPath, buildArgs, worktree)
      const pluginPath = join(worktree, 'zig-out', 'lib')
      const pluginArtifacts = ['libzsmooth.dylib', 'libzsmooth.so', 'zsmooth.dll']
      if (!existsSync(pluginPath) || !pluginArtifacts.some((artifact) => existsSync(join(pluginPath, artifact)))) {
        throw new Error(`Build did not produce a zsmooth library in ${pluginPath}`)
      }
      revisions.push({
        role,
        name: resolved.name,
        commit: resolved.commit,
        worktree,
        pluginPath,
        compiler,
        buildOptions,

      })
    }

    const baseline = revisions.find((revision) => revision.role === 'baseline')!
    const candidate = revisions.find((revision) => revision.role === 'candidate')!
    const candidateBenchmarks = join(candidate.worktree, 'benchmarks')
    const runResults = new Map<string, BenchmarkResult[]>()
    const runnerMetadata = new Map<string, RunnerMetadata>()
    const pathSeparator = process.platform === 'win32' ? ';' : ':'

    for (const revision of [baseline, candidate]) {
      const runRoot = join(tempRoot, `run-${revision.role}`)
      const benchmarkDir = join(runRoot, 'benchmarks')
      mkdirSync(runRoot, { recursive: true })
      cpSync(candidateBenchmarks, benchmarkDir, { recursive: true })

      const runnerArgs = [
        join(benchmarkDir, 'run_benchmarks.ts'),
        '--frame-count-scale',
        frameCountScale.toString(),
        '--iterations',
        iterations.toString(),
        '--warmup',
        warmup.toString(),
        '--zig',
        revision.compiler.requestedPath,
      ]
      runnerArgs.push(
        '--zsmooth-namespace',
        revision.role === 'baseline' ? baselineZsmoothNamespace : candidateZsmoothNamespace,
      )
      if (full) runnerArgs.push('--full')
      if (perf) runnerArgs.push('--perf')
      if (target) runnerArgs.push('--target', target)
      if (cpu) runnerArgs.push('--cpu', cpu)
      const fastPython = optionString('fast-python')
      if (fastPython) runnerArgs.push('--fast-python', fastPython)
      const fastFrame = optionString('fast-frame')
      if (fastFrame) runnerArgs.push('--fast-frame', fastFrame)
      for (const filter of filters) runnerArgs.push('--filter', filter)
      for (const format of formats) runnerArgs.push('--format', format)
      for (const plugin of plugins) runnerArgs.push('--plugin', plugin)

      const existingPluginPath = process.env.VAPOURSYNTH_EXTRA_PLUGIN_PATH
      const pluginSearchPath = [revision.pluginPath, existingPluginPath].filter(Boolean).join(pathSeparator)
      const result = runCommand('bun', runnerArgs, benchmarkDir, {
        VAPOURSYNTH_EXTRA_PLUGIN_PATH: pluginSearchPath,
      })
      await Bun.write(join(runRoot, 'benchmark.stdout.log'), result.stdout)
      await Bun.write(join(runRoot, 'benchmark.stderr.log'), result.stderr)
      runResults.set(revision.role, parseResults(await Bun.file(join(benchmarkDir, 'benchmark_results.csv')).text()))
      const metadataPath = join(benchmarkDir, 'benchmark_results.json')
      if (!existsSync(metadataPath)) {
        throw new Error(`Benchmark runner did not produce its JSON sidecar at ${metadataPath}`)
      }
      runnerMetadata.set(revision.role, parseRunnerMetadata(await Bun.file(metadataPath).json()))
    }

    const baselineResults = runResults.get('baseline')!
    const candidateResults = runResults.get('candidate')!
    const baselineMetadata = runnerMetadata.get('baseline')!
    const candidateMetadata = runnerMetadata.get('candidate')!
    const timingMode = full ? 'full-stream-vspipe' : 'direct-frame'
    const expectedSampleUnit = full ? 'fps' : 'milliseconds'
    for (const [role, metadata] of [['baseline', baselineMetadata], ['candidate', candidateMetadata]] as const) {
      const actualMode = metadata.timing?.mode
      const actualUnit = metadata.timing?.sampleUnit
      if (actualMode !== timingMode || actualUnit !== expectedSampleUnit) {
        throw new Error(`Benchmark runner ${role} sidecar reports timing ${actualMode ?? 'unknown'}/${actualUnit ?? 'unknown'}, expected ${timingMode}/${expectedSampleUnit}`)
      }
    }
    const baselineByKey = new Map(baselineResults.map((result) => [result.key, result]))
    const candidateByKey = new Map(candidateResults.map((result) => [result.key, result]))
    const missingFromCandidate = baselineResults.filter((result) => !candidateByKey.has(result.key))
    const missingFromBaseline = candidateResults.filter((result) => !baselineByKey.has(result.key))
    if (missingFromCandidate.length || missingFromBaseline.length) {
      throw new Error(`Benchmark case mismatch: ${missingFromCandidate.length} missing from candidate, ${missingFromBaseline.length} missing from baseline`)
    }

    const comparisons: Comparison[] = candidateResults.map((candidateResult) => {
      const baselineResult = baselineByKey.get(candidateResult.key)!
      const speedup = candidateResult.average / baselineResult.average
      return {
        filter: candidateResult.filter,
        plugin: candidateResult.plugin,
        format: candidateResult.format,
        args: candidateResult.args,
        candidateFps: candidateResult.average,
        baselineFps: baselineResult.average,
        deltaPct: (speedup - 1) * 100,
        speedup,
      }
    })

    const summary = summarize(comparisons)
    const byFilter = groupedSummary(comparisons)
    const configuration = {
      optimize,
      timingMode,
      sampleUnit: expectedSampleUnit,
      reportedUnit: 'fps',
      frameCountScale,
      iterations,
      warmup,
      full,
      perf,
      filters,
      formats,
      plugins,
      pluginNamespaces: {
        baseline: baselineZsmoothNamespace,
        candidate: candidateZsmoothNamespace,
      },
      requestedTarget: target,
      requestedCpu: cpu,
      buildOptions: {
        baseline: baseline.buildOptions,
        candidate: candidate.buildOptions,
      },
      toolchains: {
        baseline: baseline.compiler,
        candidate: candidate.compiler,
      },
      host: {
        platform: process.platform,
        arch: process.arch,
        osRelease: osRelease(),
        hostname: hostname(),
      },
      runtime: {
        bun: Bun.version,
        node: process.version,
      },
      runner: 'candidate revision benchmark runner',
    }
    const report = {
      schemaVersion: 1,
      candidate: { requested: candidateRequested, resolved: candidate.name, commit: candidate.commit },
      baseline: { requested: baselineRequested, resolved: baseline.name, commit: baseline.commit },
      configuration,
      summary,
      byFilter,
      cases: comparisons,
      sidecars: {
        baseline: baselineMetadata,
        candidate: candidateMetadata,
      },
    }
    const metadataReport = {
      schemaVersion: 1,
      timing: {
        mode: timingMode,
        sampleUnit: expectedSampleUnit,
        reportedUnit: 'fps',
        reportedValueSemantics: full
          ? 'full-stream vspipe throughput'
          : 'single-frame latency converted to an FPS-shaped value; not full-stream throughput',
      },
      configuration,
      baseline: baselineMetadata,
      candidate: candidateMetadata,
    }

    mkdirSync(dirname(outputJson), { recursive: true })
    mkdirSync(dirname(outputMarkdown), { recursive: true })
    mkdirSync(dirname(outputMetadata), { recursive: true })
    await Bun.write(outputJson, `${JSON.stringify(report, null, 2)}\n`)
    await Bun.write(outputMarkdown, comparisonMarkdown(candidate, baseline, comparisons, summary, byFilter, configuration))
    await Bun.write(outputMetadata, `${JSON.stringify(metadataReport, null, 2)}\n`)

    console.log(`Candidate ${candidate.name} ${candidate.commit}`)
    console.log(`Baseline  ${baseline.name} ${baseline.commit}`)
    console.log(`Compared ${summary.cases} cases: ${summary.geometricMeanSpeedup.toFixed(3)}x (${summary.deltaPct >= 0 ? '+' : ''}${summary.deltaPct.toFixed(1)}%)`)
    console.log(`Wrote ${outputJson}`)
    console.log(`Wrote ${outputMarkdown}`)
    console.log(`Wrote ${outputMetadata}`)
    if (keepWorktrees) console.log(`Kept temporary benchmark root at ${tempRoot}`)
  } finally {
    if (!keepWorktrees) {
      for (const revision of revisions) {
        try {
          runCommand('git', ['worktree', 'remove', '--force', revision.worktree], repoRoot)
        } catch (error) {
          console.error(error)
        }
      }
      rmSync(tempRoot, { recursive: true, force: true })
      runCommand('git', ['worktree', 'prune'], repoRoot)
    }
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
