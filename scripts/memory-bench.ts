import { Result } from 'better-result'
import { fullGC, gcAndSweep } from 'bun:jsc'

import { either } from '../src/combinators'
import { left, right, type Either } from '../src/either'

const SYNC_ITERATIONS = Number(process.env['MEMORY_BENCH_SYNC'] ?? 200_000)
const ASYNC_ITERATIONS = Number(process.env['MEMORY_BENCH_ASYNC'] ?? 50_000)
const WARMUP_ITERATIONS = Number(process.env['MEMORY_BENCH_WARMUP'] ?? 10_000)
const OUTPUT_JSON = 'memory-results.json'
const OUTPUT_TEXT = 'memory-results.txt'

type ImplName = 'yeet' | 'better-result'
type Mode = 'transient' | 'retained'

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }

type MemorySnapshot = {
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
}

type MemoryDelta = MemorySnapshot

type ChildResult = {
  scenario: string
  impl: ImplName
  mode: Mode
  iterations: number
  before: MemorySnapshot
  after: MemorySnapshot
  delta: MemoryDelta
  postGc?: MemorySnapshot
  postGcDelta?: MemoryDelta
  checksum: number
}

type ReportRow = {
  scenario: string
  async: boolean
  impl: ImplName
  iterations: number
  transient: ChildResult
  retained: ChildResult
}

type BenchmarkOp = () => unknown

type Scenario = {
  name: string
  async: boolean
  iterations: number
  yeet: BenchmarkOp
  betterResult: BenchmarkOp
}

const USER: User = { id: '1', name: 'Axel', active: true }
const ORDERS: Order[] = [{ id: 'order-1', userId: '1' }]

const getUser = (id: string): Either<'UserNotFound', User> =>
  id === '1' ? right(USER) : left('UserNotFound')

const getOrders = (_userId: string): Either<'DbError', Order[]> => right(ORDERS)

const brGetUser = (id: string) =>
  id === '1' ? Result.ok(USER) : Result.err('UserNotFound' as const)

const brGetOrders = (_userId: string) => Result.ok(ORDERS)

const fetchUser = async (id: string): Promise<Either<'NotFound', User>> =>
  Promise.resolve(id === '1' ? right(USER) : left('NotFound' as const))

const fetchOrders = async (): Promise<Either<'DbError', Order[]>> =>
  Promise.resolve(right(ORDERS))

const brFetchUser = async (id: string) =>
  Promise.resolve(
    id === '1' ? Result.ok(USER) : Result.err('NotFound' as const),
  )

const brFetchOrders = async () => Promise.resolve(Result.ok(ORDERS))

const scenarios: Scenario[] = [
  {
    name: 'either - single yield, success',
    async: false,
    iterations: SYNC_ITERATIONS,
    yeet: () =>
      either(function* (_raise) {
        const user = yield* getUser('1')
        return user
      }),
    betterResult: () =>
      Result.gen(function* () {
        const user = yield* brGetUser('1')
        return Result.ok(user)
      }),
  },
  {
    name: 'either - two yields, success',
    async: false,
    iterations: SYNC_ITERATIONS,
    yeet: () =>
      either(function* (raise) {
        const user = yield* getUser('1')
        if (!user.active) yield* raise('Inactive' as const)
        const orders = yield* getOrders(user.id)
        return { user, first: orders[0] }
      }),
    betterResult: () =>
      Result.gen(function* () {
        const user = yield* brGetUser('1')
        if (!user.active) return Result.err('Inactive' as const)
        const orders = yield* brGetOrders(user.id)
        return Result.ok({ user, first: orders[0] })
      }),
  },
  {
    name: 'either - single yield, short-circuit',
    async: false,
    iterations: SYNC_ITERATIONS,
    yeet: () =>
      either(function* (_raise) {
        const user = yield* getUser('not-found')
        return user
      }),
    betterResult: () =>
      Result.gen(function* () {
        const user = yield* brGetUser('not-found')
        return Result.ok(user)
      }),
  },
  {
    name: 'either async - two yields, success',
    async: true,
    iterations: ASYNC_ITERATIONS,
    yeet: async () =>
      either(async function* (raise) {
        const user = yield* await fetchUser('1')
        const orders = yield* await fetchOrders()
        if (orders.length === 0) yield* raise('NoOrders' as const)
        return { user, orders }
      }),
    betterResult: async () =>
      Result.gen(async function* () {
        const user = yield* Result.await(brFetchUser('1'))
        const orders = yield* Result.await(brFetchOrders())
        if (orders.length === 0) return Result.err('NoOrders' as const)
        return Result.ok({ user, orders })
      }),
  },
  {
    name: 'either async - single yield, short-circuit',
    async: true,
    iterations: ASYNC_ITERATIONS,
    yeet: async () =>
      either(async function* (_raise) {
        const user = yield* await fetchUser('not-found')
        return user
      }),
    betterResult: async () =>
      Result.gen(async function* () {
        const user = yield* Result.await(brFetchUser('not-found'))
        return Result.ok(user)
      }),
  },
]

