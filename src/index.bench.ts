import { either, validate, firstOf, collect } from '#/combinators'
import { left, right, type Either } from '#/either'
import { bench, describe } from 'vitest'

const BENCH_OPTS = { time: 1000, warmupTime: 300, warmupIterations: 20 }

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }

const USER: User = { id: '1', name: 'Axel', active: true }
const ORDERS: Order[] = [{ id: 'order-1', userId: '1' }]

const getUser = (id: string): Either<'UserNotFound', User> =>
  id === '1' ? right(USER) : left('UserNotFound')

const getOrders = (_userId: string): Either<'DbError', Order[]> => right(ORDERS)

const validateAge = (n: number): Either<'TooYoung' | 'TooOld', number> =>
  n < 0 ? left('TooYoung') : n > 150 ? left('TooOld') : right(n)

const validateName = (s: string): Either<'Empty' | 'TooLong', string> =>
  s.length === 0 ? left('Empty') : s.length > 100 ? left('TooLong') : right(s)

describe('baseline (plain functions, no Either)', () => {
  bench(
    'early exit via exception',
    () => {
      try {
        const user = null
        if (!user) throw new Error('UserNotFound')
        void user
      } catch {
        // expected
      }
    },
    BENCH_OPTS,
  )
})

describe('either (sync)', () => {
  bench(
    'single yield, success',
    () => {
      either(function* (_raise) {
        const user = yield* getUser('1')
        return user
      })
    },
    BENCH_OPTS,
  )

  bench(
    'two yields, success',
    () => {
      either(function* (raise) {
        const user = yield* getUser('1')
        if (!user.active) return raise('Inactive' as const)
        const orders = yield* getOrders(user.id)
        return { user, first: orders[0] }
      })
    },
    BENCH_OPTS,
  )

  bench(
    'single yield, Left (short-circuit)',
    () => {
      either(function* (_raise) {
        const user = yield* getUser('not-found')
        return user
      })
    },
    BENCH_OPTS,
  )

  bench(
    'yield* raise()',
    () => {
      either(function* (raise) {
        yield* raise('Boom' as const)
      })
    },
    BENCH_OPTS,
  )
})

const fetchUser = async (id: string): Promise<Either<'NotFound', User>> =>
  Promise.resolve(id === '1' ? right(USER) : left('NotFound' as const))

const fetchOrders = async (): Promise<Either<'DbError', Order[]>> =>
  Promise.resolve(right(ORDERS))

describe('either (async)', () => {
  bench(
    'two yields, success',
    async () => {
      await either(async function* (raise) {
        const user = yield* await fetchUser('1')
        const orders = yield* await fetchOrders()
        if (orders.length === 0) return raise('NoOrders' as const)
        return { user, orders }
      })
    },
    BENCH_OPTS,
  )

  bench(
    'single yield, Left (short-circuit)',
    async () => {
      await either(async function* (_raise) {
        const user = yield* await fetchUser('not-found')
        return user
      })
    },
    BENCH_OPTS,
  )
})

describe('validate', () => {
  bench(
    'two checks, all pass',
    () => {
      validate(function* (check) {
        const age = yield* check(validateAge(25))
        const name = yield* check(validateName('Axel'))
        return { age, name }
      })
    },
    BENCH_OPTS,
  )

  bench(
    'two checks, all fail (accumulate)',
    () => {
      validate(function* (check) {
        const age = yield* check(validateAge(-5))
        const name = yield* check(validateName(''))
        return { age, name }
      })
    },
    BENCH_OPTS,
  )
})

describe('firstOf', () => {
  bench(
    'first attempt succeeds',
    () => {
      firstOf(function* () {
        yield right('cached')
      })
    },
    BENCH_OPTS,
  )

  bench(
    'first two fail, third succeeds',
    () => {
      firstOf(function* () {
        yield left('CacheMiss' as const)
        yield left('DbError' as const)
        yield right('from-api')
      })
    },
    BENCH_OPTS,
  )

  bench(
    'all three fail',
    () => {
      firstOf(function* () {
        yield left('CacheMiss' as const)
        yield left('DbError' as const)
        yield left('ApiError' as const)
      })
    },
    BENCH_OPTS,
  )
})

const MIXED_10 = Array.from({ length: 10 }, (_, i) =>
  i % 2 === 0 ? right(i) : left(`err${i}` as const),
)

const MIXED_100 = Array.from({ length: 100 }, (_, i) =>
  i % 2 === 0 ? right(i) : left(`err${i}` as const),
)

describe('collect', () => {
  bench(
    '10 mixed results',
    () => {
      collect(function* () {
        for (const r of MIXED_10) yield r
      })
    },
    BENCH_OPTS,
  )

  bench(
    '100 mixed results',
    () => {
      collect(function* () {
        for (const r of MIXED_100) yield r
      })
    },
    BENCH_OPTS,
  )
})
