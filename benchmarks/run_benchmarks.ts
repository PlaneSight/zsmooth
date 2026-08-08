#!/usr/bin/env bun
import { mkdirSync } from 'node:fs'
import { cpus, hostname, release as osRelease } from 'node:os'
import { exit } from 'node:process'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: cliArgs } = parseArgs({
  options: {
    filter: {
      type: "string",
      multiple: true,
    },
    format: {
      type: "string",
      multiple: true,
    },
    "frame-count-scale": {
      type: "string",
      default: "1.0"
    },
    iterations: {
      type: "string",
      default: "7",
    },
    warmup: {
      type: "string",
      default: "1",
    },
    plugin: {
      type: "string",
      multiple: true,
    },
    "exclude-plugin": {
      type: "string",
      multiple: true
    },
    // Direct get_frame timing is the default. --fast remains an explicit
    // compatibility spelling for callers that used the old default.
    fast: {
      type: "boolean",
      default: true,
    },
    full: {
      type: "boolean",
      default: false,
    },
    "fast-python": {
      type: "string",
    },
    "fast-frame": {
      type: "string",
      default: "0",
    },
    perf: {
      type: "boolean",
      default: false,
    },
    zig: {
      type: "string",
    },
    target: {
      type: "string",
    },
    cpu: {
      type: "string",
    },
    "zsmooth-namespace": {
      type: "string",
      default: "zsmooth_simd_f16",
    },
    "json-output": {
      type: "string",
      default: "benchmark_results.json",
    },
    help: {
      type: "boolean",
      default: false,
    },
  },
})

function printHelp(): void {
  console.log(`Run the VapourSynth benchmark matrix.

Usage:
  bun benchmarks/run_benchmarks.ts [options]

Options:
  --filter <name>              Repeat to select filters
  --plugin <name>              Repeat to select plugins
  --zsmooth-namespace <name>   Plugin namespace for Zsmooth fixture calls (default: zsmooth_simd_f16)
  --format <name>              Repeat to select formats
  --frame-count-scale <n>      Scale fixture frame counts (default: 1.0)
  --iterations <n>             Measured iterations, minimum 3 (default: 7)
  --warmup <n>                 Warmup iterations (default: 1)
  --full                       Use full-stream vspipe timing instead of the default direct get_frame timing
  --fast                       Compatibility alias for the default direct get_frame timing
  --fast-python <path>         Python runtime for direct timing (default: $VAPOURSYNTH_PYTHON or python3)
  --fast-frame <n>             Frame requested by direct timing (default: 0)
  --perf                       Linux perf stat counters (cycles, instructions, branch-misses)
  --zig <path>                 Requested compiler identifier recorded in the JSON sidecar
  --target <triple>            Requested Zig target recorded in the JSON sidecar
  --cpu <name>                 Requested Zig CPU recorded in the JSON sidecar
  --json-output <path>         Additive JSON sidecar (default: benchmark_results.json)
  --help                       Show this help
`)
}

if (cliArgs.help === true) {
  printHelp()
  exit(0)
}

const FRAME_COUNT_SCALE = Number.parseFloat(cliArgs['frame-count-scale'] as string)
const DEFAULT_NUM_FRAMES = Math.round(2000 * FRAME_COUNT_SCALE)
const ITERATIONS = Number.parseInt(cliArgs.iterations, 10)
const WARMUP_ITERATIONS = Number.parseInt(cliArgs.warmup, 10)
const FAST_MODE = cliArgs.full !== true
const FAST_PYTHON = typeof cliArgs['fast-python'] === 'string'
  ? cliArgs['fast-python']
  : process.env.VAPOURSYNTH_PYTHON ?? 'python3'
const FAST_FRAME = Number.parseInt(cliArgs['fast-frame'] as string, 10)
const ZSMOOTH_NAMESPACE = (cliArgs['zsmooth-namespace'] as string).trim()
const PERF_MODE = cliArgs.perf === true
const REQUESTED_COMPILER = typeof cliArgs.zig === 'string' ? cliArgs.zig : null
const REQUESTED_TARGET = typeof cliArgs.target === 'string' ? cliArgs.target : null
const REQUESTED_CPU = typeof cliArgs.cpu === 'string' ? cliArgs.cpu : null

