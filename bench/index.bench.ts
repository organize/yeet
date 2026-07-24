import { afterAll, bench, describe } from 'vitest'

import yeet from '../src/unplugin.ts'
import { cleanupBenchFixtures, importBenchFixture } from './bench-fixture.ts'
import { BENCH_OPTS } from './bench-options.ts'

const YEET_SOURCE = new URL('../src/index.ts', import.meta.url).href
const FIXTURE_ID = 'bench/index.bench.fixture.js'
const BENCH_BATCH = readPositiveInt('BENCH_BATCH', 64)

type BenchModule = {
  baselineException: (index: number) => unknown
  eitherSingleYieldSuccess: (index: number) => unknown
  eitherTwoYieldsSuccess: (index: number) => unknown
  eitherSingleYieldLeft: (index: number) => unknown
  eitherYieldRaise: (index: number) => unknown
  eitherFusedGuardsSuccess: (index: number) => unknown
  eitherFusedGuardsLeft: (index: number) => unknown
  eitherFusedCaptureRight: (index: number) => unknown
  eitherFusedCaptureLeft: (index: number) => unknown
  eitherAsyncTwoYieldsSuccess: (index: number) => Promise<unknown>
  eitherAsyncSingleYieldLeft: (index: number) => Promise<unknown>
  validateAllPass: (index: number) => unknown
  validateAllFail: (index: number) => unknown
  firstOfFirstSucceeds: (index: number) => unknown
  firstOfThirdSucceeds: (index: number) => unknown
  firstOfAllFail: (index: number) => unknown
  collect10: (index: number) => unknown
  collect100: (index: number) => unknown
}

type RawPlugin = {
  readonly transform?: {
    readonly handler?: (
      code: string,
      id: string,
    ) =>
      | string
      | { readonly code: string }
      | null
      | Promise<
          | string
          | {
              readonly code: string
            }
          | null
        >
  }
}

