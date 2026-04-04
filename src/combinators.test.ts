import {
  either,
  validate,
  firstOf,
  collect,
  ensure,
  ensureNotNull,
} from '#/combinators'
import { left, right, type Either } from '#/either'
import { describe, expect, it } from 'vitest'

function expectLeft<E>(result: Either<E, unknown>, error: E) {
  expect(result._tag).toBe('Left')
  if (result._tag === 'Left') expect(result.error).toEqual(error)
}

function expectRight<A>(result: Either<unknown, A>, value: A) {
  expect(result._tag).toBe('Right')
  if (result._tag === 'Right') expect(result.value).toEqual(value)
}

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }

const getUser = (id: string) =>
  // eslint-disable-next-line require-yield
  either(function* (raise) {
    if (id !== '1') return raise('UserNotFound' as const)
    return { id, name: 'Axel', active: true } satisfies User
  })

const getOrders = (userId: string): Either<'DbError', Order[]> =>
  right([{ id: 'order-1', userId }])

describe('either (sync)', () => {
  it('returns Right with the final value on success', () => {
    const result = either(function* (_raise) {
      const user = yield* getUser('1')
      const orders = yield* getOrders(user.id)
      return { user, first: orders[0] }
    })

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.value.user.name).toBe('Axel')
    expect(result.value.first?.id).toBe('order-1')
  })

  it('short-circuits on the first yielded Left', () => {
    const result = either(function* (_raise) {
      const user = yield* getUser('999')
      return user
    })

    expectLeft(result, 'UserNotFound')
  })

  it('short-circuits when raise() is yielded', () => {
    const result = either(function* (raise) {
      const user = yield* getUser('1')
      if (user.active) yield* raise('ForceInactive' as const)
      return user
    })

    expectLeft(result, 'ForceInactive')
  })

  it('does not short-circuit when the condition is not met', () => {
    const result = either(function* (raise) {
      const user = yield* getUser('1')
      if (!user.active) return raise('UserInactive' as const)
      return user
    })

    expect(result._tag).toBe('Right')
  })

  it('full program: success path', () => {
    const result = either(function* (raise) {
      const user = yield* getUser('1')
      if (!user.active) return raise('UserInactive' as const)
      const orders = yield* getOrders(user.id)
      if (!orders[0]) return raise('NoOrders' as const)
      return { user, first: orders[0] }
    })

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.value.user.id).toBe('1')
    expect(result.value.first.id).toBe('order-1')
  })

  it('full program: unknown user short-circuits', () => {
    const result = either(function* (raise) {
      const user = yield* getUser('999')
      if (!user.active) return raise('UserInactive' as const)
      const orders = yield* getOrders(user.id)
      if (!orders[0]) return raise('NoOrders' as const)
      return { user, first: orders[0] }
    })

    expectLeft(result, 'UserNotFound')
  })
})

const fetchUser = async (
  id: string,
): Promise<Either<'NotFound', { id: string; name: string }>> => {
  await Promise.resolve()
  return id === '1' ? right({ id, name: 'Axel' }) : left('NotFound' as const)
}

const fetchOrders = async (
  userId: string,
): Promise<Either<'DbError', string[]>> => {
  await Promise.resolve()
  return right([`order-for-${userId}`])
}

const rawFetch = async (url: string): Promise<{ data: string }> => {
  if (url === '/bad') return Promise.reject(new Error('Network error'))
  return Promise.resolve({ data: 'hello' })
}