if (!Number.isFinite(FRAME_COUNT_SCALE) || FRAME_COUNT_SCALE <= 0) {
  throw new Error('--frame-count-scale must be a positive number')
}

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 3) {
  throw new Error('--iterations must be an integer of at least 3')
}

if (!Number.isSafeInteger(WARMUP_ITERATIONS) || WARMUP_ITERATIONS < 0) {
  throw new Error('--warmup must be a non-negative integer')
}
if (FAST_MODE && (!Number.isSafeInteger(FAST_FRAME) || FAST_FRAME < 0)) {
  throw new Error('--fast-frame must be a non-negative integer')
}
if (!ZSMOOTH_NAMESPACE) {
  throw new Error('--zsmooth-namespace must not be empty')
}

const PERF_EVENTS = ['cycles', 'instructions', 'branch-misses'] as const
type PerfEvent = typeof PERF_EVENTS[number]
type PerfSample = Record<PerfEvent, number>
type PerfAggregate = Record<PerfEvent, {
  min: number
  max: number
  median: number
  average: number
}>

type PerfResult = {
  samples: PerfSample[]
  aggregate: PerfAggregate
}

function ensurePerfAvailable(): void {
  if (!PERF_MODE) return
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

function parsePerfStats(stderr: string): PerfSample {
  const sample: Partial<PerfSample> = {}
  for (const line of stderr.split(/\r?\n/)) {
    const fields = line.split(',')
    const eventIndex = fields.findIndex((field) => {
      const normalized = field.trim()
      return PERF_EVENTS.some((event) => normalized === event || normalized.startsWith(`${event}:`))
    })
    if (eventIndex < 0) continue
    const event = fields[eventIndex].trim().split(':', 1)[0] as PerfEvent
    const value = Number.parseFloat(fields[0].trim().replaceAll(',', ''))
    if (!Number.isFinite(value)) {
      throw new Error(`perf stat did not produce a numeric ${event} counter: ${line}`)
    }
    sample[event] = value
  }

  for (const event of PERF_EVENTS) {
    if (!Number.isFinite(sample[event])) {
      throw new Error(`perf stat did not report the ${event} counter`)
    }
  }
  return sample as PerfSample
}

function runWithPerf(command: string, args: string[]): { stdout: string; stderr: string; perf: PerfSample } {
  const result = Bun.spawnSync(
    ['perf', 'stat', '--no-big-num', '-x,', '-e', PERF_EVENTS.join(','), '--', command, ...args],
    {
      env: { ...process.env, LC_ALL: 'C' } as Record<string, string>,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(`perf stat failed while running ${command}: ${stderr || stdout}`)
  }
  return { stdout, stderr, perf: parsePerfStats(stderr) }
}

function aggregatePerf(samples: PerfSample[]): PerfAggregate | null {
  if (samples.length === 0) return null
  const aggregate = {} as PerfAggregate
  for (const event of PERF_EVENTS) {
    const values = samples.map((sample) => sample[event]).sort((a, b) => a - b)
    aggregate[event] = {
      min: values[0],
      max: values[values.length - 1],
      median: values[Math.trunc(values.length / 2)],
      average: values.reduce((sum, value) => sum + value, 0) / values.length,
    }
  }
  return aggregate
}

type Benchmarks = {
  filter: string
  specs: {
    plugin: string
    format: 'u8' | 'u16' | 'f16' | 'f32'
    args: string[]
    frames: number
  }[]
  benchmarkPath: string
}

type Results = {
  filter: string
  plugin: string
  format: 'u8' | 'u16' | 'f16' | 'f32'
  args: string
  min: number
  max: number
  median: number
  average: number
  stdDev: number
  sampleUnit: 'milliseconds' | 'fps'
  rawSamples: number[]
  perf?: PerfResult
}


const BENCHMARKS: Benchmarks[] = [
  {
    filter: 'CCD',
    benchmarkPath: 'test_ccd.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=YUV', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 5              , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=YUV', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10              , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=YUV', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,

      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=RGB', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 10              , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=RGB', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10              , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['colorfamily=RGB', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=YUV', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=YUV', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=YUV', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=RGB', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=RGB', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['colorfamily=RGB', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 2          , } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=YUV', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=YUV', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=YUV', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 4 / 4      , } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=RGB', 'temporal_radius=0'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=RGB', 'temporal_radius=1'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['colorfamily=RGB', 'temporal_radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 4 / 4      , } ,
    ],
  },
  {
    filter: 'Clense',
    benchmarkPath: 'test_clense.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['function=Clense']         , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['function=ForwardClense']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['function=BackwardClense'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
    ],
  },
  {
    filter: 'Cnr4',
    benchmarkPath: 'test_cnr4.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['tmode=0', 'radius=1'] , frames: DEFAULT_NUM_FRAMES / 8               , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['tmode=0', 'radius=2'] , frames: DEFAULT_NUM_FRAMES / 8 / 2           , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['tmode=0', 'radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 4           , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['tmode=2', 'radius=2'] , frames: DEFAULT_NUM_FRAMES / 16              , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['tmode=4', 'radius=3'] , frames: DEFAULT_NUM_FRAMES / 32              , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['tmode=0', 'radius=1'] , frames: DEFAULT_NUM_FRAMES / 8              , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['tmode=0', 'radius=2'] , frames: DEFAULT_NUM_FRAMES / 8 / 2           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['tmode=0', 'radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 4           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['tmode=2', 'radius=2'] , frames: DEFAULT_NUM_FRAMES / 16              , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['tmode=4', 'radius=3'] , frames: DEFAULT_NUM_FRAMES / 32              , } ,

      // { plugin: 'zsmooth' , format:'f32' , args: ['tmode=1', 'radius=1'] , frames: DEFAULT_NUM_FRAMES / 10 / 4          , } ,
      // { plugin: 'zsmooth' , format:'f32' , args: ['tmode=2', 'radius=2'] , frames: DEFAULT_NUM_FRAMES / 10 / 4 / 2      , } ,
    ],
  },
  {
    filter: 'DCTFilter',
    benchmarkPath: 'test_dctfilter.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: [] , frames: DEFAULT_NUM_FRAMES / 8     , } ,
      { plugin: 'dctf'    , format:'u8'  , args: [] , frames: DEFAULT_NUM_FRAMES / 8     , } ,

      { plugin: 'zsmooth' , format:'u16' , args: [] , frames: DEFAULT_NUM_FRAMES / 8 / 2 , } ,
      { plugin: 'dctf'    , format:'u16' , args: [] , frames: DEFAULT_NUM_FRAMES / 8 / 2 , } ,

      { plugin: 'zsmooth' , format:'f32' , args: [] , frames: DEFAULT_NUM_FRAMES / 8 / 4 , } ,
      { plugin: 'dctf'    , format:'f32' , args: [] , frames: DEFAULT_NUM_FRAMES / 8 / 4 , } ,
    ],
  },
  {
    filter: 'DegrainMedian',
    benchmarkPath: 'test_degrain_median.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u8' , args: ['mode=5'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=5'] , frames: DEFAULT_NUM_FRAMES / 2 / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=5'] , frames: DEFAULT_NUM_FRAMES / 2 / 4, } ,
    ],
  },
  {
    filter: 'FluxSmooth',
    benchmarkPath: 'test_fluxsmooth.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['function=FluxSmoothT']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['function=FluxSmoothST'] , frames: DEFAULT_NUM_FRAMES , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['function=FluxSmoothT']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['function=FluxSmoothST'] , frames: DEFAULT_NUM_FRAMES / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['function=FluxSmoothT']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['function=FluxSmoothST'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
    ],
  },
  {
    filter: 'InterQuartileMean',
    benchmarkPath: 'test_inter_quartile_mean.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES         , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8     , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2     , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 2 , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 2 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 4 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 4 , } ,
    ],
  },
  {
    filter: 'Median',
    benchmarkPath: 'test_median.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES               , } ,
      { plugin: 'std'     , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES               , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4           , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2           , } ,
      { plugin: 'std'     , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 2       , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 2       , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4           , } ,
      { plugin: 'std'     , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4           , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 4       , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 4       , } ,
    ],
  },
  {
    filter: 'RemoveGrain',
    benchmarkPath: 'test_remove_grain.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=14'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=15'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=16'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'std'     , format:'u8'  , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'std'     , format:'u8'  , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'std'     , format:'u8'  , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=14'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=15'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=16'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'std'     , format:'u16' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'std'     , format:'u16' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'std'     , format:'u16' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=14'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=15'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=16'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'std'     , format:'f32' , args: ['mode=4']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'std'     , format:'f32' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=17'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'std'     , format:'f32' , args: ['mode=20'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=22'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
    ],
  },
  {
    filter: 'Repair',
    benchmarkPath: 'test_repair.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=1']  , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=12'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=13'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
    ],
  },
  {
    filter: 'SmartMedian',
    benchmarkPath: 'test_smart_median.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES               , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4           , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2           , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 2       , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 2       , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4           , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=2'] , frames: DEFAULT_NUM_FRAMES / 4 / 4       , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=3'] , frames: DEFAULT_NUM_FRAMES / 8 / 4       , } ,
    ],
  },
  {
    filter: 'TemporalMedian',
    benchmarkPath: 'test_temporal_median.vpy',
    // Notes:
    // * neo_tmedian is significantly slower, so reducing it's frame count to not significantly slow down testing.
    // * both tmedian and neo_tmedian are significantly slower on radius 10 (zsmooth has vectorized sorting networks instead), so also reducing their frame counts.
    //
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth'     , format:'u8'  , args: ['radius=1']  , frames: DEFAULT_NUM_FRAMES          , } ,
      { plugin: 'zsmooth'     , format:'u8'  , args: ['radius=10'] , frames: DEFAULT_NUM_FRAMES          , } ,

      { plugin: 'zsmooth'     , format:'u16' , args: ['radius=1']  , frames: DEFAULT_NUM_FRAMES / 2      , } ,
      { plugin: 'zsmooth'     , format:'u16' , args: ['radius=10'] , frames: DEFAULT_NUM_FRAMES / 2      , } ,

      { plugin: 'zsmooth'     , format:'f32' , args: ['radius=1']  , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth'     , format:'f32' , args: ['radius=10'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
    ],
  },
  {
    filter: 'TemporalRepair',
    benchmarkPath: 'test_temporal_repair.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES     , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES     , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES     , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES     , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES     , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES / 2 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=0'] , frames: DEFAULT_NUM_FRAMES / 4 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 4 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 4 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=3'] , frames: DEFAULT_NUM_FRAMES / 4 , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=4'] , frames: DEFAULT_NUM_FRAMES / 4 , } ,
    ],
  },
  {
    filter: 'TemporalSoften',
    benchmarkPath: 'test_temporal_soften.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES         , } ,
      { plugin: 'std'     , format:'u8'  , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES         , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES         , } ,
      { plugin: 'std'     , format:'u8'  , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES / 2     , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2     , } ,
      { plugin: 'std'     , format:'u16' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 2     , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES / 2     , } ,
      { plugin: 'std'     , format:'u16' , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES / 2 / 2 , } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
      { plugin: 'std'     , format:'f32' , args: ['radius=1'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
      { plugin: 'std'     , format:'f32' , args: ['radius=7'] , frames: DEFAULT_NUM_FRAMES / 4     , } ,
    ],
  },
  {
    filter: 'TTempSmooth',
    benchmarkPath: 'test_ttempsmooth.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1', 'threshold=4', 'mdiff=2'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['radius=1', 'threshold=4', 'mdiff=4'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1', 'threshold=4', 'mdiff=2'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['radius=1', 'threshold=4', 'mdiff=4'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1', 'threshold=4', 'mdiff=2'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['radius=1', 'threshold=4', 'mdiff=4'] , frames: DEFAULT_NUM_FRAMES / 4      , } ,
    ],
  },
  {
    filter: 'VerticalCleaner',
    benchmarkPath: 'test_vertical_cleaner.vpy',
    // biome-ignore format:
    specs: [
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'zsmooth' , format:'u8'  , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES , } ,
      { plugin: 'rg'      , format:'u8'  , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES , } ,

      { plugin: 'zsmooth' , format:'u16' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'zsmooth' , format:'u16' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2, } ,
      { plugin: 'rg'      , format:'u16' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 2, } ,

      { plugin: 'zsmooth' , format:'f32' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=1'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'zsmooth' , format:'f32' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
      { plugin: 'rg'      , format:'f32' , args: ['mode=2'] , frames: DEFAULT_NUM_FRAMES / 4, } ,
    ],
  },
]

