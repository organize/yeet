import { describe, expect, it } from 'vitest'

import {
  type Aborted,
  type Exit,
  type ExitError,
  type ForkEachIterator,
  type Rejected,
  type ScopeSignal,
  type ScopeTask,
  forkEachStopped,
  raise,
  siblingSettled,
} from './async.ts'
import {
  either,
  validate,
  firstOf,
  collect,
  all,
  collectAll,
  ensure,
  ensureNotNull,
} from './combinators.ts'
import { left, right, type Either, type Left } from './either.ts'
import { exitSchema, type StandardSchemaV1 } from './schema.ts'

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
  // oxlint-disable-next-line require-yield
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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (cause: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 5; index++) await Promise.resolve()
}

type TrackedDisposable = Disposable & { readonly name: string }
type TrackedAsyncDisposable = AsyncDisposable & { readonly name: string }

function disposable(name: string, events: string[]): TrackedDisposable {
  return {
    name,
    [Symbol.dispose]() {
      events.push(`dispose ${name}`)
    },
  }
}

function asyncDisposable(
  name: string,
  events: string[],
): TrackedAsyncDisposable {
  return {
    name,
    async [Symbol.asyncDispose]() {
      events.push(`dispose ${name}:start`)
      await Promise.resolve()
      events.push(`dispose ${name}:end`)
    },
  }
}

function throwingAsyncDisposable(
  name: string,
  events: string[],
  error: Error,
): TrackedAsyncDisposable {
  return {
    name,
    async [Symbol.asyncDispose]() {
      events.push(`dispose ${name}`)
      await Promise.resolve()
      throw error
    },
  }
}

function expectSuppressedError(
  thrown: unknown,
  error: Error,
  suppressed: Error,
) {
  expect(thrown).toBeInstanceOf(SuppressedError)
  if (!(thrown instanceof SuppressedError)) return
  expect(thrown.error).toBe(error)
  expect(thrown.suppressed).toBe(suppressed)
}

async function abortAsLeft<const E>(
  signal: AbortSignal,
  error: E,
): Promise<Either<E, never>> {
  if (signal.aborted) return left(error)

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(left(error)), {
      once: true,
    })
  })
}

async function rejectOnAbort(
  signal: AbortSignal,
  cause: unknown,
): Promise<Either<never, never>> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  throw cause
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

  it('raise(fn) captures a synchronous return as Right', async () => {
    const result = await either(async function* (raise) {
      const data = yield* await raise(() => 'hello' as const)
      return data
    })

    expectRight(result, 'hello')
  })

  it('raise(fn) captures a synchronous throw as Left<Rejected>', async () => {
    const cause = new Error('Sync explosion')
    const result = await either(async function* (raise) {
      const data = yield* await raise(() => {
        throw cause
      })
      return data
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBe(cause)
  })

  it('raise(fn) captures a returned rejected promise as Left<Rejected>', async () => {
    const cause = new Error('Async explosion')
    const result = await either(async function* (raise) {
      const data = yield* await raise(async () => {
        throw cause
      })
      return data
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBe(cause)
  })

  it('raise(thenable) captures custom thenables', async () => {
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable
      then(resolve: (value: string) => void) {
        resolve('from-thenable')
      },
    } as PromiseLike<string>

    const result = await either(async function* (raise) {
      const data = yield* await raise(thenable)
      return data
    })

    expectRight(result, 'from-thenable')
  })

  it('raise(thenable) captures a throwing then getter', async () => {
    const cause = new Error('Broken then getter')
    // oxlint-disable-next-line unicorn/no-thenable
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        throw cause
      },
    }) as PromiseLike<never>

    const result = await either(async function* (raise) {
      return yield* await raise(thenable)
    })

    expectLeft(result, { _tag: 'Rejected', cause })
  })
})

