#!/usr/bin/env bun
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { hostname, release as osRelease } from 'node:os'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: cliArgs } = parseArgs({
  options: {
    binary: { type: 'string' },
    disassembler: { type: 'string' },
    arg: { type: 'string', multiple: true },
    output: { type: 'string', default: 'build/benchmarks/disassembly.txt' },
    'metadata-output': { type: 'string', default: 'build/benchmarks/disassembly.json' },
    help: { type: 'boolean', default: false },
  },
  allowPositionals: false,
})

function printHelp(): void {
  console.log(`Capture disassembly from a supplied binary with a user-selected tool.

Usage:
  bun benchmarks/capture_disassembly.ts --binary <path> --disassembler <path> [options]

Options:
  --binary <path>              Built binary to disassemble (required)
  --disassembler <path>        Disassembler executable (required; no default is assumed)
  --arg <value>                Argument passed before the binary; may be repeated
  --output <path>              Disassembly text output (default: build/benchmarks/disassembly.txt)
  --metadata-output <path>     JSON metadata output (default: build/benchmarks/disassembly.json)
  --help                       Show this help

The helper does not require debug symbols. Pass tool-specific flags with --arg;
for example, an objdump-style tool may need --arg=-d. Tool availability and
syntax are intentionally selected by the caller.
`)
}

if (cliArgs.help === true) {
  printHelp()
  process.exit(0)
}

function requiredOption(name: 'binary' | 'disassembler'): string {
  const value = cliArgs[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`)
  }
  return value
}

function resolveExecutable(requested: string, cwd: string): string {
  const candidate = requested.includes('/') || requested.includes('\\')
    ? resolve(cwd, requested)
    : Bun.which(requested)
  if (!candidate || !existsSync(candidate)) {
    throw new Error(`Unable to locate disassembler executable ${requested}`)
  }
  return realpathSync(candidate)
}

const invocationDir = process.cwd()
const requestedBinary = requiredOption('binary')
const requestedDisassembler = requiredOption('disassembler')
const binaryPath = resolve(invocationDir, requestedBinary)
if (!existsSync(binaryPath)) {
  throw new Error(`Binary does not exist: ${binaryPath}`)
}
const disassemblerPath = resolveExecutable(requestedDisassembler, invocationDir)
const disassemblerArgs = Array.isArray(cliArgs.arg) ? cliArgs.arg : []
const outputPath = resolve(invocationDir, typeof cliArgs.output === 'string' ? cliArgs.output : 'build/benchmarks/disassembly.txt')
const metadataPath = resolve(invocationDir, typeof cliArgs['metadata-output'] === 'string' ? cliArgs['metadata-output'] : 'build/benchmarks/disassembly.json')

const result = Bun.spawnSync([disassemblerPath, ...disassemblerArgs, binaryPath], {
  stdout: 'pipe',
  stderr: 'pipe',
})
const stdout = result.stdout.toString()
const stderr = result.stderr.toString()
if (result.exitCode !== 0) {
  throw new Error(`Disassembler ${requestedDisassembler} failed with exit code ${result.exitCode}: ${stderr || stdout}`)
}

const metadata = {
  schemaVersion: 1,
  binary: {
    requestedPath: requestedBinary,
    actualPath: realpathSync(binaryPath),
  },
  disassembler: {
    requestedPath: requestedDisassembler,
    actualPath: disassemblerPath,
    args: disassemblerArgs,
  },
  runtime: {
    bun: Bun.version,
    node: process.version,
  },
  host: {
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
    hostname: hostname(),
  },
  output: {
    path: outputPath,
    stderrBytes: Buffer.byteLength(stderr),
    exitCode: result.exitCode,
  },
}

mkdirSync(dirname(outputPath), { recursive: true })
mkdirSync(dirname(metadataPath), { recursive: true })
await Bun.write(outputPath, stdout)
await Bun.write(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`)
console.log(`Wrote ${outputPath}`)
console.log(`Wrote ${metadataPath}`)