// FP16 support is a first-class performance target. Keep the matrix in sync
// with every zsmooth FP32 case without duplicating hundreds of declarations.
// Comparison plugins are deliberately excluded: support is inconsistent and
// would make a missing third-party capability abort the entire suite.
for (const benchmark of BENCHMARKS) {
  const f16Specs = benchmark.specs
    .filter((spec) => spec.plugin === 'zsmooth' && spec.format === 'f32')
    .map((spec) => ({ ...spec, format: 'f16' as const }))
  benchmark.specs.push(...f16Specs)
}

const benchmarksToRun = BENCHMARKS.filter((bench) => !cliArgs.filter || cliArgs.filter?.includes(bench.filter))
ensurePerfAvailable()

console.log(
  `Benchmarking ${benchmarksToRun.length} filters${FAST_MODE ? ` (direct get_frame(${FAST_FRAME}))` : ' (full vspipe)'}`,
)

const results: Results[] = []
for (const filter of benchmarksToRun) {

  const specsToRun = filter.specs
    .filter((spec) => !cliArgs.plugin || cliArgs.plugin?.includes(spec.plugin))
    .filter((spec) => !cliArgs.format || cliArgs.format.includes(spec.format))

  for (const spec of specsToRun) {
    const fpsValues: number[] = []
    const rawSamples: number[] = []
    const perfSamples: PerfSample[] = []
    const args = [`output=${spec.plugin}`, `format=${spec.format}`, `zsmooth_namespace=${ZSMOOTH_NAMESPACE}`].concat(spec.args)
    const vspipeArgs = [
      ...args.flatMap((arg) => ['-a', arg]),
      '-e',
      Math.round(spec.frames).toString(),
      '-r',
      '1',
      filter.benchmarkPath,
      '--',
    ]

    const fastHelperArgs = (iterations: number, warmup: number): string[] => [
      join(import.meta.dir, 'get_frame_benchmark.py'),
      '--script',
      join(import.meta.dir, filter.benchmarkPath),
      '--node',
      spec.plugin,
      '--frame',
      FAST_FRAME.toString(),
      '--iterations',
      iterations.toString(),
      '--warmup',
      warmup.toString(),
      ...args.flatMap((arg) => ['--arg', arg]),
    ]

    const parseFastPayload = (stdout: string, expectedSamples: number): { fpsValues: number[]; samplesMs: number[] } => {
      const jsonLines = stdout.trim().split(/\r?\n/).filter(Boolean)
      const jsonLine = jsonLines[jsonLines.length - 1]
      if (!jsonLine) {
        throw new Error(`Fast benchmark produced no JSON for ${filter.filter}`)
      }
      const fastPayload = JSON.parse(jsonLine) as { fps_values?: number[]; samples_ms?: number[] }
      if (!Array.isArray(fastPayload.fps_values) || fastPayload.fps_values.length !== expectedSamples) {
        throw new Error(`Fast benchmark produced invalid samples for ${filter.filter}: ${stdout}`)
      }
      const samplesMs = Array.isArray(fastPayload.samples_ms)
        ? fastPayload.samples_ms.map(Number)
        : fastPayload.fps_values.map((fps) => 1000 / Number(fps))
      if (samplesMs.length !== expectedSamples || !samplesMs.every(Number.isFinite)) {
        throw new Error(`Fast benchmark produced invalid millisecond samples for ${filter.filter}: ${stdout}`)
      }
      return { fpsValues: fastPayload.fps_values.map(Number), samplesMs }
    }

    if (FAST_MODE) {
      if (PERF_MODE) {
        if (WARMUP_ITERATIONS > 0) {
          const warmupRun = Bun.spawnSync([FAST_PYTHON, ...fastHelperArgs(1, WARMUP_ITERATIONS)], {
            stdout: 'pipe',
            stderr: 'pipe',
          })
          if (warmupRun.exitCode !== 0) {
            throw new Error(`Fast benchmark warmup failed for ${filter.filter}: ${warmupRun.stderr.toString()}`)
          }
        }
        for (let i = 0; i < ITERATIONS; i++) {
          const fastRun = runWithPerf(FAST_PYTHON, fastHelperArgs(1, 0))
          const payload = parseFastPayload(fastRun.stdout, 1)
          fpsValues.push(payload.fpsValues[0])
          rawSamples.push(payload.samplesMs[0])
          perfSamples.push(fastRun.perf)
        }
      } else {
        const fastRun = Bun.spawnSync([FAST_PYTHON, ...fastHelperArgs(ITERATIONS, WARMUP_ITERATIONS)], {
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const fastStdout = fastRun.stdout.toString()
        const fastStderr = fastRun.stderr.toString()
        if (fastRun.exitCode !== 0) {
          throw new Error(`Fast benchmark failed for ${filter.filter}: ${fastStderr || fastStdout}`)
        }
        const payload = parseFastPayload(fastStdout, ITERATIONS)
        fpsValues.push(...payload.fpsValues)
        rawSamples.push(...payload.samplesMs)
      }
    } else {
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        Bun.spawnSync(['vspipe', ...vspipeArgs], { stderr: 'pipe' })
      }

      for (let i = 0; i < ITERATIONS; i++) {
        let stderr: string
        if (PERF_MODE) {
          const measured = runWithPerf('vspipe', vspipeArgs)
          stderr = measured.stderr
          perfSamples.push(measured.perf)
        } else {
          const measured = Bun.spawnSync(['vspipe', ...vspipeArgs], { stderr: 'pipe' })
          stderr = measured.stderr.toString()
        }
        const fps = /(\d+\.?\d+?) fps/.exec(stderr)?.[1]

        if (!fps) {
          throw new Error(`Unable to determine FPS from stderr: ${stderr}`)
        }

        const numericFps = Number.parseFloat(fps)
        fpsValues.push(numericFps)
        rawSamples.push(numericFps)
      }
    }
    // Sort the results
    fpsValues.sort((a,b) => a - b)

    const min = fpsValues[0]
    const max = fpsValues[fpsValues.length - 1]
    const median = fpsValues[Math.trunc(fpsValues.length / 2)]
    let average =
      fpsValues.reduce((prev, curr) => prev + curr) / fpsValues.length

    // https://en.wikipedia.org/wiki/Standard_deviation
    const differences_squared = fpsValues.map((fps) => (fps - average) * (fps - average))
    const variance = differences_squared.reduce((prev, curr) => prev + curr) / fpsValues.length
    let std_deviation = Math.sqrt(variance)

    // Trim precision to 3 decimal points.
    average = average.toFixed(3)
    std_deviation = std_deviation.toFixed(3)

    const stringifiedArgs = spec.args.join(' ')

    console.log(
      `${filter.filter} ${spec.plugin} ${spec.format} [${stringifiedArgs}] Average: ${average} (+/- ${std_deviation}, ${min} .. ${max})`,
    )
    results.push({
      filter: filter.filter,
      plugin: spec.plugin,
      format: spec.format,
      args: stringifiedArgs,
      average,
      stdDev: std_deviation,
      min,
      max,
      median,
      sampleUnit: FAST_MODE ? 'milliseconds' : 'fps',
      rawSamples,
      ...(PERF_MODE
        ? {
            perf: {
              samples: perfSamples,
              aggregate: aggregatePerf(perfSamples)!,
            },
          }
        : {}),
    })
  }
}

if (results.length === 0) {
  exit()
}
console.table(results.map(({ filter, plugin, format, args, average, stdDev, min, max, median }) => ({
  filter,
  plugin,
  format,
  args,
  average,
  stdDev,
  min,
  max,
  median,
})))

const csvHeaders = [
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

const markdownHeaders = [
  'Filter',
  'Plugin',
  'Format',
  'Args',
  'Average FPS (std dev, min .. max)',
]

const csvHeadersStr = csvHeaders.join(',')
const csvEntries = results.reduce(
  (accum, result) =>
    `${accum}"${result.filter}", "${result.plugin}", "${result.format}", "${result.args}", ${result.average}, ${result.stdDev}, ${result.min}, ${result.max}, ${result.median} \n`,
  '',
)

const markdownHeadersStr = `| ${markdownHeaders.join(' | ')} |`
const markdownTableSeperator = `| ${markdownHeaders.map(() => ':---: |').join(' ')}`
const markdownEntries = results.reduce(
  (accum, result) =>
    `${accum}| ${result.filter} | ${result.plugin} | ${result.format} | ${result.args} | ${result.average} (+/- ${result.stdDev}, ${result.min} .. ${result.max}) |\n`,
  '',
)

const benchmarkResultsCsvFilename = 'benchmark_results.csv'
const benchmarkResultsMarkdownFilename = 'benchmark_results.md'
const benchmarkResultsJsonFilename = typeof cliArgs['json-output'] === 'string'
  ? cliArgs['json-output']
  : 'benchmark_results.json'
const sidecarPath = resolve(process.cwd(), benchmarkResultsJsonFilename)

console.log(`Writing results to ${benchmarkResultsCsvFilename}`)
Bun.write(benchmarkResultsCsvFilename, `${csvHeadersStr}\n${csvEntries}`)

const allPerfSamples = results.flatMap((result) => result.perf?.samples ?? [])
const timingMode = FAST_MODE ? 'direct-frame' : 'full-stream-vspipe'
const sampleUnit = FAST_MODE ? 'milliseconds' : 'fps'
const sidecar = {
  schemaVersion: 1,
  timing: {
    mode: timingMode,
    sampleUnit,
    reportedUnit: 'fps',
    reportedValueSemantics: FAST_MODE
      ? 'single-frame latency converted to an FPS-shaped value; not full-stream throughput'
      : 'full-stream vspipe throughput',
  },
  configuration: {
    frameCountScale: FRAME_COUNT_SCALE,
    iterations: ITERATIONS,
    warmup: WARMUP_ITERATIONS,
    frame: FAST_MODE ? FAST_FRAME : null,
    filters: cliArgs.filter ?? null,
    plugins: cliArgs.plugin ?? null,
    zsmoothNamespace: ZSMOOTH_NAMESPACE,
    formats: cliArgs.format ?? null,
    full: !FAST_MODE,
    perf: PERF_MODE,
  },
  requested: {
    compiler: REQUESTED_COMPILER,
    target: REQUESTED_TARGET,
    cpu: REQUESTED_CPU,
  },
  runtime: {
    bun: Bun.version,
    node: process.version,
    python: FAST_MODE ? FAST_PYTHON : null,
  },
  host: {
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? null,
    osRelease: osRelease(),
    hostname: hostname(),
  },
  perf: {
    enabled: PERF_MODE,
    events: PERF_MODE ? PERF_EVENTS : [],
    includesProcessOverhead: PERF_MODE,
    note: PERF_MODE
      ? 'perf stat measures the benchmark process and process-level setup/teardown overhead'
      : null,
    samples: allPerfSamples,
    aggregate: aggregatePerf(allPerfSamples),
  },
  results: results.map((result) => ({
    filter: result.filter,
    plugin: result.plugin,
    format: result.format,
    args: result.args,
    sampleUnit: result.sampleUnit,
    rawSamples: result.rawSamples,
    reportedSamples: FAST_MODE
      ? result.rawSamples.map((sample) => 1000 / sample)
      : result.rawSamples,
    average: result.average,
    stdDev: result.stdDev,
    min: result.min,
    max: result.max,
    median: result.median,
    perf: result.perf ?? null,
  })),
}

mkdirSync(dirname(sidecarPath), { recursive: true })
console.log(`Writing results to ${sidecarPath}`)
await Bun.write(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`)
console.log(`Writing results to ${benchmarkResultsMarkdownFilename}`)
Bun.write(benchmarkResultsMarkdownFilename, `${markdownHeadersStr}\n${markdownTableSeperator}\n${markdownEntries}`)