const BENCH_SOURCE = `
  import {
    either,
    validate,
    firstOf,
    collect,
    ensure,
    ensureNotNull,
    left,
    right,
  } from ${JSON.stringify(YEET_SOURCE)}

  const USERS = {
    "1": { id: "1", name: "Axel", active: true },
    "2": { id: "2", name: "Bea", active: true },
  }
  const HIT_IDS = ["1", "2"]
  const MISS_IDS = ["missing-a", "missing-b"]
  const EMPTY_IDS = ["", ""]
  const CACHE_HITS = [right("cached-a"), right("cached-b")]
  const CACHE_MISSES = [left("CacheMissA"), left("CacheMissB")]
  const ORDERS = {
    "1": [{ id: "order-1", userId: "1" }],
    "2": [{ id: "order-2", userId: "2" }],
  }
  const PASS_AGES = [25, 42]
  const FAIL_AGES = [-1, 151]
  const PASS_NAMES = ["Axel", "Bea"]
  const FAIL_NAMES = ["", "x".repeat(101)]
  const CACHE_ERRORS = ["CacheMissA", "CacheMissB"]
  const DB_ERRORS = ["DbErrorA", "DbErrorB"]
  const API_ERRORS = ["ApiErrorA", "ApiErrorB"]
  const API_VALUES = ["from-api-a", "from-api-b"]
  const MIXED_10_A = Array.from({ length: 10 }, (_, index) =>
    index % 2 === 0 ? right(index) : left("err-a-" + index),
  )
  const MIXED_10_B = Array.from({ length: 10 }, (_, index) =>
    index % 2 === 0 ? right(index + 10) : left("err-b-" + index),
  )
  const MIXED_100_A = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? right(index) : left("err-a-" + index),
  )
  const MIXED_100_B = Array.from({ length: 100 }, (_, index) =>
    index % 2 === 0 ? right(index + 100) : left("err-b-" + index),
  )

  function bit(index) {
    return index & 1
  }

  function getUser(id) {
    const user = USERS[id]
    return user === undefined ? left("UserNotFound") : right(user)
  }

  function getOrders(userId) {
    return right(ORDERS[userId])
  }

  function validateAge(age) {
    return age < 0 ? left("TooYoung") : age > 150 ? left("TooOld") : right(age)
  }

  function validateName(name) {
    return name.length === 0
      ? left("Empty")
      : name.length > 100
        ? left("TooLong")
        : right(name)
  }

  async function fetchUser(id) {
    return getUser(id)
  }

  async function fetchOrders(userId) {
    return getOrders(userId)
  }

  export function baselineException(index) {
    try {
      const user = bit(index) === 0 ? null : undefined
      if (user === null || user === undefined) throw new Error("UserNotFound")
      return user
    } catch (error) {
      return error
    }
  }

  export function eitherSingleYieldSuccess(index) {
    return either(function* () {
      const user = yield* getUser(HIT_IDS[bit(index)])
      return user
    })
  }

  export function eitherTwoYieldsSuccess(index) {
    return either(function* (raise) {
      const user = yield* getUser(HIT_IDS[bit(index)])
      if (!user.active) return raise("Inactive")
      const orders = yield* getOrders(user.id)
      return { user, first: orders[0] }
    })
  }

  export function eitherSingleYieldLeft(index) {
    return either(function* () {
      const user = yield* getUser(MISS_IDS[bit(index)])
      return user
    })
  }

  export function eitherYieldRaise(index) {
    return either(function* (raise) {
      return raise(bit(index) === 0 ? "BoomA" : "BoomB")
    })
  }

  export function eitherFusedGuardsSuccess(index) {
    const candidate = HIT_IDS[bit(index)]
    return either(function* () {
      const id = yield* ensureNotNull(candidate, () => "MissingId")
      yield* ensure(id.length > 0, () => "EmptyId")
      const normalized = yield* right(id.toUpperCase())
      return normalized.length
    })
  }

  export function eitherFusedGuardsLeft(index) {
    const candidate = EMPTY_IDS[bit(index)]
    return either(function* () {
      const id = yield* ensureNotNull(candidate, () => "MissingId")
      yield* ensure(id.length > 0, () => "EmptyId")
      return id.length
    })
  }

  export function eitherFusedCaptureRight(index) {
    return either(function* ({ raise }) {
      const cached = raise.capture(CACHE_HITS[bit(index)])
      if (cached._tag === "Right") return cached.value
      return yield* getUser(HIT_IDS[bit(index)])
    })
  }

  export function eitherFusedCaptureLeft(index) {
    return either(function* ({ raise }) {
      const cached = raise.capture(CACHE_MISSES[bit(index)])
      if (cached._tag === "Right") return cached.value
      const user = yield* getUser(HIT_IDS[bit(index)])
      return user.name
    })
  }

  export async function eitherAsyncTwoYieldsSuccess(index) {
    return either(async function* (raise) {
      const user = yield* await fetchUser(HIT_IDS[bit(index)])
      const orders = yield* await fetchOrders(user.id)
      if (orders.length === 0) return raise("NoOrders")
      return { user, orders }
    })
  }

  export async function eitherAsyncSingleYieldLeft(index) {
    return either(async function* () {
      const user = yield* await fetchUser(MISS_IDS[bit(index)])
      return user
    })
  }

  export function validateAllPass(index) {
    return validate(function* (check) {
      const age = yield* check(validateAge(PASS_AGES[bit(index)]))
      const name = yield* check(validateName(PASS_NAMES[bit(index)]))
      return { age, name }
    })
  }

  export function validateAllFail(index) {
    return validate(function* (check) {
      const age = yield* check(validateAge(FAIL_AGES[bit(index)]))
      const name = yield* check(validateName(FAIL_NAMES[bit(index)]))
      return { age, name }
    })
  }

  export function firstOfFirstSucceeds(index) {
    return firstOf(function* () {
      yield right("cached-" + bit(index))
    })
  }

  export function firstOfThirdSucceeds(index) {
    return firstOf(function* () {
      yield left(CACHE_ERRORS[bit(index)])
      yield left(DB_ERRORS[bit(index)])
      yield right(API_VALUES[bit(index)])
    })
  }

  export function firstOfAllFail(index) {
    return firstOf(function* () {
      yield left(CACHE_ERRORS[bit(index)])
      yield left(DB_ERRORS[bit(index)])
      yield left(API_ERRORS[bit(index)])
    })
  }

  export function collect10(index) {
    const items = bit(index) === 0 ? MIXED_10_A : MIXED_10_B
    return collect(function* () {
      for (const item of items) yield item
    })
  }

  export function collect100(index) {
    const items = bit(index) === 0 ? MIXED_100_A : MIXED_100_B
    return collect(function* () {
      for (const item of items) yield item
    })
  }
`

const runtime = await importBenchModule(BENCH_SOURCE)
const optimized = await importBenchModule(
  await transformWithPlugin(BENCH_SOURCE),
)
const benchSink = { value: undefined as unknown }

afterAll(async () => {
  void benchSink.value
  await cleanupBenchFixtures()
})