let checksum = 0

function snapshot(): MemorySnapshot {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  }
}

function delta(after: MemorySnapshot, before: MemorySnapshot): MemoryDelta {
  return {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
  }
}

function subtract(a: MemoryDelta, b: MemoryDelta): MemoryDelta {
  return {
    rss: a.rss - b.rss,
    heapTotal: a.heapTotal - b.heapTotal,
    heapUsed: a.heapUsed - b.heapUsed,
    external: a.external - b.external,
    arrayBuffers: a.arrayBuffers - b.arrayBuffers,
  }
}

function forceGc() {
  fullGC()
  gcAndSweep()
  fullGC()
}

function observe(value: unknown) {
  if (value !== null && typeof value === 'object') {
    if ('_tag' in value) {
      checksum += value._tag === 'Right' ? 3 : 5
      return
    }
    if ('status' in value) {
      checksum += value.status === 'ok' ? 7 : 11
      return
    }
  }
  checksum += value === undefined ? 13 : 17
}

async function runMany(
  op: BenchmarkOp,
  iterations: number,
  retain: boolean,
): Promise<unknown[]> {
  const retained = retain ? Array.from<unknown>({ length: iterations }) : []

  for (let i = 0; i < iterations; i++) {
    const value = await op()
    observe(value)
    if (retain) retained[i] = value
  }

  return retained
}

async function measureArrayBaseline(iterations: number): Promise<MemoryDelta> {
  forceGc()
  const before = snapshot()
  let retained: unknown[] = Array.from({ length: iterations }, () => null)
  observe(retained.length)
  forceGc()
  const after = snapshot()
  const result = delta(after, before)

  retained = []
  observe(retained.length)
  forceGc()

  return result
}

async function measureChild(
  scenario: Scenario,
  impl: ImplName,
  mode: Mode,
): Promise<ChildResult> {
  const op = impl === 'yeet' ? scenario.yeet : scenario.betterResult
  const warmupIterations = scenario.async
    ? Math.min(WARMUP_ITERATIONS, 2_000)
    : WARMUP_ITERATIONS

  await runMany(op, warmupIterations, false)

  if (mode === 'retained') {
    const baseline = await measureArrayBaseline(scenario.iterations)
    forceGc()
    const before = snapshot()
    let retained = await runMany(op, scenario.iterations, true)
    forceGc()
    const after = snapshot()
    const measuredDelta = subtract(delta(after, before), baseline)

    retained = []
    observe(retained.length)
    forceGc()

    return {
      scenario: scenario.name,
      impl,
      mode,
      iterations: scenario.iterations,
      before,
      after,
      delta: measuredDelta,
      checksum,
    }
  }

  forceGc()
  const before = snapshot()
  await runMany(op, scenario.iterations, false)
  const after = snapshot()
  forceGc()
  const postGc = snapshot()

  return {
    scenario: scenario.name,
    impl,
    mode,
    iterations: scenario.iterations,
    before,
    after,
    delta: delta(after, before),
    postGc,
    postGcDelta: delta(postGc, before),
    checksum,
  }
}

function formatBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : ''
  const abs = Math.abs(bytes)

  if (abs < 1024) return `${sign}${abs.toFixed(0)} B`

  const kib = abs / 1024
  if (kib < 1024) return `${sign}${kib.toFixed(1)} KiB`

  return `${sign}${(kib / 1024).toFixed(2)} MiB`
}

function formatBytesPerOp(bytes: number, iterations: number): string {
  return `${formatBytes(bytes / iterations)}/op`
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : `${value}${' '.repeat(width - value.length)}`
}

function compare(a: number, b: number): string {
  const absA = Math.abs(a)
  const absB = Math.abs(b)

  if (absA === 0 && absB === 0) return 'tie'
  if (absA === 0) return 'yeet lower'
  if (absB === 0) return 'better-result lower'

  const ratio = Math.max(absA, absB) / Math.min(absA, absB)
  return absA <= absB
    ? `yeet ${ratio.toFixed(2)}x lower`
    : `better-result ${ratio.toFixed(2)}x lower`
}