describe('either scoped signal', () => {
  it('keeps raise destructuring callable in sync either', () => {
    const result = either(function* ({ raise }) {
      yield* right(undefined)
      return raise('Nope' as const)
    })

    expectLeft(result, 'Nope')
  })

  it('runs forked async tasks inside a non-abortable either scope', async () => {
    const resultPromise = either(async function* ({ signal }) {
      const user = signal.fork(async () => {
        await Promise.resolve()
        return right({ id: 'user-1' as const })
      })
      const settings = signal.fork(() => right({ theme: 'dark' as const }))

      return {
        user: yield* await user,
        settings: yield* await settings,
      }
    })
    const typed: Promise<
      Either<
        ExitError<never>,
        {
          user: { id: 'user-1' }
          settings: { theme: 'dark' }
        }
      >
    > = resultPromise

    expect(typed).toBe(resultPromise)
    expectRight(await resultPromise, {
      user: { id: 'user-1' },
      settings: { theme: 'dark' },
    })
  })

  it('cancels sibling tasks when a fork returns Left', async () => {
    const events: string[] = []
    const reasons: unknown[] = []

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        const slow = signal.fork(async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
          reasons.push(child.reason)
          events.push('slow:aborted')
          return result
        })

        void signal.fork(() => {
          events.push('fail')
          return left('Boom' as const)
        })

        yield* await slow
        return 'done' as const
      },
    )

    expectLeft(result as Either<unknown, unknown>, 'Boom')
    expect(events).toEqual(['slow:start', 'fail', 'slow:aborted'])
    expect(reasons).toEqual(['Boom'])
  })

  it('runs signal.forkAll concurrently and preserves tuple order', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkAll([
        async () => first.promise,
        async () => second.promise,
      ] as const)
    })
    const typed: Promise<
      Exit<'FirstFailed' | 'SecondFailed', [number, string]>
    > = resultPromise

    expect(typed).toBe(resultPromise)
    second.resolve(right('two'))
    first.resolve(right(1))

    expectRight(await resultPromise, [1, 'two'])
  })

  it('cancels sibling tasks when signal.forkAll sees a Left', async () => {
    const events: string[] = []
    const reasons: unknown[] = []

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkAll([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
          reasons.push(child.reason)
          events.push('slow:aborted')
          return result
        },
        () => {
          events.push('fail')
          return left('Boom' as const)
        },
      ] as const)
    })

    expectLeft(result as Either<unknown, unknown>, 'Boom')
    expect(events).toEqual(['slow:start', 'fail', 'slow:aborted'])
    expect(reasons).toEqual(['Boom'])
  })

  it('runs every forkFirst task and keeps racing after Left and Rejected candidates', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()
    const third = deferred<Either<'ThirdFailed', boolean>>()
    const cause = new Error('second exploded')
    const started: number[] = []

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async () => {
          started.push(0)
          return first.promise
        },
        async () => {
          started.push(1)
          return second.promise
        },
        async () => {
          started.push(2)
          return third.promise
        },
      ] as const)
    })
    const typed: Promise<
      Exit<
        [
          ExitError<'FirstFailed'>,
          ExitError<'SecondFailed'>,
          ExitError<'ThirdFailed'>,
        ],
        number | string | boolean
      >
    > = resultPromise

    expect(typed).toBe(resultPromise)
    expect(started).toEqual([0, 1, 2])

    first.resolve(left('FirstFailed'))
    second.reject(cause)
    await flushAsyncWork()
    third.resolve(right(true))

    expectRight(await resultPromise, true)
  })

  it('returns all forkFirst failures in input order', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async () => first.promise,
        async () => second.promise,
      ] as const)
    })

    second.resolve(left('SecondFailed'))
    await flushAsyncWork()
    first.resolve(left('FirstFailed'))

    expectLeft(await resultPromise, ['FirstFailed', 'SecondFailed'])
  })

  it('round-trips ordered forkFirst failures through exitSchema', async () => {
    type OpenAIFailure = {
      readonly _tag: 'OpenAIUnavailable'
      readonly status: number
    }
    type AnthropicFailure = {
      readonly _tag: 'AnthropicUnavailable'
      readonly requestId: string
    }
    type ProviderFailures = [OpenAIFailure, AnthropicFailure]

    const openAI = deferred<Either<OpenAIFailure, string>>()
    const anthropic = deferred<Either<AnthropicFailure, string>>()
    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async () => openAI.promise,
        async () => anthropic.promise,
      ] as const)
    })

    anthropic.resolve(
      left({ _tag: 'AnthropicUnavailable', requestId: 'req-2' }),
    )
    await flushAsyncWork()
    openAI.resolve(left({ _tag: 'OpenAIUnavailable', status: 503 }))

    const result = await resultPromise
    const providerFailuresSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate(value: unknown) {
          if (!Array.isArray(value) || value.length !== 2)
            return { issues: [{ message: 'Expected provider failure tuple' }] }

          const [first, second] = value as [
            Partial<OpenAIFailure>,
            Partial<AnthropicFailure>,
          ]
          return first._tag === 'OpenAIUnavailable' &&
            typeof first.status === 'number' &&
            second._tag === 'AnthropicUnavailable' &&
            typeof second.requestId === 'string'
            ? { value: value as ProviderFailures }
            : { issues: [{ message: 'Expected provider failure tuple' }] }
        },
      },
    } satisfies StandardSchemaV1<unknown, ProviderFailures>
    const schema = exitSchema({
      error: providerFailuresSchema,
    })
    const wireValue: unknown = JSON.parse(JSON.stringify(result))
    const hydrated = await schema['~standard'].validate(wireValue)

    expect(hydrated.issues).toBeUndefined()
    if (hydrated.issues !== undefined) return
    expectLeft(hydrated.value, [
      { _tag: 'OpenAIUnavailable', status: 503 },
      { _tag: 'AnthropicUnavailable', requestId: 'req-2' },
    ])
  })

  it('widens forkFirst failures for dynamic task arrays', async () => {
    const tasks: ScopeTask<'Unavailable', number>[] = [
      () => left('Unavailable'),
      () => right(2),
    ]

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst(tasks)
    })
    const typed: Promise<Exit<ExitError<'Unavailable'>[], number>> =
      resultPromise

    expect(typed).toBe(resultPromise)
    expectRight(await resultPromise, 2)
  })

  it('aborts forkFirst losers with SiblingSettled and awaits cleanup', async () => {
    const winner = deferred<Either<'WinnerFailed', 'winner'>>()
    const cleanup = deferred<void>()
    const events: string[] = []
    const reasons: unknown[] = []
    let resultSettled = false

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async (child) => {
          events.push('loser:start')
          await new Promise<void>((resolve) => {
            child.addEventListener(
              'abort',
              () => {
                reasons.push(child.reason)
                events.push('loser:cleanup:start')
                resolve()
              },
              { once: true },
            )
          })
          await cleanup.promise
          events.push('loser:cleanup:end')
          return left('LoserStopped' as const)
        },
        async () => winner.promise,
      ] as const)
    })
    void resultPromise.then(() => {
      resultSettled = true
    })

    winner.resolve(right('winner'))
    await flushAsyncWork()

    expect(resultSettled).toBe(false)
    expect(events).toEqual(['loser:start', 'loser:cleanup:start'])
    expect(reasons).toEqual([siblingSettled()])

    cleanup.resolve()
    expectRight(await resultPromise, 'winner')
    expect(events).toEqual([
      'loser:start',
      'loser:cleanup:start',
      'loser:cleanup:end',
    ])
  })

  it('returns Rejected when one forkFirst loser rejects during cleanup', async () => {
    const cause = new Error('close failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async (child) => await rejectOnAbort(child, cause),
        () => right('winner' as const),
      ] as const)
    })

    expectLeft(result, { _tag: 'Rejected', cause })
  })

  it('suppresses multiple forkFirst loser cleanup rejections', async () => {
    const first = new Error('first close failed')
    const second = new Error('second close failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async (child) => await rejectOnAbort(child, first),
        async (child) => await rejectOnAbort(child, second),
        () => right('winner' as const),
      ] as const)
    })

    expectLeft(result as Either<unknown, unknown>, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: first },
      suppressed: [{ _tag: 'Rejected', cause: second }],
    })
  })

  it('keeps candidate cleanup failures in their forkFirst error slots', async () => {
    const cause = new Error('nested close failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkFirst([
        async (child) => {
          void child.fork(async (grandchild) =>
            rejectOnAbort(grandchild, cause),
          )
          return left('PrimaryFailed' as const)
        },
        () => left('OtherFailed' as const),
      ] as const)
    })

    expectLeft(result, [
      {
        _tag: 'Suppressed',
        error: 'PrimaryFailed',
        suppressed: [{ _tag: 'Rejected', cause }],
      },
      'OtherFailed',
    ])
  })

  it('returns Left([]) for an empty forkFirst', async () => {
    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.forkFirst([] as const)
    })
    const typed: Promise<Exit<[], never>> = resultPromise

    expect(typed).toBe(resultPromise)
    expectLeft(await resultPromise, [])
  })

  it('fails the scope when an empty forkFirst result is detached', async () => {
    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        void signal.forkFirst([] as const)
        await Promise.resolve()
        return 'unreachable' as const
      },
    )

    expectLeft(result, [])
  })

  it('lets parent abort dominate forkFirst candidates', async () => {
    const controller = new AbortController()
    const reasons: unknown[] = []

    const resultPromise = either(
      controller.signal,
      async function* ({ signal }) {
        return yield* await signal.forkFirst([
          async (child) => {
            const result = await abortAsLeft(child, 'Stopped' as const)
            reasons.push(child.reason)
            return result
          },
          async (child) => {
            const result = await abortAsLeft(child, 'Stopped' as const)
            reasons.push(child.reason)
            return result
          },
        ] as const)
      },
    )

    controller.abort('ParentStopped')

    expectLeft(await resultPromise, {
      _tag: 'Aborted',
      reason: 'ParentStopped',
    })
    expect(reasons).toEqual(['ParentStopped', 'ParentStopped'])
  })

  it('does not start forkFirst work in an already-aborted scope', async () => {
    const controller = new AbortController()
    controller.abort('AlreadyDone')
    let starts = 0

    const result = await either(
      controller.signal,
      async function* ({ signal }) {
        return yield* await signal.forkFirst([
          () => {
            starts++
            return right('started' as const)
          },
        ] as const)
      },
    )

    expect(starts).toBe(0)
    expectLeft(result, { _tag: 'Aborted', reason: 'AlreadyDone' })
  })

  it('lets signal.forkRace return the first Right without poisoning the scope', async () => {
    const events: string[] = []
    const reasons: unknown[] = []

    const result = await either(async function* ({ signal }) {
      const raced = yield* await signal.forkRace([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
          reasons.push(child.reason)
          events.push('slow:aborted')
          return result
        },
        async () => {
          events.push('fast')
          await Promise.resolve()
          return right('fast' as const)
        },
      ] as const)

      const after = yield* right('after' as const)
      return [raced, after] as const
    })

    expectRight(result, ['fast', 'after'])
    expect(events).toEqual(['slow:start', 'fast', 'slow:aborted'])
    expect(reasons).toEqual([siblingSettled()])
  })

  it('returns Rejected when a forkRace loser rejects during abort cleanup', async () => {
    const cause = new Error('close failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkRace([
        async (child) => await rejectOnAbort(child, cause),
        () => right('winner' as const),
      ] as const)
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error).toEqual({ _tag: 'Rejected', cause })
  })

  it('lets signal.forkRace return the first Left and cancel losers', async () => {
    const events: string[] = []
    const reasons: unknown[] = []

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkRace([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
          reasons.push(child.reason)
          events.push('slow:aborted')
          return result
        },
        async () => {
          events.push('fail')
          await Promise.resolve()
          return left('RaceFailed' as const)
        },
      ] as const)
    })

    expectLeft(result as Either<unknown, unknown>, 'RaceFailed')
    expect(events).toEqual(['slow:start', 'fail', 'slow:aborted'])
    expect(reasons).toEqual(['RaceFailed'])
  })

  it('suppresses abort cleanup rejection under the primary forkAll failure', async () => {
    const cause = new Error('rollback failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.forkAll([
        async (child) => await rejectOnAbort(child, cause),
        () => left('PrimaryFailed' as const),
      ] as const)
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error).toEqual({
      _tag: 'Suppressed',
      error: 'PrimaryFailed',
      suppressed: [{ _tag: 'Rejected', cause }],
    })
  })

  it('returns Rejected for an empty signal.forkRace', async () => {
    const result = await either(async function* ({ signal }) {
      yield* await signal.forkRace([] as const)
      return 'done' as const
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    const error = result.error as Rejected
    expect(error._tag).toBe('Rejected')
    expect(error.cause).toBeInstanceOf(TypeError)
    expect((error.cause as Error).message).toBe(
      'signal.forkRace() requires at least one task',
    )
  })

  it('runs forkEach lazily with bounded concurrency and settlement-order completions', async () => {
    const tasks = [
      deferred<Either<'Failed', string>>(),
      deferred<Either<'Failed', string>>(),
      deferred<Either<'Failed', string>>(),
    ]
    const started: number[] = []
    const completions: { index: number; value: string }[] = []

    const resultPromise = either(async function* ({ signal }) {
      const iterator = signal.forkEach(
        ['zero', 'one', 'two'],
        { concurrency: 2 },
        async (_item, _child, index) => {
          started.push(index)
          return tasks[index]!.promise
        },
      )
      const typed: ForkEachIterator<string, 'Failed', string> = iterator

      expect(started).toEqual([])
      for await (const completion of typed) {
        const completionResult: Exit<'Failed', string> = completion.result
        const value = yield* completionResult
        completions.push({ index: completion.index, value })
      }
      return completions
    })

    await flushAsyncWork()
    expect(started).toEqual([0, 1])

    tasks[1]!.resolve(right('second'))
    await flushAsyncWork()
    expect(started).toEqual([0, 1, 2])
    tasks[2]!.resolve(right('third'))
    await flushAsyncWork()
    tasks[0]!.resolve(right('first'))

    expectRight(await resultPromise, [
      { index: 1, value: 'second' },
      { index: 2, value: 'third' },
      { index: 0, value: 'first' },
    ])
  })

  it('supports async sources and keeps active tasks plus queued completions bounded', async () => {
    const releases = Array.from({ length: 4 }, () =>
      deferred<Either<never, number>>(),
    )
    const bodyGate = deferred<void>()
    let pulls = 0
    let active = 0
    let peak = 0

    async function* source() {
      for (let index = 0; index < releases.length; index++) {
        pulls++
        yield index
      }
    }

    const resultPromise = either(async function* ({ signal }) {
      const seen: number[] = []
      for await (const completion of signal.forkEach(
        source(),
        { concurrency: 2 },
        async (_item, _child, index) => {
          active++
          peak = Math.max(peak, active)
          const result = await releases[index]!.promise
          active--
          return result
        },
      )) {
        seen.push(yield* completion.result)
        if (seen.length === 1) await bodyGate.promise
      }
      return seen
    })

    await flushAsyncWork()
    expect(pulls).toBe(2)
    releases[0]!.resolve(right(0))
    await flushAsyncWork()
    expect(pulls).toBe(3)
    releases[1]!.resolve(right(1))
    await flushAsyncWork()
    expect(pulls).toBe(3)
    expect(peak).toBe(2)

    bodyGate.resolve()
    await flushAsyncWork()
    expect(pulls).toBe(4)
    releases[2]!.resolve(right(2))
    releases[3]!.resolve(right(3))

    expectRight(await resultPromise, [0, 1, 2, 3])
  })

  it('completes an empty forkEach source without invoking the mapper', async () => {
    let mapped = false

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        const completions: unknown[] = []
        for await (const completion of signal.forkEach(
          [] as number[],
          { concurrency: 1 },
          (item) => {
            mapped = true
            return right(item)
          },
        )) {
          completions.push(completion)
        }
        return completions
      },
    )

    expect(mapped).toBe(false)
    expectRight(result, [])
  })

  it('emits domain failures, mapper throws, and mapper rejections as data', async () => {
    const thrown = new Error('mapper threw')
    const rejectedCause = new Error('mapper rejected')
    const seen: Either<unknown, unknown>[] = []

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        for await (const { result } of signal.forkEach(
          [0, 1, 2, 3],
          { concurrency: 4 },
          // oxlint-disable-next-line typescript/promise-function-async
          (item) => {
            if (item === 0) return left('DomainFailure' as const)
            if (item === 1) throw thrown
            if (item === 2) return Promise.reject(rejectedCause)
            return right('ok' as const)
          },
        )) {
          seen.push(result)
        }
        return 'continued' as const
      },
    )

    expectRight(result, 'continued')
    expect(seen).toHaveLength(4)
    expectLeft(seen[0]!, 'DomainFailure')
    expectLeft(seen[1]!, { _tag: 'Rejected', cause: thrown })
    expectRight(seen[2]!, 'ok')
    expectLeft(seen[3]!, { _tag: 'Rejected', cause: rejectedCause })
  })

  it('keeps nested cleanup failure Suppressed inside its forkEach completion', async () => {
    const cleanupCause = new Error('nested cleanup')
    let completionResult: Either<unknown, unknown> | undefined

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        for await (const { result } of signal.forkEach(
          [1],
          { concurrency: 1 },
          async (_item, child) => {
            void child.fork(async (grandchild) =>
              rejectOnAbort(grandchild, cleanupCause),
            )
            return left('TaskFailed' as const)
          },
        )) {
          completionResult = result
        }
        return 'continued' as const
      },
    )

    expectRight(result, 'continued')
    expect(completionResult).toBeDefined()
    if (completionResult === undefined) return
    expectLeft(completionResult, {
      _tag: 'Suppressed',
      error: 'TaskFailed',
      suppressed: [{ _tag: 'Rejected', cause: cleanupCause }],
    })
  })

  it('cancels and awaits forkEach children and closes the source on break', async () => {
    const winner = deferred<Either<never, string>>()
    const cleanup = deferred<void>()
    const abortObserved = deferred<void>()
    const reasons: unknown[] = []
    let sourceReason: unknown
    let sourceReturned = false
    let settled = false
    let index = 0
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: index++ }
          },
          async return(reason?: unknown) {
            sourceReturned = true
            sourceReason = reason
            return { done: true, value: undefined }
          },
        }
      },
    }

    const resultPromise = either(async function* ({ signal }) {
      for await (const completion of signal.forkEach(
        source,
        { concurrency: 2 },
        async (_item, child, taskIndex) => {
          if (taskIndex === 0) return winner.promise
          await new Promise<void>((resolve) => {
            child.addEventListener(
              'abort',
              () => {
                reasons.push(child.reason)
                abortObserved.resolve()
                resolve()
              },
              { once: true },
            )
          })
          await cleanup.promise
          return left('Stopped' as const)
        },
      )) {
        yield* completion.result
        break
      }
      return 'done' as const
    })
    void resultPromise.then(() => {
      settled = true
    })

    await flushAsyncWork()
    winner.resolve(right('winner'))
    await abortObserved.promise
    expect(settled).toBe(false)
    expect(reasons).toEqual([forkEachStopped(), forkEachStopped()])
    expect(sourceReturned).toBe(true)

    cleanup.resolve()
    expectRight(await resultPromise, 'done')
    expect(sourceReturned).toBe(true)
    expect(sourceReason).toBe(forkEachStopped())
  })

  it('lets yield* of a forkEach completion fail fast and stop pending work', async () => {
    const stopped: unknown[] = []

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        for await (const { result } of signal.forkEach(
          [0, 1],
          { concurrency: 2 },
          async (item, child) => {
            if (item === 0) return left('BadItem' as const)
            const value = await abortAsLeft(child, 'Stopped' as const)
            stopped.push(child.reason)
            return value
          },
        )) {
          yield* result
        }
        return 'unreachable' as const
      },
    )

    expectLeft(result, 'BadItem')
    expect(stopped).toEqual([forkEachStopped()])
  })

  it('keeps every cleanup rejection beneath a fail-fast forkEach completion', async () => {
    const primary = deferred<Either<'LiveDemoDetected', never>>()
    const firstCleanup = new Error('rollback failed')
    const secondCleanup = new Error('stream close failed')

    const resultPromise = either(async function* ({ signal }) {
      for await (const { result } of signal.forkEach(
        [0, 1, 2],
        { concurrency: 3 },
        async (_item, child, index) => {
          if (index === 0) return primary.promise
          return await rejectOnAbort(
            child,
            index === 1 ? firstCleanup : secondCleanup,
          )
        },
      )) {
        yield* result
      }
      return 'unreachable' as const
    })

    await flushAsyncWork()
    primary.resolve(left('LiveDemoDetected'))

    expectLeft(await resultPromise, {
      _tag: 'Suppressed',
      error: 'LiveDemoDetected',
      suppressed: [
        { _tag: 'Rejected', cause: firstCleanup },
        { _tag: 'Rejected', cause: secondCleanup },
      ],
    })
  })

  it('does not touch forkEach input in an already-aborted scope', async () => {
    const controller = new AbortController()
    controller.abort('AlreadyStopped')
    let iterated = false
    let mapped = false
    const source: Iterable<number> = {
      [Symbol.iterator]() {
        iterated = true
        return [1][Symbol.iterator]()
      },
    }

    const result = await either(
      controller.signal,
      async function* ({ signal }) {
        for await (const completion of signal.forkEach(
          source,
          { concurrency: 1 },
          (item) => {
            mapped = true
            return right(item)
          },
        )) {
          yield* completion.result
        }
        return 'done' as const
      },
    )

    expect(iterated).toBe(false)
    expect(mapped).toBe(false)
    expectLeft(result, { _tag: 'Aborted', reason: 'AlreadyStopped' })
  })

  it('lets parent abort dominate forkEach and reach children and the source', async () => {
    const controller = new AbortController()
    const started = deferred<void>()
    const reasons: unknown[] = []
    let sourceReason: unknown
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: 1 }
          },
          async return(reason?: unknown) {
            sourceReason = reason
            return { done: true, value: undefined }
          },
        }
      },
    }

    const resultPromise = either(
      controller.signal,
      async function* ({ signal }) {
        for await (const completion of signal.forkEach(
          source,
          { concurrency: 1 },
          async (_item, child) => {
            started.resolve()
            const stopped = await abortAsLeft(child, 'Stopped' as const)
            reasons.push(child.reason)
            return stopped
          },
        )) {
          yield* completion.result
        }
        return 'unreachable' as const
      },
    )

    await started.promise
    controller.abort('ParentStopped')

    expectLeft(await resultPromise, {
      _tag: 'Aborted',
      reason: 'ParentStopped',
    })
    expect(reasons).toEqual(['ParentStopped'])
    expect(sourceReason).toBe('ParentStopped')
  })

  it('recursively cancels nested forks owned by forkEach tasks', async () => {
    const nestedStarted = deferred<void>()
    const nestedReasons: unknown[] = []

    const resultPromise = either(async function* ({ signal }) {
      for await (const completion of signal.forkEach(
        [0, 1],
        { concurrency: 2 },
        async (item, child) => {
          if (item === 0) return right('winner' as const)
          return child.fork(async (grandchild) => {
            nestedStarted.resolve()
            const stopped = await abortAsLeft(
              grandchild,
              'NestedStopped' as const,
            )
            nestedReasons.push(grandchild.reason)
            return stopped
          })
        },
      )) {
        yield* completion.result
        break
      }
      return 'done' as const
    })

    await nestedStarted.promise
    expectRight(await resultPromise, 'done')
    expect(nestedReasons).toEqual([forkEachStopped()])
  })

  it('uses one teardown path for return and await using', async () => {
    const reasons: unknown[] = []

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        await using iterator = signal.forkEach(
          [0, 1],
          { concurrency: 2 },
          async (item, child) => {
            if (item === 0) return right(item)
            const stopped = await abortAsLeft(child, 'Stopped' as const)
            reasons.push(child.reason)
            return stopped
          },
        )

        const first = await iterator.next()
        expect(first.done).toBe(false)
        await iterator.return?.()
        return 'done' as const
      },
    )

    expectRight(result, 'done')
    expect(reasons).toEqual([forkEachStopped()])
  })

  it('turns source failures into Rejected and suppresses ordered teardown failures', async () => {
    const firstCleanup = new Error('first cleanup')
    const secondCleanup = new Error('second cleanup')
    const sourceFailure = new Error('source pull')
    let pull = 0
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (pull++ < 2) return { done: false, value: pull }
            throw sourceFailure
          },
        }
      },
    }

    const result = await either(async function* ({ signal }) {
      for await (const completion of signal.forkEach(
        source,
        { concurrency: 3 },
        async (_item, child, taskIndex) =>
          rejectOnAbort(child, taskIndex === 0 ? firstCleanup : secondCleanup),
      )) {
        yield* completion.result
      }
      return 'unreachable' as const
    })

    expectLeft(result, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: sourceFailure },
      suppressed: [
        { _tag: 'Rejected', cause: firstCleanup },
        { _tag: 'Rejected', cause: secondCleanup },
      ],
    })
  })

  it('orders task cleanup failures before a source-close failure', async () => {
    const winner = deferred<Either<never, number>>()
    const firstTaskCleanup = new Error('first task cleanup')
    const secondTaskCleanup = new Error('second task cleanup')
    const sourceCleanup = new Error('source cleanup')
    let index = 0
    const source: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            return { done: false, value: index++ }
          },
          async return() {
            throw sourceCleanup
          },
        }
      },
    }

    const resultPromise = either(async function* ({ signal }) {
      for await (const completion of signal.forkEach(
        source,
        { concurrency: 2 },
        async (_item, child, taskIndex) =>
          taskIndex === 0
            ? winner.promise
            : rejectOnAbort(
                child,
                taskIndex === 1 ? firstTaskCleanup : secondTaskCleanup,
              ),
      )) {
        yield* completion.result
        break
      }
      return 'unreachable' as const
    })

    await flushAsyncWork()
    winner.resolve(right(0))

    expectLeft(await resultPromise, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: firstTaskCleanup },
      suppressed: [
        { _tag: 'Rejected', cause: secondTaskCleanup },
        { _tag: 'Rejected', cause: sourceCleanup },
      ],
    })
  })

  it('lets one reject-on-stop cleanup failure override a successful break', async () => {
    const winner = deferred<Either<never, number>>()
    const cleanupCause = new Error('cleanup failed')

    const resultPromise = either(async function* ({ signal }) {
      for await (const completion of signal.forkEach(
        [0, 1],
        { concurrency: 1 },
        async (_item, child, index) =>
          index === 0 ? winner.promise : rejectOnAbort(child, cleanupCause),
      )) {
        yield* completion.result
        break
      }
      return 'unreachable' as const
    })

    await flushAsyncWork()
    winner.resolve(right(0))

    expectLeft(await resultPromise, { _tag: 'Rejected', cause: cleanupCause })
  })

  it('validates forkEach concurrency before touching the source', async () => {
    const values = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    let touched = false
    const source: Iterable<number> = {
      [Symbol.iterator]() {
        touched = true
        return [1][Symbol.iterator]()
      },
    }

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        for (const concurrency of values) {
          expect(() =>
            signal.forkEach(source, { concurrency }, (item) => right(item)),
          ).toThrow(
            'signal.forkEach() concurrency must be a positive safe integer',
          )
        }
        return 'done' as const
      },
    )

    expectRight(result, 'done')
    expect(touched).toBe(false)
  })

  it('recursively aborts forks created inside forked tasks', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      const parent = signal.fork(async (child) => {
        events.push('parent:start')

        void child.fork(async (grandchild) => {
          events.push('grandchild:start')
          const result = await abortAsLeft(
            grandchild,
            'GrandchildAborted' as const,
          )
          events.push('grandchild:aborted')
          return result
        })

        return left('ParentFailed' as const)
      })

      yield* await parent
      return 'done' as const
    })

    expectLeft(result as Either<unknown, unknown>, 'ParentFailed')
    expect(events).toEqual([
      'parent:start',
      'grandchild:start',
      'grandchild:aborted',
    ])
  })

  it('does not start forked work when the scope is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('AlreadyDone')
    let started = false

    const result = await either(
      controller.signal,
      async function* ({ signal }) {
        const child = signal.fork(() => {
          started = true
          return right('started' as const)
        })

        return yield* await child
      },
    )

    expect(started).toBe(false)
    expectLeft(result, { _tag: 'Aborted', reason: 'AlreadyDone' })
  })

  it('does not start forked work after the running scope aborts', async () => {
    const controller = new AbortController()
    let started = false

    const result = await either(
      controller.signal,
      async function* ({ signal }) {
        controller.abort('Stopped')
        const child = signal.fork(() => {
          started = true
          return right('started' as const)
        })

        return yield* await child
      },
    )

    expect(started).toBe(false)
    expectLeft(result, { _tag: 'Aborted', reason: 'Stopped' })
  })

  it('captures rejected forked tasks and cancels siblings', async () => {
    const cause = new Error('fork exploded')
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      const slow = signal.fork(async (child) => {
        events.push('slow:start')
        const result = await abortAsLeft(child, 'SlowAborted' as const)
        events.push('slow:aborted')
        return result
      })

      void signal.fork(async () => {
        await Promise.resolve()
        throw cause
      })

      yield* await slow
      return 'done' as const
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    const error = result.error as Rejected
    expect(error._tag).toBe('Rejected')
    expect(error.cause).toBe(cause)
    expect(events).toEqual(['slow:start', 'slow:aborted'])
  })

  it('waits for outstanding forked tasks to close on normal return', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      void signal.fork(async (child) => {
        events.push('child:start')
        const result = await abortAsLeft(child, 'ScopeClosed' as const)
        events.push('child:closed')
        return result
      })

      yield* right(undefined)
      return 'done' as const
    })

    expectRight(result, 'done')
    expect(events).toEqual(['child:start', 'child:closed'])
  })

  it('passes an enriched child signal for abortable either scopes', async () => {
    const controller = new AbortController()
    let injected: AbortSignal | undefined
    let secondArg: AbortSignal | undefined

    const result = await either(
      controller.signal,
      // oxlint-disable-next-line require-yield
      async function* ({ signal }, second) {
        injected = signal
        secondArg = second
        return 'ok' as const
      },
    )

    expectRight(result, 'ok')
    expect(injected).toBe(secondArg)
    expect(injected).not.toBe(controller.signal)
    expect(injected).toBeInstanceOf(AbortSignal)
    expect(typeof (injected as { fork?: unknown } | undefined)?.fork).toBe(
      'function',
    )
  })

  it('lets a parent abort cancel forked child work', async () => {
    const controller = new AbortController()

    const resultPromise = either(
      controller.signal,
      async function* ({ signal }) {
        const child = signal.fork(async (childSignal) =>
          abortAsLeft(childSignal, 'ChildAborted' as const),
        )

        controller.abort('Stop')
        yield* await child
        return 'done' as const
      },
    )

    const result = await resultPromise

    expectLeft(result, { _tag: 'Aborted', reason: 'Stop' })
  })

  it('does not enable signal.fork inside sync either', () => {
    expect(() =>
      either(function* ({ signal }) {
        void signal.fork(() => right(1))
        return yield* right(1)
      }),
    ).toThrow('signal.fork() is only available in async either')
  })

  it('does not enable scoped batch methods inside sync either', () => {
    expect(() =>
      either(function* ({ signal }) {
        void signal.forkAll([])
        return yield* right(1)
      }),
    ).toThrow('signal.forkAll() is only available in async either')

    expect(() =>
      either(function* ({ signal }) {
        void signal.forkFirst([])
        return yield* right(1)
      }),
    ).toThrow('signal.forkFirst() is only available in async either')

    expect(() =>
      either(function* ({ signal }) {
        void signal.forkRace([])
        return yield* right(1)
      }),
    ).toThrow('signal.forkRace() is only available in async either')

    expect(() =>
      either(function* ({ signal }) {
        void signal.forkEach([], { concurrency: 1 }, (item) => right(item))
        return yield* right(1)
      }),
    ).toThrow('signal.forkEach() is only available in async either')
  })
})

