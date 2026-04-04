import { Result } from 'better-result'

const BENCH_OPTS = { time: 1000, warmupTime: 300, warmupIterations: 20 }

/**
 * Head-to-head benchmarks: yeet vs better-result@2.7.0
 *
 * Mirrors the either scenarios from index.bench.ts as closely as the two
 * APIs allow:
 *
 *   yeet          │ better-result
 *   ──────────────┼──────────────────────────────────────────────────
 *   right(v)      │ Result.ok(v)
 *   left(e)       │ Result.err(e)
 *   either(fn*)   │ Result.gen(fn*)  — must return Result.ok/err
 *
 * validate / firstOf have no equivalents in better-result and are omitted.
 * collect vs Result.partition is apples-to-oranges (generator vs plain array)
 * and is also omitted.
 */
import { bench, describe } from 'vitest'

import { either } from './combinators'
import { left, right, type Either } from './either'

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }

const USER: User = { id: '1', name: 'Axel', active: true }
const ORDERS: Order[] = [{ id: 'order-1', userId: '1' }]

// yeet helpers
const getUser = (id: string): Either<'UserNotFound', User> =>
  id === '1' ? right(USER) : left('UserNotFound')

const getOrders = (_userId: string): Either<'DbError', Order[]> => right(ORDERS)

// better-result helpers
const brGetUser = (id: string) =>
  id === '1' ? Result.ok(USER) : Result.err('UserNotFound' as const)

const brGetOrders = (_userId: string) => Result.ok(ORDERS)

// ---------------------------------------------------------------------------
// Sync: single yield, success
// ---------------------------------------------------------------------------

describe('either — single yield, success', () => {
  bench('yeet', () => {
    either(function* (_raise) {
      const user = yield* getUser('1')
      return user
    })
  }, BENCH_OPTS)

  bench('better-result', () => {
    Result.gen(function* () {
      const user = yield* brGetUser('1')
      return Result.ok(user)
    })
  }, BENCH_OPTS)
})

// ---------------------------------------------------------------------------
// Sync: two yields, success
// ---------------------------------------------------------------------------

describe('either — two yields, success', () => {
  bench('yeet', () => {
    either(function* (raise) {
      const user = yield* getUser('1')
      if (!user.active) yield* raise('Inactive' as const)
      const orders = yield* getOrders(user.id)
      return { user, first: orders[0] }
    })
  }, BENCH_OPTS)

  bench('better-result', () => {
    Result.gen(function* () {
      const user = yield* brGetUser('1')
      if (!user.active) return Result.err('Inactive' as const)
      const orders = yield* brGetOrders(user.id)
      return Result.ok({ user, first: orders[0] })
    })
  }, BENCH_OPTS)
})

// ---------------------------------------------------------------------------
// Sync: single yield, Left / Err (short-circuit)
// ---------------------------------------------------------------------------

describe('either — single yield, short-circuit', () => {
  bench('yeet', () => {
    either(function* (_raise) {
      const user = yield* getUser('not-found')
      return user
    })
  }, BENCH_OPTS)

  bench('better-result', () => {
    Result.gen(function* () {
      const user = yield* brGetUser('not-found')
      return Result.ok(user)
    })
  }, BENCH_OPTS)
})

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

const fetchUser = async (id: string): Promise<Either<'NotFound', User>> =>
  Promise.resolve(id === '1' ? right(USER) : left('NotFound' as const))

const fetchOrders = async (): Promise<Either<'DbError', Order[]>> =>
  Promise.resolve(right(ORDERS))

const brFetchUser = async (id: string) =>
  Promise.resolve(
    id === '1' ? Result.ok(USER) : Result.err('NotFound' as const),
  )

const brFetchOrders = async () => Promise.resolve(Result.ok(ORDERS))

// ---------------------------------------------------------------------------
// Async: two yields, success
// ---------------------------------------------------------------------------

describe('either async — two yields, success', () => {
  bench('yeet', async () => {
    await either(async function* (raise) {
      const user = yield* await fetchUser('1')
      const orders = yield* await fetchOrders()
      if (orders.length === 0) yield* raise('NoOrders' as const)
      return { user, orders }
    })
  }, BENCH_OPTS)

  bench('better-result', async () => {
    await Result.gen(async function* () {
      const user = yield* Result.await(brFetchUser('1'))
      const orders = yield* Result.await(brFetchOrders())
      if (orders.length === 0) return Result.err('NoOrders' as const)
      return Result.ok({ user, orders })
    })
  }, BENCH_OPTS)
})

// ---------------------------------------------------------------------------
// Async: single yield, short-circuit
// ---------------------------------------------------------------------------

describe('either async — single yield, short-circuit', () => {
  bench('yeet', async () => {
    await either(async function* (_raise) {
      const user = yield* await fetchUser('not-found')
      return user
    })
  }, BENCH_OPTS)

  bench('better-result', async () => {
    await Result.gen(async function* () {
      const user = yield* Result.await(brFetchUser('not-found'))
      return Result.ok(user)
    })
  }, BENCH_OPTS)
})