describe('either (async)', () => {
  it('returns Right with the final value on success', async () => {
    const result = await either(async function* (_raise) {
      const user = yield* await fetchUser('1')
      const orders = yield* await fetchOrders(user.id)
      return { user, orders }
    })

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.value.user.name).toBe('Axel')
    expect(result.value.orders).toContain('order-for-1')
  })

  it('short-circuits on the first yielded Left', async () => {
    const result = await either(async function* (_raise) {
      const user = yield* await fetchUser('999')
      return user
    })

    expectLeft(result, 'NotFound')
  })

  it('short-circuits when NoOrders is raised', async () => {
    const fetchEmpty = async (): Promise<Either<'DbError', string[]>> =>
      right([])

    const result = await either(async function* (raise) {
      const user = yield* await fetchUser('1')
      const orders = yield* await fetchEmpty()
      if (orders.length === 0) return raise('NoOrders' as const)
      return { user, orders }
    })

    expectLeft(result, 'NoOrders')
  })

  it('raise(promise) captures a resolved promise as Right', async () => {
    const result = await either(async function* (raise) {
      const data = yield* await raise(rawFetch('/good'))
      return data
    })

    expect(result._tag).toBe('Right')
    if (result._tag !== 'Right') return
    expect(result.value.data).toBe('hello')
  })

  it('raise(promise) captures a rejected promise as Left<Rejected>', async () => {
    const result = await either(async function* (raise) {
      const data = yield* await raise(rawFetch('/bad'))
      return data
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    const err = result.error
    expect(err._tag).toBe('Rejected')
    expect((err.cause as Error).message).toBe('Network error')
  })
})

const validateAge = (n: number): Either<'TooYoung' | 'TooOld', number> =>
  n < 0 ? left('TooYoung') : n > 150 ? left('TooOld') : right(n)

const validateName = (s: string): Either<'Empty' | 'TooLong', string> =>
  s.length === 0 ? left('Empty') : s.length > 100 ? left('TooLong') : right(s)

describe('validate', () => {
  it('returns Right when all checks pass', () => {
    const result = validate(function* (check) {
      const age = yield* check(validateAge(25))
      const name = yield* check(validateName('Axel'))
      return { age, name }
    })

    expectRight(result, { age: 25, name: 'Axel' })
  })

  it('accumulates all errors, not just the first', () => {
    const result = validate(function* (check) {
      const age = yield* check(validateAge(-5))
      const name = yield* check(validateName(''))
      return { age, name }
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error).toContain('TooYoung')
    expect(result.error).toContain('Empty')
  })

  it('collects a single error when only one check fails', () => {
    const result = validate(function* (check) {
      const age = yield* check(validateAge(200))
      const name = yield* check(validateName('Axel'))
      return { age, name }
    })

    expectLeft(result, ['TooOld'])
  })
})

const fromCache = (): Either<'CacheMiss', string> => left('CacheMiss')
const fromDb = (): Either<'DbError', string> => left('DbError')
const fromApi = (): Either<'ApiError', string> => right('got it from API!')

describe('firstOf', () => {
  it('returns the first Right and stops', () => {
    const result = firstOf(function* () {
      yield fromCache()
      yield fromDb()
      yield fromApi()
    })

    expectRight(result, 'got it from API!')
  })

  it('returns Left with all errors when every attempt fails', () => {
    const result = firstOf(function* () {
      yield fromCache()
      yield fromDb()
    })

    expectLeft(result, ['CacheMiss', 'DbError'])
  })

  it('returns Right immediately when the first attempt succeeds', () => {
    let called = false
    const result = firstOf(function* () {
      yield right('instant')
      called = true
      yield fromApi()
    })

    expectRight(result, 'instant')
    expect(called).toBe(false)
  })
})

describe('collect', () => {
  it('partitions all results into errors and values', () => {
    const items = [
      right(1),
      left('err1' as const),
      right(2),
      left('err2' as const),
      right(3),
    ]

    const result = collect(function* () {
      for (const r of items) yield r
    })

    expect(result.values).toEqual([1, 2, 3])
    expect(result.errors).toEqual(['err1', 'err2'])
  })

  it('returns empty arrays when given no items', () => {
    const result = collect(function* () {})
    expect(result.values).toEqual([])
    expect(result.errors).toEqual([])
  })

  it('handles all Rights', () => {
    const result = collect(function* () {
      yield right(10)
      yield right(20)
    })

    expect(result.values).toEqual([10, 20])
    expect(result.errors).toEqual([])
  })

  it('handles all Lefts', () => {
    const result = collect(function* () {
      yield left('a' as const)
      yield left('b' as const)
    })

    expect(result.values).toEqual([])
    expect(result.errors).toEqual(['a', 'b'])
  })
})

describe('ensure', () => {
  it('returns Right<void> when condition is true', () => {
    expectRight(
      ensure(true, () => 'fail'),
      undefined,
    )
  })

  it('returns Left with the error when condition is false', () => {
    expectLeft(
      ensure(false, () => 'Nope'),
      'Nope',
    )
  })
})

describe('ensureNotNull', () => {
  it('returns Right when value is present', () => {
    expectRight(
      ensureNotNull('hello', () => 'Missing'),
      'hello',
    )
  })

  it('returns Left for null', () => {
    expectLeft(
      ensureNotNull(null, () => 'Missing'),
      'Missing',
    )
  })

  it('returns Left for undefined', () => {
    expectLeft(
      ensureNotNull(undefined, () => 'Missing'),
      'Missing',
    )
  })
})