describe('signal.acquire', () => {
  it('starts lazily, passes the owning signal, and returns the raw resource', async () => {
    const events: string[] = []
    let started = 0

    const resultPromise = either(async function* ({ signal }) {
      const acquisition = signal.acquire(
        async (received) => {
          started++
          expect(received).toBe(signal)
          return right({ id: 'conn' as const })
        },
        (resource) => {
          events.push(`release ${resource.id}`)
        },
      )

      expect(started).toBe(0)
      const resource = yield* acquisition
      expect(started).toBe(1)
      events.push(`use ${resource.id}`)
      return resource.id
    })
    const typed: Promise<Either<ExitError<never>, 'conn'>> = resultPromise

    expect(typed).toBe(resultPromise)
    expectRight(await resultPromise, 'conn')
    expect(events).toEqual(['use conn', 'release conn'])
  })

  it('flattens Either failures and captures factory throws and rejections', async () => {
    const domain = await either(async function* ({ signal }) {
      return yield* signal.acquire(
        () => left('OpenFailed' as const),
        () => {},
      )
    })
    const thrownCause = new Error('factory threw')
    const thrown = await either(async function* ({ signal }) {
      return yield* signal.acquire(
        () => {
          throw thrownCause
        },
        () => {},
      )
    })
    const rejectedCause = new Error('factory rejected')
    const rejectedResult = await either(async function* ({ signal }) {
      return yield* signal.acquire(
        async () => {
          throw rejectedCause
        },
        () => {},
      )
    })

    expectLeft(domain, 'OpenFailed')
    expectLeft(thrown, { _tag: 'Rejected', cause: thrownCause })
    expectLeft(rejectedResult, { _tag: 'Rejected', cause: rejectedCause })
  })

  it('supports safely destructured acquire methods', async () => {
    const events: string[] = []

    // oxlint-disable-next-line typescript/unbound-method
    const result = await either(async function* ({ signal: { acquire } }) {
      const resource = yield* acquire(
        () => ({ name: 'destructured' as const }),
        ({ name }) => {
          events.push(`release ${name}`)
        },
      )
      events.push(`use ${resource.name}`)
      return resource.name
    })

    expectRight(result, 'destructured')
    expect(events).toEqual(['use destructured', 'release destructured'])
  })

  it('uses native sync and async disposal protocols without a releaser', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      const sync = yield* signal.acquire(() => disposable('sync', events))
      const asyncResource = yield* signal.acquire(() =>
        asyncDisposable('async', events),
      )
      events.push(`use ${sync.name}`)
      events.push(`use ${asyncResource.name}`)
      return 'done' as const
    })

    expectRight(result, 'done')
    expect(events).toEqual([
      'use sync',
      'use async',
      'dispose async:start',
      'dispose async:end',
      'dispose sync',
    ])
  })

  it('disposes custom resources exactly once in LIFO order on success and Left', async () => {
    const events: string[] = []

    const success = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'outer',
        (name) => {
          events.push(`success ${name}`)
        },
      )
      yield* signal.acquire(
        () => 'inner',
        (name) => {
          events.push(`success ${name}`)
        },
      )
      return 'ok' as const
    })

    const failure = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'outer',
        (name) => {
          events.push(`failure ${name}`)
        },
      )
      yield* signal.acquire(
        () => 'inner',
        (name) => {
          events.push(`failure ${name}`)
        },
      )
      return left('Stop' as const)
    })

    expectRight(success, 'ok')
    expectLeft(failure, 'Stop')
    expect(events).toEqual([
      'success inner',
      'success outer',
      'failure inner',
      'failure outer',
    ])
  })

  it('turns cleanup failures into Rejected and Suppressed Exit data', async () => {
    const outerError = new Error('outer release failed')
    const innerError = new Error('inner release failed')

    const one = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'resource',
        () => {
          throw outerError
        },
      )
      return 'ok' as const
    })

    const several = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'outer',
        () => {
          throw outerError
        },
      )
      yield* signal.acquire(
        () => 'inner',
        async () => {
          await Promise.resolve()
          throw innerError
        },
      )
      return 'ok' as const
    })

    expectLeft(one, { _tag: 'Rejected', cause: outerError })
    expectLeft(several, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: outerError },
      suppressed: [{ _tag: 'Rejected', cause: innerError }],
    })
  })

  it('keeps a domain Left primary when resource cleanup fails', async () => {
    const releaseError = new Error('release failed')

    const result = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'resource',
        () => {
          throw releaseError
        },
      )
      return left('Stop' as const)
    })

    expectLeft(result as Either<unknown, unknown>, {
      _tag: 'Suppressed',
      error: 'Stop',
      suppressed: [{ _tag: 'Rejected', cause: releaseError }],
    })
  })

  it('uses native SuppressedError when the body and resource cleanup throw', async () => {
    const bodyError = new Error('body failed')
    const releaseError = new Error('release failed')

    let thrown: unknown
    try {
      await either(async function* ({ signal }) {
        yield* signal.acquire(
          () => 'resource',
          () => {
            throw releaseError
          },
        )
        throw bodyError
      })
    } catch (cause) {
      thrown = cause
    }

    expectSuppressedError(thrown, releaseError, bodyError)
  })

  it('does not expose a resource that resolves after parent abort', async () => {
    const controller = new AbortController()
    const opened = deferred<string>()
    const events: string[] = []
    let acquisitionSignal: ScopeSignal | undefined

    const resultPromise = either(
      controller.signal,
      async function* (_raise, signal) {
        const resource = yield* signal.acquire(
          async (received) => {
            acquisitionSignal = received
            return await opened.promise
          },
          (value) => {
            events.push(`release ${value}`)
          },
        )
        events.push(`use ${resource}`)
        return resource
      },
    )

    await flushAsyncWork()
    expect(acquisitionSignal?.aborted).toBe(false)
    controller.abort('Stop')
    await flushAsyncWork()
    expect(events).toEqual([])

    opened.resolve('late')
    const result = await resultPromise

    expectLeft(result, { _tag: 'Aborted', reason: 'Stop' })
    expect(events).toEqual(['release late'])
  })

  it('suppresses a late acquisition rejection beneath parent abort', async () => {
    const controller = new AbortController()
    const opened = deferred<string>()
    const cause = new Error('late open failed')

    const resultPromise = either(
      controller.signal,
      async function* (_raise, signal) {
        return yield* signal.acquire(
          async () => await opened.promise,
          () => {},
        )
      },
    )

    await flushAsyncWork()
    controller.abort('Stop')
    opened.reject(cause)

    expectLeft(await resultPromise, {
      _tag: 'Suppressed',
      error: { _tag: 'Aborted', reason: 'Stop' },
      suppressed: [{ _tag: 'Rejected', cause }],
    })
  })

  it('does not invoke an acquisition factory in an already-aborted scope', async () => {
    const controller = new AbortController()
    let started = false
    controller.abort('AlreadyDone')

    const result = await either(
      controller.signal,
      async function* (_raise, signal) {
        return yield* signal.acquire(() => {
          started = true
          return disposable('never', [])
        })
      },
    )

    expectLeft(result, { _tag: 'Aborted', reason: 'AlreadyDone' })
    expect(started).toBe(false)
  })

  it('cancels sibling work with an acquisition domain failure', async () => {
    const started = deferred<void>()
    const reasons: unknown[] = []

    const result = await either(async function* ({ signal }) {
      void signal.fork(async (child) => {
        started.resolve()
        const stopped = await abortAsLeft(child, 'ChildStopped' as const)
        reasons.push(child.reason)
        return stopped
      })
      await started.promise

      return yield* signal.acquire(
        () => left('OpenFailed' as const),
        () => {},
      )
    })

    expectLeft(result as Either<unknown, unknown>, 'OpenFailed')
    expect(reasons).toEqual(['OpenFailed'])
  })

  it('awaits children before disposing parent resources', async () => {
    const events: string[] = []
    const started = deferred<void>()
    let parentDisposed = false

    const result = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'parent',
        () => {
          parentDisposed = true
          events.push('release parent')
        },
      )
      void signal.fork(async (child) => {
        started.resolve()
        const stopped = await abortAsLeft(child, 'ChildStopped' as const)
        events.push(`child saw disposed=${parentDisposed}`)
        return stopped
      })
      await started.promise
      return 'done' as const
    })

    expectRight(result, 'done')
    expect(events).toEqual(['child saw disposed=false', 'release parent'])
  })

  it('keeps nested scope resources independent', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'parent',
        (name) => {
          events.push(`release ${name}`)
        },
      )

      const child = yield* await signal.fork(
        async (childSignal) =>
          await either(childSignal, async function* (_raise, nested) {
            const resource = yield* nested.acquire(
              () => 'child',
              (name) => {
                events.push(`release ${name}`)
              },
            )
            events.push(`use ${resource}`)
            return resource
          }),
      )
      events.push(`joined ${child}`)
      return child
    })

    expectRight(result, 'child')
    expect(events).toEqual([
      'use child',
      'release child',
      'joined child',
      'release parent',
    ])
  })

  it('orders child cleanup failure before parent resource cleanup failure', async () => {
    const childError = new Error('child cleanup failed')
    const resourceError = new Error('resource cleanup failed')
    const started = deferred<void>()

    const result = await either(async function* ({ signal }) {
      yield* signal.acquire(
        () => 'parent',
        () => {
          throw resourceError
        },
      )
      void signal.fork(async (child) => {
        started.resolve()
        return await rejectOnAbort(child, childError)
      })
      await started.promise
      return 'done' as const
    })

    expectLeft(result, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: childError },
      suppressed: [{ _tag: 'Rejected', cause: resourceError }],
    })
  })

  it('suppresses resource cleanup beneath a throwing scoped child task', async () => {
    const taskError = new Error('task failed')
    const resourceError = new Error('child resource cleanup failed')

    const result = await either(async function* ({ signal }) {
      return yield* await signal.fork(async (child) => {
        const acquired = child.acquire(
          () => 'child resource',
          () => {
            throw resourceError
          },
        )
        const step = await acquired.next()
        expect(step).toEqual({ done: true, value: 'child resource' })
        throw taskError
      })
    })

    expectLeft(result, {
      _tag: 'Suppressed',
      error: { _tag: 'Rejected', cause: taskError },
      suppressed: [{ _tag: 'Rejected', cause: resourceError }],
    })
  })

  it('preserves root throws and detached child cleanup failures', async () => {
    const bodyError = new Error('body failed')
    const childError = new Error('child cleanup failed')
    const started = deferred<void>()

    let thrown: unknown
    try {
      // oxlint-disable-next-line require-yield
      await either(async function* ({ signal }) {
        void signal.fork(async (child) => {
          started.resolve()
          return await rejectOnAbort(child, childError)
        })
        await started.promise
        throw bodyError
      })
    } catch (cause) {
      thrown = cause
    }

    expectSuppressedError(thrown, childError, bodyError)
  })

  it('invokes the factory once under concurrent iterator consumption', async () => {
    let calls = 0

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        const acquisition = signal.acquire(async () => {
          calls++
          await Promise.resolve()
          return disposable('shared', [])
        })
        const [first, second] = await Promise.all([
          acquisition.next(),
          acquisition.next(),
        ])

        expect(first).toMatchObject({ done: true })
        expect(second).toEqual({ done: true, value: undefined })
        return calls
      },
    )

    expectRight(result, 1)
    expect(calls).toBe(1)
  })

  it('cannot resurrect an acquisition closed before its first step', async () => {
    let calls = 0

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ signal }) {
        const acquisition = signal.acquire(() => {
          calls++
          return disposable('never', [])
        })

        expect(await acquisition.return?.()).toEqual({
          done: true,
          value: undefined,
        })
        expect(await acquisition.next()).toEqual({
          done: true,
          value: undefined,
        })
        return 'closed' as const
      },
    )

    expectRight(result, 'closed')
    expect(calls).toBe(0)
  })

  it('returns Rejected for a non-disposable value without a releaser in JavaScript', async () => {
    const result = await either(async function* ({ signal }) {
      // oxlint-disable-next-line typescript/unbound-method
      const acquire = signal.acquire as unknown as (
        factory: () => object,
      ) => AsyncIterableIterator<Left<Rejected>, object, unknown>
      return yield* acquire(() => ({}))
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBeInstanceOf(TypeError)
  })

  it('infers factory domain errors and requires cleanup for plain values', () => {
    const typed = either(async function* ({ signal }) {
      const resource = yield* signal.acquire(
        async () =>
          Math.random() > 0.5
            ? left('OpenFailed' as const)
            : right({ id: 'typed' as const }),
        () => {},
      )
      return resource.id
    })
    const expected: Promise<Either<ExitError<'OpenFailed'>, 'typed'>> = typed

    const invalid = async () =>
      await either(async function* ({ signal }) {
        // @ts-expect-error Plain resources require an explicit releaser.
        return yield* signal.acquire(() => ({ id: 'plain' }))
      })
    const invalidSync = () =>
      either(function* ({ signal }) {
        // @ts-expect-error Acquisition effects are async-only.
        // oxlint-disable-next-line typescript/no-unsafe-return
        return yield* signal.acquire(() => disposable('sync', []))
      })

    expect(expected).toBe(typed)
    expect(typeof invalid).toBe('function')
    expect(typeof invalidSync).toBe('function')
  })

  it('rejects invalid releasers before starting the factory', async () => {
    let started = false

    const resultPromise = either(async function* ({ signal }) {
      // oxlint-disable-next-line typescript/unbound-method
      const acquire = signal.acquire as unknown as (
        factory: () => unknown,
        release: unknown,
      ) => AsyncIterableIterator<Left<never>, never, unknown>
      yield* acquire(() => {
        started = true
        return {}
      }, 42)
      return 'unreachable'
    })

    await expect(resultPromise).rejects.toThrow(
      'signal.acquire() release must be a function',
    )
    expect(started).toBe(false)
  })
})

