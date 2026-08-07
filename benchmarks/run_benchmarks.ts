#!/usr/bin/env bun
import { exit } from 'node:process'
import { join } from 'node:path'
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
    fast: {
      type: "boolean",
      default: true,
    },
    "fast-python": {
      type: "string",
    },
    "fast-frame": {
      type: "string",
      default: "0",
    },
  },
})

const DEFAULT_NUM_FRAMES = Math.round(2000 * Number.parseFloat(cliArgs['frame-count-scale']))
const ITERATIONS = Number.parseInt(cliArgs.iterations, 10)
const WARMUP_ITERATIONS = Number.parseInt(cliArgs.warmup, 10)
const FAST_MODE = cliArgs.fast === true
const FAST_PYTHON = typeof cliArgs['fast-python'] === 'string'
  ? cliArgs['fast-python']
  : process.env.VAPOURSYNTH_PYTHON ?? 'python3'
const FAST_FRAME = Number.parseInt(cliArgs['fast-frame'] as string, 10)

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS < 3) {
  throw new Error('--iterations must be an integer of at least 3')
}

if (!Number.isSafeInteger(WARMUP_ITERATIONS) || WARMUP_ITERATIONS < 0) {
  throw new Error('--warmup must be a non-negative integer')
}
if (FAST_MODE && (!Number.isSafeInteger(FAST_FRAME) || FAST_FRAME < 0)) {
  throw new Error('--fast-frame must be a non-negative integer')
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

console.log(
  `Benchmarking ${benchmarksToRun.length} filters${FAST_MODE ? ` (fast get_frame(${FAST_FRAME}))` : ''}`,
)

const results: Results[] = []
for (const filter of benchmarksToRun) {

  const specsToRun = filter.specs
    .filter((spec) => !cliArgs.plugin || cliArgs.plugin?.includes(spec.plugin))
    .filter((spec) => !cliArgs.format || cliArgs.format.includes(spec.format))

  for (const spec of specsToRun) {
    const fpsValues: number[] = []
    const args = [`output=${spec.plugin}`, `format=${spec.format}`].concat(spec.args)
    const vspipeArgs = args.flatMap((arg) => ['-a', arg])

    if (FAST_MODE) {
      const helperArgs = [
        join(import.meta.dir, 'get_frame_benchmark.py'),
        '--script',
        join(import.meta.dir, filter.benchmarkPath),
        '--node',
        spec.plugin,
        '--frame',
        FAST_FRAME.toString(),
        '--iterations',
        ITERATIONS.toString(),
        '--warmup',
        WARMUP_ITERATIONS.toString(),
      ]
      for (const arg of args) helperArgs.push('--arg', arg)

      const fastRun = Bun.spawnSync([FAST_PYTHON, ...helperArgs], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const fastStdout = fastRun.stdout.toString()
      const fastStderr = fastRun.stderr.toString()
      if (fastRun.exitCode !== 0) {
        throw new Error(`Fast benchmark failed for ${filter.filter}: ${fastStderr || fastStdout}`)
      }

      const jsonLines = fastStdout.trim().split(/\r?\n/).filter(Boolean)
      const jsonLine = jsonLines[jsonLines.length - 1]
      if (!jsonLine) {
        throw new Error(`Fast benchmark produced no JSON for ${filter.filter}`)
      }
      const fastPayload = JSON.parse(jsonLine) as { fps_values?: number[] }
      if (!Array.isArray(fastPayload.fps_values) || fastPayload.fps_values.length !== ITERATIONS) {
        throw new Error(`Fast benchmark produced invalid samples for ${filter.filter}: ${fastStdout}`)
      }
      fpsValues.push(...fastPayload.fps_values.map(Number))
    } else {
      for (let i = 0; i < WARMUP_ITERATIONS; i++) {
        Bun.spawnSync(
          [
            'vspipe',
            ...vspipeArgs,
            '-e',
            Math.round(spec.frames).toString(),
            '-r',
            '1',
            filter.benchmarkPath,
            '--',
          ],
          { stderr: 'pipe' },
        )
      }

      for (let i = 0; i < ITERATIONS; i++) {
        const { stderr } = Bun.spawnSync(
          [
            'vspipe',
            ...vspipeArgs,
            '-e',
            Math.round(spec.frames).toString(),
            '-r',
            '1',
            filter.benchmarkPath,
            '--',
          ],
          { stderr: 'pipe' },
        )

        const fps = /(\d+\.?\d+?) fps/.exec(stderr.toString())?.[1]

        if (!fps) {
          throw new Error(`Unable to determine FPS from stderr: ${stderr}`)
        }

        fpsValues.push(Number.parseFloat(fps))
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
    })
  }
}

if (results.length === 0) {
  exit()
}

console.table(results)

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

console.log(`Writing results to ${benchmarkResultsCsvFilename}`)
Bun.write(benchmarkResultsCsvFilename, `${csvHeadersStr}\n${csvEntries}`)

console.log(`Writing results to ${benchmarkResultsMarkdownFilename}`)
Bun.write(benchmarkResultsMarkdownFilename, `${markdownHeadersStr}\n${markdownTableSeperator}\n${markdownEntries}`)