function renderText(rows: ReportRow[]): string {
  const lines: string[] = [
    '# Memory benchmark',
    '',
    `Bun: ${Bun.version}`,
    `Iterations: sync ${SYNC_ITERATIONS.toLocaleString()}, async ${ASYNC_ITERATIONS.toLocaleString()}`,
    '',
    'Transient growth is measured immediately after the batch, before an explicit GC.',
    'Retained output subtracts an empty-array baseline, forces GC, and keeps every returned Result/Either alive.',
    'RSS is coarse and may move in page-sized chunks; heapUsed is usually the most useful comparison.',
    '',
    [
      pad('Scenario', 43),
      pad('Impl', 14),
      pad('Batch heap/op', 18),
      pad('Batch RSS/op', 18),
      pad('Retained heap/op', 20),
      'Retained RSS/op',
    ].join('  '),
    [
      '-'.repeat(43),
      '-'.repeat(14),
      '-'.repeat(18),
      '-'.repeat(18),
      '-'.repeat(20),
      '-'.repeat(16),
    ].join('  '),
  ]

  for (const row of rows) {
    lines.push(
      [
        pad(row.scenario, 43),
        pad(row.impl, 14),
        pad(formatBytesPerOp(row.transient.delta.heapUsed, row.iterations), 18),
        pad(formatBytesPerOp(row.transient.delta.rss, row.iterations), 18),
        pad(formatBytesPerOp(row.retained.delta.heapUsed, row.iterations), 20),
        formatBytesPerOp(row.retained.delta.rss, row.iterations),
      ].join('  '),
    )
  }

  lines.push('', '## Retained heap comparison', '')

  for (const scenario of scenarios) {
    const yeet = rows.find(
      (row) => row.scenario === scenario.name && row.impl === 'yeet',
    )
    const betterResult = rows.find(
      (row) => row.scenario === scenario.name && row.impl === 'better-result',
    )

    if (!yeet || !betterResult) continue

    lines.push(
      `- ${scenario.name}: yeet ${formatBytesPerOp(
        yeet.retained.delta.heapUsed,
        yeet.iterations,
      )}, better-result ${formatBytesPerOp(
        betterResult.retained.delta.heapUsed,
        betterResult.iterations,
      )} (${compare(
        yeet.retained.delta.heapUsed,
        betterResult.retained.delta.heapUsed,
      )})`,
    )
  }

  return `${lines.join('\n')}\n`
}

async function runChildProcess() {
  const scenarioIndex = Number(process.env['MEMORY_BENCH_SCENARIO'])
  const impl = process.env['MEMORY_BENCH_IMPL'] as ImplName
  const mode = process.env['MEMORY_BENCH_MODE'] as Mode
  const scenario = scenarios[scenarioIndex]

  if (!scenario || (impl !== 'yeet' && impl !== 'better-result')) {
    throw new Error('Invalid memory benchmark child configuration')
  }

  if (mode !== 'transient' && mode !== 'retained') {
    throw new Error('Invalid memory benchmark mode')
  }

  const result = await measureChild(scenario, impl, mode)
  console.log(JSON.stringify(result))
}

async function runChild(
  scenarioIndex: number,
  impl: ImplName,
  mode: Mode,
): Promise<ChildResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, new URL(import.meta.url).pathname],
    env: {
      ...process.env,
      MEMORY_BENCH_CHILD: '1',
      MEMORY_BENCH_SCENARIO: String(scenarioIndex),
      MEMORY_BENCH_IMPL: impl,
      MEMORY_BENCH_MODE: mode,
    },
    stdout: 'pipe',
    stderr: 'inherit',
  })

  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    throw new Error(`memory bench child exited with code ${exitCode}`)
  }

  return JSON.parse(stdout) as ChildResult
}

async function runParent() {
  const rows: ReportRow[] = []

  for (const [scenarioIndex, scenario] of scenarios.entries()) {
    for (const impl of ['yeet', 'better-result'] as const) {
      const transient = await runChild(scenarioIndex, impl, 'transient')
      const retained = await runChild(scenarioIndex, impl, 'retained')
      rows.push({
        scenario: scenario.name,
        async: scenario.async,
        impl,
        iterations: scenario.iterations,
        transient,
        retained,
      })
    }
  }

  const output = renderText(rows)
  const json = {
    bun: Bun.version,
    iterations: {
      sync: SYNC_ITERATIONS,
      async: ASYNC_ITERATIONS,
      warmup: WARMUP_ITERATIONS,
    },
    rows,
  }

  await Bun.write(OUTPUT_JSON, `${JSON.stringify(json, null, 2)}\n`)
  await Bun.write(OUTPUT_TEXT, output)
  console.log(output)
  console.log(`memory results written to ${OUTPUT_JSON} and ${OUTPUT_TEXT}`)
}

if (process.env['MEMORY_BENCH_CHILD'] === '1') await runChildProcess()
else await runParent()

export {}