describe('either cleanup and thrown errors', () => {
  it('runs finally when a sync Either short-circuits', () => {
    const events: string[] = []

    const result = either(function* () {
      try {
        events.push('enter')
        yield* left('Stop' as const)
      } finally {
        events.push('finally')
      }
    })

    expectLeft(result, 'Stop')
    expect(events).toEqual(['enter', 'finally'])
  })

  it('runs finally when an async Either short-circuits', async () => {
    const events: string[] = []

    const result = await either(async function* () {
      try {
        events.push('enter')
        yield* left('Stop' as const)
      } finally {
        events.push('finally:start')
        await Promise.resolve()
        events.push('finally:end')
      }
    })

    expectLeft(result, 'Stop')
    expect(events).toEqual(['enter', 'finally:start', 'finally:end'])
  })

  it('propagates thrown errors and still runs finally', () => {
    const cause = new Error('boom after yield')
    const events: string[] = []

    let thrown: unknown
    try {
      either(function* () {
        try {
          events.push('enter')
          yield* right(1)
          events.push('after-yield')
          throw cause
        } finally {
          events.push('finally')
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(cause)
    expect(events).toEqual(['enter', 'after-yield', 'finally'])
  })

  it('propagates errors thrown before the first yield and still runs finally', () => {
    const cause = new Error('boom before yield')
    const events: string[] = []
    const shouldThrow = () => true

    let thrown: unknown
    try {
      either(function* () {
        try {
          events.push('enter')
          if (shouldThrow()) throw cause
          yield* right(1)
        } finally {
          events.push('finally')
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(cause)
    expect(events).toEqual(['enter', 'finally'])
  })

  it('lets finally errors override a sync short-circuit', () => {
    const cause = new Error('finally exploded')
    const events: string[] = []

    let thrown: unknown
    try {
      either(function* () {
        try {
          events.push('enter')
          yield* left('Stop' as const)
        } finally {
          events.push('finally')
          // oxlint-disable-next-line no-unsafe-finally
          throw cause
        }
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBe(cause)
    expect(events).toEqual(['enter', 'finally'])
  })

  it('disposes sync using resources on success, short-circuit, and throw', () => {
    const events: string[] = []

    const success = either(function* () {
      using resource = disposable('success', events)
      events.push(resource.name)
      return yield* right(1)
    })

    const shortCircuit = either(function* () {
      using resource = disposable('short', events)
      events.push(resource.name)
      return yield* left('Stop' as const)
    })

    const cause = new Error('using throw')
    let thrown: unknown
    try {
      either(function* () {
        using resource = disposable('throw', events)
        events.push(resource.name)
        yield* right(undefined)
        throw cause
      })
    } catch (error) {
      thrown = error
    }

    expectRight(success, 1)
    expectLeft(shortCircuit, 'Stop')
    expect(thrown).toBe(cause)
    expect(events).toEqual([
      'success',
      'dispose success',
      'short',
      'dispose short',
      'throw',
      'dispose throw',
    ])
  })

  it('awaits async disposal on await using resources', async () => {
    const events: string[] = []

    const success = await either(async function* () {
      await using resource = asyncDisposable('success', events)
      events.push(resource.name)
      return yield* right(1)
    })

    const shortCircuit = await either(async function* () {
      await using resource = asyncDisposable('short', events)
      events.push(resource.name)
      return yield* left('Stop' as const)
    })

    const cause = new Error('await using throw')
    let thrown: unknown
    try {
      await either(async function* () {
        await using resource = asyncDisposable('throw', events)
        events.push(resource.name)
        yield* right(undefined)
        throw cause
      })
    } catch (error) {
      thrown = error
    }

    expectRight(success, 1)
    expectLeft(shortCircuit, 'Stop')
    expect(thrown).toBe(cause)
    expect(events).toEqual([
      'success',
      'dispose success:start',
      'dispose success:end',
      'short',
      'dispose short:start',
      'dispose short:end',
      'throw',
      'dispose throw:start',
      'dispose throw:end',
    ])
  })

  it('preserves SuppressedError chains when multiple await using disposers throw after a plain Left', async () => {
    const events: string[] = []
    const outerError = new Error('outer dispose failed')
    const innerError = new Error('inner dispose failed')

    let thrown: unknown
    try {
      await either(async function* () {
        await using outer = throwingAsyncDisposable('outer', events, outerError)
        await using inner = throwingAsyncDisposable('inner', events, innerError)

        events.push(outer.name)
        events.push(inner.name)
        yield* left('Stop' as const)
      })
    } catch (error) {
      thrown = error
    }

    expectSuppressedError(thrown, outerError, innerError)
    expect(events).toEqual(['outer', 'inner', 'dispose inner', 'dispose outer'])
  })
})

describe('either cancellation', () => {
  it('returns Right when the signal never aborts', async () => {
    const controller = new AbortController()

    const result = await either(controller.signal, async function* () {
      expect(controller.signal.aborted).toBe(false)
      return yield* right(1)
    })

    expectRight(result, 1)
  })

  it('returns Left<Aborted> without entering the generator when already aborted', async () => {
    const controller = new AbortController()
    const events: string[] = []
    controller.abort('AlreadyDone')

    const result = await either(controller.signal, async function* () {
      events.push('enter')
      return yield* right(1)
    })
    const typed: Either<Aborted, number> = result

    expect(typed).toBe(result)
    expectLeft(result, { _tag: 'Aborted', reason: 'AlreadyDone' })
    expect(events).toEqual([])
  })

  it('uses the default AbortError DOMException when abort has no reason', async () => {
    const controller = new AbortController()

    const resultPromise = either(controller.signal, async function* () {
      yield* await abortAsLeft(controller.signal, 'InnerAbort' as const)
      return 'done' as const
    })

    await Promise.resolve()
    controller.abort()
    const result = await resultPromise

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    const error = result.error as Aborted
    expect(error._tag).toBe('Aborted')
    expect(error.reason).toBeInstanceOf(DOMException)
    expect((error.reason as DOMException).name).toBe('AbortError')
  })

  it('closes and disposes when a cooperating operation observes abort', async () => {
    const controller = new AbortController()
    const events: string[] = []

    const resultPromise = either(controller.signal, async function* () {
      await using resource = asyncDisposable('conn', events)
      events.push(resource.name)
      yield* await abortAsLeft(controller.signal, 'InnerAbort' as const)
      events.push('after abort')
      return 'done' as const
    })

    await Promise.resolve()
    controller.abort('Stop')
    const result = await resultPromise

    expectLeft(result, { _tag: 'Aborted', reason: 'Stop' })
    expect(events).toEqual(['conn', 'dispose conn:start', 'dispose conn:end'])
  })

  it('disposes a resource acquired before the first yield when the signal aborts there', async () => {
    const controller = new AbortController()
    const events: string[] = []

    const resultPromise = either(controller.signal, async function* () {
      await using resource = asyncDisposable('pre-yield', events)
      events.push(resource.name)
      controller.abort('Stop')
      yield* await abortAsLeft(controller.signal, 'InnerAbort' as const)
      events.push('after abort')
      return 'done' as const
    })

    const result = await resultPromise

    expectLeft(result, { _tag: 'Aborted', reason: 'Stop' })
    expect(events).toEqual([
      'pre-yield',
      'dispose pre-yield:start',
      'dispose pre-yield:end',
    ])
  })

  it('rejects when a disposer throws during abort unwind', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const disposeError = new Error('dispose failed')

    const resultPromise = either(controller.signal, async function* () {
      await using resource = throwingAsyncDisposable(
        'conn',
        events,
        disposeError,
      )
      events.push(resource.name)
      yield* await abortAsLeft(controller.signal, 'InnerAbort' as const)
      return 'done' as const
    })

    await Promise.resolve()
    controller.abort('Stop')

    await expect(resultPromise).rejects.toBe(disposeError)
    expect(events).toEqual(['conn', 'dispose conn'])
  })

  it('preserves SuppressedError chains when multiple await using disposers throw during abort unwind', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const outerError = new Error('outer dispose failed')
    const innerError = new Error('inner dispose failed')

    const resultPromise = either(controller.signal, async function* () {
      await using outer = throwingAsyncDisposable('outer', events, outerError)
      await using inner = throwingAsyncDisposable('inner', events, innerError)

      events.push(outer.name)
      events.push(inner.name)
      yield* await abortAsLeft(controller.signal, 'InnerAbort' as const)
      return 'done' as const
    })

    await Promise.resolve()
    controller.abort('Stop')

    let thrown: unknown
    try {
      await resultPromise
    } catch (error) {
      thrown = error
    }

    expectSuppressedError(thrown, outerError, innerError)
    expect(events).toEqual(['outer', 'inner', 'dispose inner', 'dispose outer'])
  })

  it('waits to unwind when the in-flight operation ignores the signal', async () => {
    const controller = new AbortController()
    const events: string[] = []
    const ignored = deferred<Either<'LateLeft', never>>()
    let settled = false

    const resultPromise = either(controller.signal, async function* () {
      await using resource = asyncDisposable('ignored', events)
      events.push(resource.name)
      yield* await ignored.promise
      events.push('after ignored')
      return 'done' as const
    })
    void resultPromise.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(events).toEqual(['ignored'])

    controller.abort('Stop')
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(events).toEqual(['ignored'])

    ignored.resolve(left('LateLeft' as const))
    const result = await resultPromise

    expectLeft(result, { _tag: 'Aborted', reason: 'Stop' })
    expect(events).toEqual([
      'ignored',
      'dispose ignored:start',
      'dispose ignored:end',
    ])
  })
})

describe('all', () => {
  it('returns Right with a tuple when every sync Either is Right', () => {
    const result = all([right(1), right('two'), right(true)])
    const typed: Either<never, [number, string, boolean]> = result

    expect(typed).toBe(result)
    expectRight(result, [1, 'two', true])
  })

  it('returns Right with an empty tuple when given no inputs', () => {
    const result = all([])

    expectRight(result, [])
  })

  it('returns the first sync Left by input order', () => {
    const result = all([
      right(1),
      left('first' as const),
      left('second' as const),
    ])

    expectLeft(result, 'first')
  })

  it('runs promise inputs concurrently and preserves tuple order', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()
    const resultPromise = all([first.promise, second.promise])

    second.resolve(right('two'))
    first.resolve(right(1))

    const result = await resultPromise

    expectRight(result, [1, 'two'])
  })

  it('returns the first async Left by input order, not resolution order', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()
    const resultPromise = all([first.promise, second.promise])

    second.resolve(left('SecondFailed' as const))
    first.resolve(left('FirstFailed' as const))

    const result = await resultPromise

    expectLeft(result, 'FirstFailed')
  })

  it('handles mixed promises, eithers, and thunks', async () => {
    const resultPromise = all([
      right(1),
      Promise.resolve(right('two')),
      () => right(true),
    ])
    const typed: Promise<Either<Rejected, [number, string, boolean]>> =
      resultPromise

    expect(typed).toBe(resultPromise)
    const result = await resultPromise

    expectRight(result, [1, 'two', true])
  })

  it('captures promise rejections as Rejected Left values', async () => {
    const cause = new Error('Promise failed')
    const rejectedInput: Promise<Either<never, string>> = Promise.reject(cause)

    const result = await all([right(1), rejectedInput])

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBe(cause)
  })

  it('captures synchronous throws from thunks as Rejected Left values', () => {
    const cause = new Error('Thunk failed')
    const fail = (): Either<never, never> => {
      throw cause
    }
    const result = all([right(1), fail, right(3)])

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBe(cause)
  })

  it('captures rejected promises returned from thunks', async () => {
    const cause = new Error('Thunk promise failed')
    const fail = async (): Promise<Either<never, string>> => {
      throw cause
    }
    const result = await all([right(1), fail])

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    expect(result.error._tag).toBe('Rejected')
    expect(result.error.cause).toBe(cause)
  })

  it('invokes thunk inputs before awaiting async results', async () => {
    const calls: string[] = []
    const first = deferred<Either<never, number>>()
    const resultPromise = all([
      async () => {
        calls.push('first')
        return first.promise
      },
      () => {
        calls.push('second')
        return right('two')
      },
    ])

    expect(calls).toEqual(['first', 'second'])

    first.resolve(right(1))
    const result = await resultPromise

    expectRight(result, [1, 'two'])
  })
})

describe('collectAll', () => {
  it('partitions sync Eithers without short-circuiting', () => {
    const result = collectAll([
      right(1),
      left('first' as const),
      right(2),
      left('second' as const),
    ])

    expect(result.values).toEqual([1, 2])
    expect(result.errors).toEqual(['first', 'second'])
  })

  it('partitions async results and captures thrown or rejected failures', async () => {
    const rejectedCause = new Error('Promise failed')
    const thrownCause = new Error('Thunk failed')
    const rejectedInput: Promise<Either<never, number>> =
      Promise.reject(rejectedCause)

    const result = await collectAll([
      Promise.resolve(right(1)),
      left('plain-error' as const),
      rejectedInput,
      () => {
        throw thrownCause
      },
      async () => right(2),
    ])

    expect(result.values).toEqual([1, 2])
    expect(result.errors).toHaveLength(3)
    expect(result.errors[0]).toBe('plain-error')
    expect(result.errors[1]).toEqual({
      _tag: 'Rejected',
      cause: rejectedCause,
    })
    expect(result.errors[2]).toEqual({
      _tag: 'Rejected',
      cause: thrownCause,
    })
  })
})

describe('raise.capture', () => {
  it('preserves an existing Either by identity through raise.capture', () => {
    const cached = left('CacheMiss' as const)

    const result = either(
      // oxlint-disable-next-line require-yield
      function* (raise) {
        const attempt = raise.capture(cached)
        expect(attempt).toBe(cached)
        return attempt._tag === 'Left' ? 'fallback' : attempt.value
      },
    )

    expectRight(result, 'fallback')
  })

  it('captures raw and throwing synchronous work without short-circuiting', () => {
    const cause = new Error('Cache unavailable')

    const result = either(
      // oxlint-disable-next-line require-yield
      function* ({ raise }) {
        const hit = raise.capture(() => 42 as const)
        const miss = raise.capture(() => {
          throw cause
        })
        const typedHit: Either<Rejected, 42> = hit
        const typedMiss: Either<Rejected, never> = miss

        expectRight(typedHit, 42)
        expect(miss._tag).toBe('Left')
        expectLeft(typedMiss, { _tag: 'Rejected', cause })
        return 'continued' as const
      },
    )

    expectRight(result, 'continued')
  })

  it('flattens an Either returned by a synchronous thunk', () => {
    const result = raise.capture(() => left('Unavailable' as const))
    const typed: Either<'Unavailable' | Rejected, never> = result

    expect(typed).toBe(result)
    expectLeft(result, 'Unavailable')
  })

  it('flattens resolved Eithers and wraps raw async successes', async () => {
    const domain = await raise.capture(
      Promise.resolve(right({ id: 'user-1' as const })),
    )
    const raw = await raise.capture(async () => 'ready' as const)
    const typedDomain: Either<Rejected, { id: 'user-1' }> = domain
    const typedRaw: Either<Rejected, 'ready'> = raw

    expect(typedDomain).toBe(domain)
    expectRight(domain, { id: 'user-1' })
    expectRight(typedRaw, 'ready')
  })

  it('captures rejected promises without short-circuiting', async () => {
    const cause = new Error('Provider rejected')

    const result = await either(
      // oxlint-disable-next-line require-yield
      async function* ({ raise }) {
        const attempt = await raise.capture(Promise.reject(cause))
        const typed: Either<Rejected, never> = attempt

        expect(attempt._tag).toBe('Left')
        expectLeft(typed, { _tag: 'Rejected', cause })
        return 'fallback' as const
      },
    )

    expectRight(result, 'fallback')
  })

  it('captures custom thenables and flattens their outcomes', async () => {
    const outcome = right('from-thenable' as const)
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable
      then(resolve: (value: typeof outcome) => void) {
        resolve(outcome)
      },
    } as PromiseLike<typeof outcome>

    const result = await raise.capture(thenable)
    expect(result).toBe(outcome)
  })

  it('captures a throwing then getter', async () => {
    const cause = new Error('Broken then getter')
    // oxlint-disable-next-line unicorn/no-thenable
    const thenable = Object.defineProperty({}, 'then', {
      get() {
        throw cause
      },
    }) as PromiseLike<never>

    const result = await raise.capture(thenable)
    expectLeft(result, { _tag: 'Rejected', cause })
  })

  it('allows a captured outcome to be propagated deliberately', async () => {
    const result = await either(async function* (raise) {
      const attempt = await raise.capture(async () =>
        left('ProviderDown' as const),
      )
      return yield* attempt
    })

    expectLeft(result, 'ProviderDown')
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

  it('closes the generator when the first Right short-circuits', () => {
    const events: string[] = []

    const result = firstOf(function* () {
      try {
        events.push('enter')
        yield right('instant')
        events.push('after')
        yield fromApi()
      } finally {
        events.push('finally')
      }
    })

    expectRight(result, 'instant')
    expect(events).toEqual(['enter', 'finally'])
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
