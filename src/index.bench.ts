import { bench, describe } from 'vitest'

import { BENCH_OPTS } from './bench-options.ts'
import { __finish, either, validate, firstOf, collect } from './combinators.ts'
import { left, right, type Either } from './either.ts'

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
    'two yields, success (unplugin lowered)',
    () => {
      const result = (() => {
        const _user = getUser('1')
        if (_user._tag === 'Left') return _user
        const user = _user.value
        if (!user.active) return __finish(left('Inactive' as const))
        const _orders = getOrders(user.id)
        if (_orders._tag === 'Left') return _orders
        const orders = _orders.value
        return __finish({ user, first: orders[0] })
      })()
      void result
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
    'single yield, Left (unplugin lowered)',
    () => {
      const result = (() => {
        const _user = getUser('not-found')
        if (_user._tag === 'Left') return _user
        const user = _user.value
        return __finish(user)
      })()
      void result
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
    'two yields, success (unplugin lowered)',
    async () => {
      const result = await (async () => {
        const _user = await fetchUser('1')
        if (_user._tag === 'Left') return _user
        const user = _user.value
        const _orders = await fetchOrders()
        if (_orders._tag === 'Left') return _orders
        const orders = _orders.value
        if (orders.length === 0) return __finish(left('NoOrders' as const))
        return __finish({ user, orders })
      })()
      void result
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
    'two checks, all pass (unplugin lowered)',
    () => {
      const result = (() => {
        let _errors: unknown[] | undefined
        const _age = validateAge(25)
        if (_age._tag === 'Left') {
          if (_errors === undefined) _errors = []
          _errors.push(_age.error)
        }
        const age = _age._tag === 'Right' ? _age.value : undefined
        const _name = validateName('Axel')
        if (_name._tag === 'Left') {
          if (_errors === undefined) _errors = []
          _errors.push(_name.error)
        }
        const name = _name._tag === 'Right' ? _name.value : undefined
        const _ret = { age, name }
        return _errors === undefined ? right(_ret) : left(_errors)
      })()
      void result
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

  bench(
    'two checks, all fail (unplugin lowered)',
    () => {
      const result = (() => {
        let _errors: unknown[] | undefined
        const _age = validateAge(-5)
        if (_age._tag === 'Left') {
          if (_errors === undefined) _errors = []
          _errors.push(_age.error)
        }
        const age = _age._tag === 'Right' ? _age.value : undefined
        const _name = validateName('')
        if (_name._tag === 'Left') {
          if (_errors === undefined) _errors = []
          _errors.push(_name.error)
        }
        const name = _name._tag === 'Right' ? _name.value : undefined
        const _ret = { age, name }
        return _errors === undefined ? right(_ret) : left(_errors)
      })()
      void result
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
    'first attempt succeeds (unplugin lowered)',
    () => {
      const result = (() => {
        let _errors: unknown[] | undefined
        const _attempt = right('cached') as unknown as Either<unknown, unknown>
        if (_attempt._tag === 'Right') return right(_attempt.value)
        if (_errors === undefined) _errors = []
        _errors.push(_attempt.error)
        return _errors === undefined ? right(undefined) : left(_errors)
      })()
      void result
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
    'first two fail, third succeeds (unplugin lowered)',
    () => {
      const result = (() => {
        let _errors: unknown[] | undefined
        const _cache = left('CacheMiss' as const) as unknown as Either<
          unknown,
          unknown
        >
        if (_cache._tag === 'Right') return right(_cache.value)
        if (_errors === undefined) _errors = []
        _errors.push(_cache.error)
        const _db = left('DbError' as const) as unknown as Either<
          unknown,
          unknown
        >
        if (_db._tag === 'Right') return right(_db.value)
        if (_errors === undefined) _errors = []
        _errors.push(_db.error)
        const _api = right('from-api') as unknown as Either<unknown, unknown>
        if (_api._tag === 'Right') return right(_api.value)
        if (_errors === undefined) _errors = []
        _errors.push(_api.error)
        return _errors === undefined ? right(undefined) : left(_errors)
      })()
      void result
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

  bench(
    'all three fail (unplugin lowered)',
    () => {
      const result = (() => {
        let _errors: unknown[] | undefined
        const _cache = left('CacheMiss' as const) as unknown as Either<
          unknown,
          unknown
        >
        if (_cache._tag === 'Right') return right(_cache.value)
        if (_errors === undefined) _errors = []
        _errors.push(_cache.error)
        const _db = left('DbError' as const) as unknown as Either<
          unknown,
          unknown
        >
        if (_db._tag === 'Right') return right(_db.value)
        if (_errors === undefined) _errors = []
        _errors.push(_db.error)
        const _api = left('ApiError' as const) as unknown as Either<
          unknown,
          unknown
        >
        if (_api._tag === 'Right') return right(_api.value)
        if (_errors === undefined) _errors = []
        _errors.push(_api.error)
        return _errors === undefined ? right(undefined) : left(_errors)
      })()
      void result
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
    '10 mixed results (unplugin lowered)',
    () => {
      const result = (() => {
        const errors = []
        const values = []
        for (const r of MIXED_10) {
          if (r._tag === 'Left') errors.push(r.error)
          else values.push(r.value)
        }
        return { errors, values }
      })()
      void result
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

  bench(
    '100 mixed results (unplugin lowered)',
    () => {
      const result = (() => {
        const errors = []
        const values = []
        for (const r of MIXED_100) {
          if (r._tag === 'Left') errors.push(r.error)
          else values.push(r.value)
        }
        return { errors, values }
      })()
      void result
    },
    BENCH_OPTS,
  )
})
