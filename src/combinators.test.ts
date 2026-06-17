import { describe, expect, it } from 'vitest'

import { type Aborted, type Exit, type Rejected } from './async.ts'
import {
  either,
  capture,
  validate,
  firstOf,
  collect,
  all,
  collectAll,
  ensure,
  ensureNotNull,
} from './combinators.ts'
import { left, right, type Either } from './either.ts'

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
} {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
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
        Rejected | Aborted,
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

    const result = await either(async function* ({ signal }) {
      const slow = signal.fork(async (child) => {
        events.push('slow:start')
        const result = await abortAsLeft(child, 'SlowAborted' as const)
        events.push('slow:aborted')
        return result
      })

      void signal.fork(() => {
        events.push('fail')
        return left('Boom' as const)
      })

      yield* await slow
      return 'done' as const
    })

    expectLeft(result as Either<unknown, unknown>, 'Boom')
    expect(events).toEqual(['slow:start', 'fail', 'slow:aborted'])
  })

  it('runs signal.all concurrently and preserves tuple order', async () => {
    const first = deferred<Either<'FirstFailed', number>>()
    const second = deferred<Either<'SecondFailed', string>>()

    const resultPromise = either(async function* ({ signal }) {
      return yield* await signal.all([
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

  it('cancels sibling tasks when signal.all sees a Left', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      return yield* await signal.all([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
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
  })

  it('lets signal.race return the first Right without poisoning the scope', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      const raced = yield* await signal.race([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
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
  })

  it('lets signal.race return the first Left and cancel losers', async () => {
    const events: string[] = []

    const result = await either(async function* ({ signal }) {
      return yield* await signal.race([
        async (child) => {
          events.push('slow:start')
          const result = await abortAsLeft(child, 'SlowAborted' as const)
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
  })

  it('returns Rejected for an empty signal.race', async () => {
    const result = await either(async function* ({ signal }) {
      yield* await signal.race([] as const)
      return 'done' as const
    })

    expect(result._tag).toBe('Left')
    if (result._tag !== 'Left') return
    const error = result.error as Rejected
    expect(error._tag).toBe('Rejected')
    expect(error.cause).toBeInstanceOf(TypeError)
    expect((error.cause as Error).message).toBe(
      'signal.race() requires at least one task',
    )
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

  it('does not enable signal.all or signal.race inside sync either', () => {
    expect(() =>
      either(function* ({ signal }) {
        void signal.all([])
        return yield* right(1)
      }),
    ).toThrow('signal.all() is only available in async either')

    expect(() =>
      either(function* ({ signal }) {
        void signal.race([])
        return yield* right(1)
      }),
    ).toThrow('signal.race() is only available in async either')
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

describe('capture', () => {
  it('captures a Left as a value instead of short-circuiting', () => {
    const result = either(function* () {
      const cached = yield* capture(left('CacheMiss' as const))
      if (cached._tag === 'Left') return 'fallback' as const
      return cached.value
    })

    expectRight(result, 'fallback')
  })

  it('allows a captured Left to be re-raised explicitly', () => {
    const result = either(function* (raise) {
      const cached = yield* capture(left('CacheMiss' as const))
      if (cached._tag === 'Left') return raise(cached.error)
      return cached.value
    })

    expectLeft(result, 'CacheMiss')
  })

  it('captures a Right without changing its value', () => {
    const result = either(function* () {
      const value = yield* capture(right(42))
      return value._tag === 'Right' ? value.value : 0
    })

    expectRight(result, 42)
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