async function importBenchModule(code: string): Promise<BenchModule> {
  return importBenchFixture<BenchModule>(code, 'index')
}

async function transformWithPlugin(code: string): Promise<string> {
  const plugin = yeet.raw({ moduleNames: [YEET_SOURCE] }) as RawPlugin
  const handler = plugin.transform?.handler
  if (handler === undefined) {
    throw new TypeError('yeet.raw() did not expose a transform handler')
  }

  const result = await handler(code, FIXTURE_ID)
  if (result === null) {
    throw new Error('yeet unplugin did not transform the benchmark fixture')
  }

  return typeof result === 'string' ? result : result.code
}

function consume(value: unknown): void {
  benchSink.value = value
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}

function indexer(): () => number {
  let index = 0
  return () => index++
}

function consumeBatch(
  module: BenchModule,
  fn: keyof BenchModule,
  next: () => number,
): void {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = module[fn](next())
  }
  consume(value)
}

async function consumeAsyncBatch(
  module: BenchModule,
  fn: keyof BenchModule,
  next: () => number,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = await module[fn](next())
  }
  consume(value)
}

function benchPair(
  suite: string,
  name: string,
  fn: keyof BenchModule,
  options: typeof BENCH_OPTS = BENCH_OPTS,
): void {
  describe(suite, () => {
    const runtimeIndex = indexer()
    bench(
      name,
      () => {
        consumeBatch(runtime, fn, runtimeIndex)
      },
      options,
    )

    const optimizedIndex = indexer()
    bench(
      `${name} (unplugin transformed)`,
      () => {
        consumeBatch(optimized, fn, optimizedIndex)
      },
      options,
    )
  })
}

function benchAsyncPair(
  suite: string,
  name: string,
  fn: keyof BenchModule,
  options: typeof BENCH_OPTS = BENCH_OPTS,
): void {
  describe(suite, () => {
    const runtimeIndex = indexer()
    bench(
      name,
      async () => {
        await consumeAsyncBatch(runtime, fn, runtimeIndex)
      },
      options,
    )

    const optimizedIndex = indexer()
    bench(
      `${name} (unplugin transformed)`,
      async () => {
        await consumeAsyncBatch(optimized, fn, optimizedIndex)
      },
      options,
    )
  })
}

describe('baseline (plain functions, no Either)', () => {
  const next = indexer()
  bench(
    'early exit via exception',
    () => {
      let value: unknown
      for (let batch = 0; batch < BENCH_BATCH; batch++) {
        value = runtime.baselineException(next())
      }
      consume(value)
    },
    BENCH_OPTS,
  )
})

benchPair('either (sync)', 'single yield, success', 'eitherSingleYieldSuccess')
benchPair('either (sync)', 'two yields, success', 'eitherTwoYieldsSuccess')
benchPair('either (sync)', 'single yield, Left', 'eitherSingleYieldLeft')

benchPair(
  'either (fused intrinsics)',
  'guards, success',
  'eitherFusedGuardsSuccess',
)
benchPair('either (fused intrinsics)', 'guards, Left', 'eitherFusedGuardsLeft')
benchPair(
  'either (fused intrinsics)',
  'raise.capture, Right',
  'eitherFusedCaptureRight',
)
benchPair(
  'either (fused intrinsics)',
  'raise.capture, Left then fallback',
  'eitherFusedCaptureLeft',
)

describe('either (sync)', () => {
  const next = indexer()
  bench(
    'return raise()',
    () => {
      let value: unknown
      for (let batch = 0; batch < BENCH_BATCH; batch++) {
        value = runtime.eitherYieldRaise(next())
      }
      consume(value)
    },
    BENCH_OPTS,
  )
})

benchAsyncPair(
  'either (async)',
  'two yields, success',
  'eitherAsyncTwoYieldsSuccess',
)
benchAsyncPair(
  'either (async)',
  'single yield, Left',
  'eitherAsyncSingleYieldLeft',
)

benchPair('validate', 'two checks, all pass', 'validateAllPass')
benchPair('validate', 'two checks, all fail', 'validateAllFail')

benchPair('firstOf', 'first attempt succeeds', 'firstOfFirstSucceeds')
benchPair('firstOf', 'first two fail, third succeeds', 'firstOfThirdSucceeds')
benchPair('firstOf', 'all three fail', 'firstOfAllFail')

benchPair('collect', '10 mixed results', 'collect10')
benchPair('collect', '100 mixed results', 'collect100')
