import { spawn } from 'node:child_process'

type BenchTarget = 'node' | 'bun'

type BenchOptions = {
  readonly target: BenchTarget
  readonly quick: boolean
  readonly passthrough: string[]
}

const TARGETS = new Set<BenchTarget>(['node', 'bun'])

const options = parseArgs(process.argv.slice(2))
const outputBase =
  process.env['BENCH_OUTPUT_BASE'] ?? `bench-results.${options.target}`
const outputJson = process.env['BENCH_OUTPUT_JSON'] ?? `${outputBase}.json`
const outputCsv = process.env['BENCH_OUTPUT_CSV'] ?? `${outputBase}.csv`
const runtimeVersion = await describeTargetRuntime(options.target)
const env: NodeJS.ProcessEnv = {
  ...process.env,
  BENCH_TARGET: options.target,
  BENCH_RUNTIME_VERSION: runtimeVersion,
  BENCH_OUTPUT_JSON: outputJson,
  BENCH_OUTPUT_CSV: outputCsv,
}

if (options.quick) {
  env['BENCH_TIME_MS'] ??= '1000'
  env['BENCH_WARMUP_TIME_MS'] ??= '300'
  env['BENCH_WARMUP_ITERATIONS'] ??= '20'
}

console.log(`bench target: ${options.target} (${runtimeVersion})`)
console.log(`bench json: ${outputJson}`)
console.log(`bench csv: ${outputCsv}`)

const vitestCommand = options.target
const vitestArgs = [
  'node_modules/vitest/vitest.mjs',
  'bench',
  '--run',
  ...options.passthrough,
]

await run(vitestCommand, vitestArgs, env)
await run(options.target, ['scripts/bench-to-csv.ts'], env)

function parseArgs(args: string[]): BenchOptions {
  let target = normalizeTarget(process.env['BENCH_TARGET']) ?? 'node'
  let quick = false
  const passthrough: string[] = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === undefined) continue

    if (arg === '--') {
      passthrough.push(...args.slice(index + 1))
      break
    }

    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }

    if (arg === '--quick') {
      quick = true
      continue
    }

    if (arg === '--target') {
      const next = args[index + 1]
      const parsed = normalizeTarget(next)
      if (parsed === undefined) throw new Error('Expected --target node|bun')
      target = parsed
      index++
      continue
    }

    if (arg.startsWith('--target=')) {
      const parsed = normalizeTarget(arg.slice('--target='.length))
      if (parsed === undefined) throw new Error('Expected --target=node|bun')
      target = parsed
      continue
    }

    const positionalTarget = normalizeTarget(arg)
    if (positionalTarget !== undefined && passthrough.length === 0) {
      target = positionalTarget
      continue
    }

    passthrough.push(arg)
  }

  return { target, quick, passthrough }
}

function normalizeTarget(value: string | undefined): BenchTarget | undefined {
  return TARGETS.has(value as BenchTarget) ? (value as BenchTarget) : undefined
}

async function describeTargetRuntime(target: BenchTarget): Promise<string> {
  if (target === 'node') {
    return `node ${await readCommand('node', ['--version'])}`
  }

  const bunVersion = await readCommand('bun', ['--version'])
  const vitestVersion = await readCommand('bun', [
    'node_modules/vitest/vitest.mjs',
    '--version',
  ])
  const nodeCompat = /node-v(\S+)/.exec(vitestVersion)?.[1]
  return nodeCompat === undefined
    ? `bun ${bunVersion}`
    : `bun ${bunVersion} (node-compat ${nodeCompat})`
}

async function readCommand(command: string, args: string[]): Promise<string> {
  const result = await run(command, args, process.env, 'pipe')
  return result.trim()
}

async function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdout: 'inherit' | 'pipe' = 'inherit',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', stdout, 'inherit'],
    })
    let output = ''

    if (stdout === 'pipe') {
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        output += chunk
      })
    }

    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(output)
        return
      }

      reject(
        new Error(
          signal === null
            ? `${command} ${args.join(' ')} exited with code ${code}`
            : `${command} ${args.join(' ')} exited with signal ${signal}`,
        ),
      )
    })
  })
}

function printHelp(): void {
  console.log(`Usage: bun run bench [--target node|bun] [--quick] [vitest args...]

Targets:
  node  Run Vitest benchmarks with native Node. Default on this repo.
  bun   Run Vitest benchmarks with Bun's Node-compatible runtime.

Examples:
  bun run bench --target node
  bun run bench --target bun --quick
  bun run bench --target node src/overhead.bench.ts
`)
}
