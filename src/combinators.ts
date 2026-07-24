import {
  type Aborted,
  type RaiseContext,
  type Exit,
  type ForkEachCompletion,
  type ForkEachIterator,
  type ForkEachOptions,
  type ForkEachTask,
  type Rejected,
  type ScopeSignal,
  type ScopeTask,
  aborted,
  forkEachStopped,
  rejected,
  raise,
  siblingSettled,
  suppressed,
  toRejectedLeft,
} from './async.ts'
import {
  type Either,
  type InferE,
  type InferA,
  Left,
  Right,
  left,
  right,
} from './either.ts'

const RIGHT_VOID = right(undefined) as Right<void>
const NO_CLEANUP_FAILURES: readonly Rejected[] = []
const SYNC_GENERATOR_FUNCTION = Object.getPrototypeOf(function* () {})

type MaybeLeft = { readonly _tag?: unknown }

function finishEither(ret: unknown): Either<any, any> {
  return ret !== null &&
    typeof ret === 'object' &&
    (ret as MaybeLeft)._tag === 'Left'
    ? (ret as unknown as Left<any>)
    : right(ret)
}

function eitherSync<Eff extends Either<any, any>, Ret>(
  gen: Generator<Eff, Ret, unknown>,
): Either<any, any> {
  let next = gen.next()
  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') {
      gen.return(undefined as Ret)
      return eff
    }
    next = gen.next(eff.value)
  }
  return finishEither(next.value)
}

async function eitherAsync<Eff extends Either<any, any>, Ret>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  scope?: ScopeSource,
): Promise<Either<any, any>> {
  let result: Either<any, any> | undefined
  let thrown = false
  let thrownCause: unknown
  try {
    let value: unknown
    let hasValue = false

    while (true) {
      const before = peekScope(scope)
      const existing = before?.currentFailure()
      if (existing !== undefined) {
        await gen.return(undefined as Ret)
        result = existing
        break
      }

      const pending = hasValue ? gen.next(value) : gen.next()
      const currentScope = peekScope(scope)
      const next =
        currentScope === undefined
          ? await pending
          : await Promise.race([pending, currentScope.failure])
      if (isScopeFailure(next)) {
        await pending
        await gen.return(undefined as Ret)
        result = next
        break
      }

      if (next.done) {
        result = finishEither(next.value)
        break
      }

      const eff = next.value
      if (eff._tag === 'Left') {
        await gen.return(undefined as Ret)
        result = eff
        break
      }
      value = eff.value
      hasValue = true
    }
  } catch (cause) {
    thrown = true
    thrownCause = cause
  } finally {
    const currentScope = peekScope(scope)
    if (currentScope === undefined) {
      if (thrown) {
        throwWithCleanupFailures(thrownCause, NO_CLEANUP_FAILURES)
      }
    } else {
      const closeFailure = await currentScope.close()
      const cleanupFailures = currentScope.currentCleanupFailures()
      if (thrown) {
        throwWithCleanupFailures(thrownCause, cleanupFailures)
      }
      if (closeFailure !== undefined && closeFailure !== result) {
        result =
          result?._tag === 'Left'
            ? withSuppressed(
                result,
                cleanupFailures.length === 0
                  ? cleanupFailuresFromError(closeFailure.error)
                  : cleanupFailures,
              )
            : closeFailure
      }
    }
  }

  if (result === undefined) {
    throw new Error('Unreachable: async either completed without a result')
  }
  return result
}

function throwWithCleanupFailures(
  cause: unknown,
  cleanupFailures: readonly Rejected[],
): never {
  let combined = cause
  for (let index = cleanupFailures.length - 1; index >= 0; index--) {
    const cleanup = cleanupFailures[index]
    if (cleanup !== undefined) {
      combined = new SuppressedError(
        cleanup.cause,
        combined,
        'An error was suppressed during disposal',
      )
    }
  }
  throw combined
}

type ScopeRuntime = {
  readonly failure: Promise<Left<any>>
  readonly signal: ScopeSignal
  readonly enableFork: () => void
  readonly abort: (reason?: unknown) => void
  readonly close: () => Promise<Left<any> | undefined>
  readonly registerResource: (
    resource: unknown,
    release?: (resource: any) => void | PromiseLike<void>,
  ) => void
  readonly fail: (
    failure: Left<any>,
    reason?: unknown,
    cleanupFailures?: readonly Rejected[],
  ) => void
  readonly appendCleanupFailures: (failures: readonly Rejected[]) => void
  readonly currentFailure: () => Left<any> | undefined
  readonly currentCleanupFailures: () => readonly Rejected[]
}

type ResourceRelease = (resource: any) => void | PromiseLike<void>

class AcquisitionIterator implements AsyncIterableIterator<
  Left<any>,
  any,
  unknown
> {
  #pending: Promise<IteratorResult<Left<any>, any>> | undefined
  // 0 = active, 1 = done, 2 = yielded failure awaiting the protocol check.
  #state: 0 | 1 | 2 = 0
  #stopRequested = false
  readonly #done = { done: true, value: undefined } as const
  readonly #owner: ScopeRuntime
  readonly #factory: (signal: ScopeSignal) => unknown
  readonly #release: ResourceRelease | undefined

  constructor(
    owner: ScopeRuntime,
    factory: (signal: ScopeSignal) => unknown,
    release?: ResourceRelease,
  ) {
    this.#owner = owner
    this.#factory = factory
    this.#release = release
  }

  [Symbol.asyncIterator](): this {
    return this
  }

  // oxlint-disable-next-line typescript/promise-function-async
  next(): Promise<IteratorResult<Left<any>, any>> {
    if (this.#state !== 0) {
      if (this.#state === 2) {
        this.#state = 1
        return Promise.reject(
          new Error('Unreachable: acquisition failure was ignored'),
        )
      }
      return Promise.resolve(this.#done)
    }
    if (this.#pending === undefined) {
      this.#pending = this.#run()
      return this.#pending
    }
    return this.#state === 0
      ? this.#pending.then(() => this.#done)
      : Promise.resolve(this.#done)
  }

  async return(value?: any): Promise<IteratorReturnResult<any>> {
    this.#stopRequested = true
    if (this.#pending !== undefined) await this.#pending
    this.#state = 1
    return { done: true, value }
  }

  async throw(cause?: unknown): Promise<IteratorResult<Left<any>, any>> {
    this.#stopRequested = true
    if (this.#pending !== undefined) await this.#pending
    this.#state = 1
    throw cause
  }

  async #run(): Promise<IteratorResult<Left<any>, any>> {
    const before = dominantFailure(this.#owner)
    if (before !== undefined) return this.#fail(before)

    let result: unknown
    try {
      result = await Promise.try(this.#factory, this.#owner.signal)
    } catch (cause) {
      const failure = toRejectedLeft(cause)
      const dominant = dominantFailure(this.#owner)
      if (dominant !== undefined) {
        this.#owner.appendCleanupFailures([failure.error])
        return this.#fail(dominant)
      }
      this.#owner.fail(failure)
      return this.#fail(failure)
    }

    const dominant = dominantFailure(this.#owner)
    if (result instanceof Left) {
      if (dominant !== undefined) return this.#fail(dominant)
      this.#owner.fail(result)
      return this.#fail(result)
    }

    const resource = result instanceof Right ? result.value : result
    try {
      this.#owner.registerResource(resource, this.#release)
    } catch (cause) {
      const registrationFailure = toRejectedLeft(cause)
      const current = dominantFailure(this.#owner)
      if (current !== undefined) {
        this.#owner.appendCleanupFailures([registrationFailure.error])
        return this.#fail(current)
      }
      this.#owner.fail(registrationFailure)
      return this.#fail(registrationFailure)
    }

    const after = dominantFailure(this.#owner)
    if (after !== undefined) return this.#fail(after)

    this.#state = 1
    return this.#stopRequested ? this.#done : { done: true, value: resource }
  }

  #fail(failure: Left<any>): IteratorYieldResult<Left<any>> {
    this.#state = 2
    return { done: false, value: failure }
  }
}

function dominantFailure(owner: ScopeRuntime): Left<any> | undefined {
  const existing = owner.currentFailure()
  if (existing !== undefined) return existing
  const signal = owner.signal
  if (!signal.aborted) return undefined

  const cancellation = left(aborted(signal.reason))
  owner.fail(cancellation, signal.reason)
  return owner.currentFailure() ?? cancellation
}

type ScopedTaskHandle<E, A> = {
  readonly promise: Promise<Exit<E, A>>
  readonly abort: (reason?: unknown) => void
}

type RaiseContextState = {
  readonly parent: AbortSignal | undefined
  scope?: ScopeRuntime
  forkEnabled: boolean
  sync: boolean
}

const RAISE_CONTEXT_STATE = Symbol()

type RaiseContextHandle = RaiseContext & {
  readonly [RAISE_CONTEXT_STATE]: RaiseContextState
}

type ScopeSource = ScopeRuntime | RaiseContextState

const RAISE_CONTEXT_PROPERTIES = {
  capture: { configurable: true, value: raise.capture },
  raise: {
    configurable: true,
    get(this: RaiseContextHandle) {
      return this
    },
  },
  signal: {
    configurable: true,
    get(this: RaiseContextHandle) {
      return this[RAISE_CONTEXT_STATE].sync
        ? syncScopeSignal()
        : ensureRaiseContextScope(this).signal
    },
  },
} as const satisfies PropertyDescriptorMap

function createScopeRuntime(parent?: AbortSignal): ScopeRuntime {
  const controller = new AbortController()
  let failurePromise: Promise<Left<any>> | undefined
  let resolveFailure: ((failure: Left<any>) => void) | undefined
  let children: Set<Promise<Either<any, any>>> | undefined
  let recordedCleanupFailures: Rejected[] | undefined
  let resources: AsyncDisposableStack | undefined
  let failure: Left<any> | undefined
  let closing = false
  let closePromise: Promise<Left<any> | undefined> | undefined
  let forkEnabled = false
  let parentCleanup: (() => void) | undefined

  const fail = (
    nextFailure: Left<any>,
    reason = nextFailure.error,
    cleanupFailures: readonly Rejected[] = [],
  ): void => {
    if (failure !== undefined || closing) return
    failure = nextFailure
    if (cleanupFailures.length > 0)
      (recordedCleanupFailures ??= []).push(...cleanupFailures)
    resolveFailure?.(nextFailure)
    if (!controller.signal.aborted) controller.abort(reason)
  }

  const onParentAbort = (): void => {
    fail(left(aborted(parent?.reason)), parent?.reason)
  }

  if (parent !== undefined) {
    if (parent.aborted) onParentAbort()
    else {
      parent.addEventListener('abort', onParentAbort, { once: true })
      parentCleanup = () => parent.removeEventListener('abort', onParentAbort)
    }
  }

  function acquireScopedResource<T>(
    factory: (signal: ScopeSignal) => T,
    release?: ResourceRelease,
  ): AcquisitionIterator {
    ensureForkEnabled('acquire')
    if (typeof factory !== 'function') {
      throw new TypeError('signal.acquire() requires a resource factory')
    }
    if (release !== undefined && typeof release !== 'function') {
      throw new TypeError('signal.acquire() release must be a function')
    }
    return new AcquisitionIterator(scope, factory, release)
  }

  const signal = controller.signal as ScopeSignal
  Object.defineProperties(signal, {
    acquire: { configurable: true, value: acquireScopedResource },
    fork: { configurable: true, value: forkScopedTask },
    forkAll: { configurable: true, value: forkAllScopedTasks },
    forkFirst: { configurable: true, value: forkFirstScopedTasks },
    forkRace: { configurable: true, value: forkRaceScopedTasks },
    forkEach: { configurable: true, value: forkEachScopedTasks },
  })

  const scope = {
    get failure(): Promise<Left<any>> {
      if (failurePromise === undefined) {
        const deferred = Promise.withResolvers<Left<any>>()
        failurePromise = deferred.promise
        resolveFailure = deferred.resolve
        if (failure !== undefined) deferred.resolve(failure)
      }
      return failurePromise
    },
    signal,
    enableFork() {
      forkEnabled = true
    },
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    // oxlint-disable-next-line typescript/promise-function-async
    close: () => {
      closePromise ??= closeScope()
      return closePromise
    },
    registerResource(resource, release) {
      resources ??= new AsyncDisposableStack()
      if (release === undefined) resources.use(resource as Disposable)
      else resources.adopt(resource, release)
    },
    fail,
    appendCleanupFailures(cleanupFailures) {
      if (cleanupFailures.length === 0) return
      if (failure === undefined) {
        const cleanupFailure = leftFromCleanupFailures(cleanupFailures)
        if (cleanupFailure !== undefined)
          fail(cleanupFailure, undefined, cleanupFailures)
        return
      }
      failure = withSuppressed(failure, cleanupFailures)
      recordedCleanupFailures ??= []
      recordedCleanupFailures.push(...cleanupFailures)
    },
    currentFailure: () => failure,
    currentCleanupFailures: () =>
      recordedCleanupFailures ?? NO_CLEANUP_FAILURES,
  } as const satisfies ScopeRuntime

  async function closeScope(): Promise<Left<any> | undefined> {
    closing = true
    parentCleanup?.()
    if (
      children !== undefined &&
      children.size > 0 &&
      !controller.signal.aborted
    ) {
      controller.abort(new DOMException('Scope closed', 'AbortError'))
    }

    let cleanupFailures: Rejected[] | undefined
    if (children !== undefined && children.size > 0) {
      const settled = await Promise.allSettled(children)
      const childFailures = cleanupFailuresFromSettledChildren(settled)
      if (childFailures.length > 0) cleanupFailures = childFailures
    }

    if (resources !== undefined) {
      try {
        await resources.disposeAsync()
      } catch (cause) {
        const resourceFailures = cleanupFailuresFromDispose(cause)
        if (cleanupFailures === undefined) cleanupFailures = resourceFailures
        else cleanupFailures.push(...resourceFailures)
      }
    }

    if (cleanupFailures === undefined) return failure
    recordedCleanupFailures ??= []
    recordedCleanupFailures.push(...cleanupFailures)
    return leftFromCleanupFailures(cleanupFailures, failure)
  }

  // oxlint-disable-next-line typescript/promise-function-async
  function forkScopedTask<E, A>(task: ScopeTask<E, A>): Promise<Exit<E, A>> {
    ensureForkEnabled('fork')
    const existing = failure
    if (existing !== undefined) {
      return Promise.resolve(existing as Exit<E, A>)
    }

    const child = startScopedTask(task)
    return child.promise.then((result) => {
      if (result._tag === 'Left') {
        if (scope.currentFailure() === undefined) scope.fail(result)
      }
      return result
    })
  }

  // oxlint-disable-next-line typescript/promise-function-async
  function forkAllScopedTasks<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<any, any[]>> {
    ensureForkEnabled('forkAll')

    const existing = failure
    if (existing !== undefined) return Promise.resolve(existing)
    if (tasks.length === 0) return Promise.resolve(right([]))

    const handles: (ScopedTaskHandle<any, any> | undefined)[] = []
    handles.length = tasks.length
    const values: any[] = []
    values.length = tasks.length

    let remaining = tasks.length
    let settled = false

    return new Promise((resolve) => {
      for (let index = 0; index < tasks.length; index++) {
        const handle = startScopedTask(tasks[index] as ScopeTask<any, any>)
        handles[index] = handle

        void handle.promise.then(async (result) => {
          if (settled) return

          if (result._tag === 'Left') {
            settled = true
            handles[index] = undefined
            const cleanupFailures = await abortAndCollectScopedTasks(
              handles,
              result.error,
              index,
            )
            const finalResult = withSuppressed(result, cleanupFailures)
            scope.fail(finalResult, undefined, cleanupFailures)
            resolve(finalResult)
            return
          }

          handles[index] = undefined
          values[index] = result.value
          remaining--
          if (remaining === 0) {
            settled = true
            resolve(right(values))
          }
        })
      }
    })
  }

  // oxlint-disable-next-line typescript/promise-function-async
  function forkFirstScopedTasks<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<any[], any>> {
    ensureForkEnabled('forkFirst')

    const existing = failure
    if (existing !== undefined) return Promise.resolve(existing)
    if (tasks.length === 0) {
      const result = left([])
      scope.fail(result)
      return Promise.resolve(result)
    }

    const handles: (ScopedTaskHandle<any, any> | undefined)[] = []
    handles.length = tasks.length
    let errors: any[] | undefined

    let remaining = tasks.length
    let settled = false

    return new Promise((resolve) => {
      for (let index = 0; index < tasks.length; index++) {
        const handle = startScopedTask(tasks[index] as ScopeTask<any, any>)
        handles[index] = handle

        void handle.promise.then((result) => {
          if (settled) return
          handles[index] = undefined

          if (result._tag === 'Left') {
            errors ??= []
            errors[index] = result.error
            remaining--
            if (remaining > 0) return

            settled = true
            const finalResult = left(errors)
            scope.fail(finalResult)
            resolve(finalResult)
            return
          }

          settled = true
          void abortAndCollectScopedTasks(
            handles,
            siblingSettled(),
            index,
          ).then((cleanupFailures) => {
            const cleanupFailure = leftFromCleanupFailures(cleanupFailures)
            if (cleanupFailure !== undefined) {
              scope.fail(cleanupFailure, undefined, cleanupFailures)
              resolve(cleanupFailure)
              return
            }

            resolve(result)
          })
        })
      }
    })
  }

  // oxlint-disable-next-line typescript/promise-function-async
  function forkRaceScopedTasks<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<any, any>> {
    ensureForkEnabled('forkRace')

    const existing = failure
    if (existing !== undefined) return Promise.resolve(existing)
    if (tasks.length === 0) {
      const result = toRejectedLeft(
        new TypeError('signal.forkRace() requires at least one task'),
      )
      scope.fail(result)
      return Promise.resolve(result)
    }

    const handles: (ScopedTaskHandle<any, any> | undefined)[] = []
    handles.length = tasks.length

    let settled = false

    return new Promise((resolve) => {
      for (let index = 0; index < tasks.length; index++) {
        const handle = startScopedTask(tasks[index] as ScopeTask<any, any>)
        handles[index] = handle

        void handle.promise.then(async (result) => {
          if (settled) return
          settled = true
          handles[index] = undefined

          const cleanupFailures = await abortAndCollectScopedTasks(
            handles,
            result._tag === 'Left' ? result.error : siblingSettled(),
            index,
          )
          const finalResult =
            result._tag === 'Left'
              ? withSuppressed(result, cleanupFailures)
              : leftFromCleanupFailures(cleanupFailures)

          if (finalResult?._tag === 'Left') {
            scope.fail(finalResult, undefined, cleanupFailures)
            resolve(finalResult)
            return
          }

          resolve(result)
        })
      }
    })
  }

  function forkEachScopedTasks<Input, E, A>(
    items: Iterable<Input> | AsyncIterable<Input>,
    options: ForkEachOptions,
    task: ForkEachTask<Input, E, A>,
  ): ForkEachIterator<Input, E, A> {
    ensureForkEnabled('forkEach')

    const concurrency = options.concurrency
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new TypeError(
        'signal.forkEach() concurrency must be a positive safe integer',
      )
    }

    type Completion = ForkEachCompletion<Input, E, A>
    type SourceIterator =
      | Iterator<Input, unknown, unknown>
      | AsyncIterator<Input, unknown, unknown>
    type Waiter = ReturnType<
      typeof Promise.withResolvers<IteratorResult<Completion, undefined>>
    >

    const active = new Map<number, ScopedTaskHandle<E, A>>()
    const completions: Completion[] = []
    const waiters: Waiter[] = []
    let source: SourceIterator | undefined
    let sourcePull: Promise<IteratorResult<Input, unknown>> | undefined
    let nextIndex = 0
    let started = false
    let sourceDone = false
    let closed = false
    let finished = false
    let pumping = false
    let closePromise: Promise<void> | undefined

    const done: IteratorResult<Completion, undefined> = {
      done: true,
      value: undefined,
    }

    const resolveDone = (): void => {
      let waiter: Waiter | undefined
      while ((waiter = waiters.shift()) !== undefined) waiter.resolve(done)
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      scope.signal.removeEventListener('abort', onOwnerAbort)
      resolveDone()
    }

    const maybeFinish = (): void => {
      if (sourceDone && active.size === 0 && completions.length === 0) {
        finish()
      }
    }

    const acquireSource = (): SourceIterator => {
      const asyncIterator = (items as AsyncIterable<Input>)[
        Symbol.asyncIterator
      ]
      if (typeof asyncIterator === 'function') return asyncIterator.call(items)
      return (items as Iterable<Input>)[Symbol.iterator]()
    }

    const deliver = (completion: Completion): void => {
      const waiter = waiters.shift()
      if (waiter === undefined) {
        completions.push(completion)
        return
      }

      waiter.resolve({ done: false, value: completion })
      void pump()
    }

    const startTask = (item: Input, index: number): void => {
      const handle = startScopedTask(task, false, item, index)
      active.set(index, handle)

      void handle.promise.then(
        (result) => {
          untrackScopedTask(handle.promise)
          if (closed) return
          active.delete(index)
          deliver({ item, index, result })
          maybeFinish()
        },
        (cause) => {
          untrackScopedTask(handle.promise)
          if (closed) return
          active.delete(index)
          deliver({
            item,
            index,
            result: toRejectedLeft(cause),
          })
          maybeFinish()
        },
      )
    }

    const failFromSource = (cause: unknown): void => {
      const failure = toRejectedLeft(cause)
      void close(failure.error, failure)
    }

    const pump = async (): Promise<void> => {
      if (pumping || closed || finished) return
      pumping = true

      try {
        while (
          !closed &&
          !sourceDone &&
          active.size + completions.length < concurrency
        ) {
          source ??= acquireSource()
          sourcePull = Promise.resolve(source.next())
          const next = await sourcePull
          sourcePull = undefined

          if (closed) return
          if (next.done) {
            sourceDone = true
            maybeFinish()
            return
          }

          const index = nextIndex++
          startTask(next.value, index)
        }
      } catch (cause) {
        sourcePull = undefined
        if (!closed) failFromSource(cause)
      } finally {
        pumping = false
      }
    }

    const start = (): void => {
      if (started) return
      started = true

      if (scope.currentFailure() !== undefined || scope.signal.aborted) {
        closed = true
        finish()
        return
      }

      scope.signal.addEventListener('abort', onOwnerAbort, { once: true })
      void pump()
    }

    function onOwnerAbort(): void {
      void close(scope.signal.reason)
    }

    // oxlint-disable-next-line typescript/promise-function-async
    function close(
      reason: unknown = forkEachStopped(),
      primary?: Left<Rejected>,
    ): Promise<void> {
      if (closePromise !== undefined) return closePromise
      if (finished) return Promise.resolve()

      closed = true
      scope.signal.removeEventListener('abort', onOwnerAbort)
      completions.length = 0

      const pending = [...active.entries()].sort(
        ([leftIndex], [rightIndex]) => leftIndex - rightIndex,
      )
      for (const [, handle] of pending) handle.abort(reason)

      closePromise = (async () => {
        const cleanupFailures: Rejected[] = []
        let sourcePullFailure: Rejected | undefined

        if (sourcePull !== undefined) {
          try {
            await sourcePull
          } catch (cause) {
            sourcePullFailure = rejected(cause)
          }
        }

        const sourceClose =
          !sourceDone && source?.return !== undefined
            ? closeForkEachSource(source, reason)
            : undefined
        const settled = await Promise.allSettled(
          pending.map(
            // oxlint-disable-next-line typescript/promise-function-async
            ([, handle]) => handle.promise,
          ),
        )
        cleanupFailures.push(...cleanupFailuresFromSettledChildren(settled))
        if (sourcePullFailure !== undefined)
          cleanupFailures.push(sourcePullFailure)
        const sourceCloseFailure = await sourceClose
        if (sourceCloseFailure !== undefined)
          cleanupFailures.push(sourceCloseFailure)

        active.clear()
        finished = true
        resolveDone()

        const existing = scope.currentFailure()
        if (existing !== undefined) {
          scope.appendCleanupFailures(cleanupFailures)
          return
        }

        if (primary !== undefined) {
          scope.fail(
            withSuppressed(primary, cleanupFailures),
            reason,
            cleanupFailures,
          )
          return
        }

        const cleanupFailure = leftFromCleanupFailures(cleanupFailures)
        if (cleanupFailure !== undefined)
          scope.fail(cleanupFailure, reason, cleanupFailures)
      })()

      return closePromise
    }

    const iterator: ForkEachIterator<Input, E, A> = {
      [Symbol.asyncIterator]() {
        return this
      },
      async next() {
        start()

        const completion = completions.shift()
        if (completion !== undefined) {
          maybeFinish()
          void pump()
          return { done: false, value: completion }
        }
        if (finished || closed) return done

        const waiter =
          Promise.withResolvers<IteratorResult<Completion, undefined>>()
        waiters.push(waiter)
        void pump()
        return await waiter.promise
      },
      async return() {
        await close()
        return done
      },
      async [Symbol.asyncDispose]() {
        await close()
      },
    }

    return iterator
  }

  function startScopedTask<E, A>(
    task: ScopeTask<E, A> | ForkEachTask<any, E, A>,
    recordLate = true,
    item?: unknown,
    index = -1,
  ): ScopedTaskHandle<E, A> {
    if (closing) {
      const result = left(aborted(controller.signal.reason)) as Exit<E, A>
      return {
        promise: Promise.resolve(result),
        abort: () => {},
      }
    }

    const childScope = createScopeRuntime(scope.signal)
    childScope.enableFork()
    const existing = childScope.currentFailure()
    if (existing !== undefined) {
      return {
        promise: Promise.resolve(existing as Exit<E, A>),
        abort: childScope.abort,
      }
    }

    const childPromise = runScopedTask(childScope, task, item, index)

    children ??= new Set()
    children.add(childPromise)
    if (recordLate) {
      void childPromise.then(
        (result) => {
          recordLateCleanupFailures(result)
          untrackScopedTask(childPromise)
        },
        (cause) => {
          recordLateCleanupFailures(toRejectedLeft(cause))
          untrackScopedTask(childPromise)
        },
      )
    }

    return {
      promise: childPromise,
      abort: childScope.abort,
    }
  }

  function recordLateCleanupFailures(result: Either<any, any>): void {
    if (closing) return

    const currentFailure = failure
    if (currentFailure === undefined) return

    const cleanupFailures =
      result._tag === 'Left'
        ? cleanupFailuresFromError(result.error)
        : NO_CLEANUP_FAILURES
    if (cleanupFailures.length > 0) {
      failure = withSuppressed(currentFailure, cleanupFailures)
      recordedCleanupFailures ??= []
      recordedCleanupFailures.push(...cleanupFailures)
    }
  }

  function untrackScopedTask(childPromise: Promise<Either<any, any>>): void {
    children?.delete(childPromise)
    if (children?.size === 0) children = undefined
  }

  function ensureForkEnabled(
    method:
      | 'acquire'
      | 'fork'
      | 'forkAll'
      | 'forkFirst'
      | 'forkRace'
      | 'forkEach',
  ): void {
    if (!forkEnabled) {
      throw new TypeError(
        `signal.${method}() is only available in async either`,
      )
    }
  }

  return scope
}

async function closeForkEachSource(
  source: Iterator<unknown, unknown> | AsyncIterator<unknown, unknown>,
  reason: unknown,
): Promise<Rejected | undefined> {
  try {
    await source.return?.(reason)
  } catch (cause) {
    return rejected(cause)
  }
  return undefined
}

async function runScopedTask<E, A>(
  childScope: ScopeRuntime,
  task: ScopeTask<E, A> | ForkEachTask<any, E, A>,
  item?: unknown,
  index = -1,
): Promise<Exit<E, A>> {
  let result: Exit<E, A>

  try {
    const taskResult =
      index === -1
        ? await Promise.try(task as ScopeTask<E, A>, childScope.signal)
        : await Promise.try(
            task as ForkEachTask<unknown, E, A>,
            item,
            childScope.signal,
            index,
          )
    result = finishScopedTaskResult(childScope, taskResult as Exit<E, A>)
  } catch (cause) {
    result = finishScopedTaskResult(
      childScope,
      toRejectedLeft(cause) as Exit<E, A>,
    )
  }

  const closeFailure = await childScope.close()
  if (closeFailure === undefined || closeFailure === result) return result

  const cleanupFailures = childScope.currentCleanupFailures()
  return (
    result._tag === 'Left'
      ? withSuppressed(
          result,
          cleanupFailures.length === 0
            ? cleanupFailuresFromError(closeFailure.error)
            : cleanupFailures,
        )
      : closeFailure
  ) as Exit<E, A>
}

function finishScopedTaskResult<E, A>(
  childScope: ScopeRuntime,
  result: Exit<E, A>,
): Exit<E, A> {
  const failure = childScope.currentFailure()
  if (failure === undefined) return result
  if (failure === result) return result
  if (result._tag === 'Right') return failure as Exit<E, A>

  const cleanupFailures = cleanupFailuresFromError(result.error)
  return cleanupFailures.length === 0
    ? (failure as Exit<E, A>)
    : (withSuppressed(failure, cleanupFailures) as Exit<E, A>)
}

async function abortAndCollectScopedTasks(
  handles: readonly (ScopedTaskHandle<any, any> | undefined)[],
  reason: unknown,
  except?: number,
): Promise<readonly Rejected[]> {
  const promises: Promise<Exit<any, any>>[] = []
  for (let index = 0; index < handles.length; index++) {
    if (index === except) continue

    const handle = handles[index]
    if (handle === undefined) continue

    handle.abort(reason)
    promises.push(handle.promise)
  }

  if (promises.length === 0) return []
  return cleanupFailuresFromSettledChildren(await Promise.allSettled(promises))
}

function cleanupFailuresFromSettledChildren(
  settled: readonly PromiseSettledResult<Either<any, any>>[],
): Rejected[] {
  const failures: Rejected[] = []

  for (const result of settled) {
    if (result.status === 'rejected') {
      failures.push(rejected(result.reason))
      continue
    }

    if (result.value._tag === 'Left') {
      appendCleanupFailures(result.value.error, failures)
    }
  }

  return failures
}

function cleanupFailuresFromDispose(cause: unknown): Rejected[] {
  const failures: Rejected[] = []
  while (cause instanceof SuppressedError) {
    failures.push(rejected(cause.error))
    cause = cause.suppressed
  }
  failures.push(rejected(cause))
  return failures
}

function cleanupFailuresFromError(error: unknown): readonly Rejected[] {
  const failures: Rejected[] = []
  appendCleanupFailures(error, failures)
  return failures.length === 0 ? NO_CLEANUP_FAILURES : failures
}

function appendCleanupFailures(error: unknown, failures: Rejected[]): void {
  if (isRejectedError(error)) {
    failures.push(error)
    return
  }
  if (!isSuppressedError(error)) return

  for (const suppressedError of error.suppressed) {
    appendCleanupFailures(suppressedError, failures)
  }
}

function leftFromCleanupFailures(
  cleanupFailures: readonly Rejected[],
  primary?: Left<any>,
): Left<any> | undefined {
  if (cleanupFailures.length === 0) return primary
  if (primary !== undefined) return withSuppressed(primary, cleanupFailures)

  const first = cleanupFailures[0] as Rejected
  return cleanupFailures.length === 1
    ? left(first)
    : left(suppressed(first, cleanupFailures.slice(1)))
}

function withSuppressed(
  primary: Left<any>,
  cleanupFailures: readonly Rejected[],
): Left<any> {
  if (cleanupFailures.length === 0) return primary

  const error = primary.error
  return left(
    isSuppressedError(error)
      ? suppressed(error.error, [...error.suppressed, ...cleanupFailures])
      : suppressed(error, cleanupFailures),
  )
}

function isRejectedError(error: unknown): error is Rejected {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly _tag?: unknown })._tag === 'Rejected'
  )
}

function isSuppressedError(error: unknown): error is {
  readonly _tag: 'Suppressed'
  readonly error: unknown
  readonly suppressed: readonly unknown[]
} {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { readonly _tag?: unknown })._tag === 'Suppressed' &&
    Array.isArray((error as { readonly suppressed?: unknown }).suppressed)
  )
}

function createRaiseContext(parent?: AbortSignal): RaiseContextHandle {
  // oxlint-disable-next-line typescript/promise-function-async
  const context = ((x: unknown) => raise(x as never)) as RaiseContextHandle
  Object.defineProperty(context, RAISE_CONTEXT_STATE, {
    value: {
      parent,
      forkEnabled: false,
      sync: false,
    } satisfies RaiseContextState,
  })
  Object.defineProperties(context, RAISE_CONTEXT_PROPERTIES)
  return context
}

function ensureRaiseContextScope(context: RaiseContextHandle): ScopeRuntime {
  const state = context[RAISE_CONTEXT_STATE]
  if (state.scope === undefined) {
    state.scope = createScopeRuntime(state.parent)
    if (state.forkEnabled) state.scope.enableFork()
  }
  return state.scope
}

function enableRaiseContextFork(context: RaiseContextHandle): void {
  const state = context[RAISE_CONTEXT_STATE]
  state.forkEnabled = true
  state.scope?.enableFork()
}

let disabledSyncSignal: ScopeSignal | undefined
let sharedSyncRaiseContext: RaiseContext | undefined

function syncScopeSignal(): ScopeSignal {
  if (disabledSyncSignal !== undefined) return disabledSyncSignal

  const unavailable = (method: string) => () => {
    throw new TypeError(`signal.${method}() is only available in async either`)
  }
  const signal = new AbortController().signal as ScopeSignal
  Object.defineProperties(signal, {
    acquire: { value: unavailable('acquire') },
    fork: { value: unavailable('fork') },
    forkAll: { value: unavailable('forkAll') },
    forkFirst: { value: unavailable('forkFirst') },
    forkRace: { value: unavailable('forkRace') },
    forkEach: { value: unavailable('forkEach') },
  })
  disabledSyncSignal = signal
  return signal
}

function syncRaiseContext(): RaiseContext {
  if (sharedSyncRaiseContext !== undefined) return sharedSyncRaiseContext

  // oxlint-disable-next-line typescript/promise-function-async
  const context = ((x: unknown) => raise(x as never)) as RaiseContext
  Object.defineProperties(context, {
    capture: { value: raise.capture },
    raise: { value: context },
    signal: { value: syncScopeSignal() },
  })
  sharedSyncRaiseContext = context
  return context
}

function isScopeFailure<Eff, Ret>(
  result: IteratorResult<Eff, Ret> | Left<any>,
): result is Left<any> {
  return !('done' in result)
}

function peekScope(source: ScopeSource | undefined): ScopeRuntime | undefined {
  if (source === undefined) return undefined
  return 'forkEnabled' in source ? source.scope : source
}

/**
 * Runs a generator as an `Either` computation, short-circuiting on the first
 * `Left` that is yielded or returned.
 *
 * Accepts both synchronous and asynchronous generators. When an async generator
 * is provided the return type is `Promise<Either<...>>`.
 *
 * The injected {@link RaiseContext} is callable like `raise` and can also be
 * destructured as `{ raise, signal }` in async flows. The callable side serves
 * two roles:
 * - `return raise(error)`: short-circuits with `Left<E>`. TypeScript narrows
 *   control flow correctly — code after the `return` is unreachable, and
 *   guarded values (e.g. `if (!x) return raise(e)`) are narrowed on the happy
 *   path without requiring non-null assertions.
 * - `yield* await raise(fn)` / `yield* await raise(promise)`: converts thrown
 *   exceptions and rejected promises into `Left<Rejected>` so they can be
 *   short-circuited safely.
 *
 * In async `either`, touching `context.signal` lazily creates a scoped
 * `AbortSignal`; `signal.fork(task)` starts child work that is aborted when the
 * enclosing generator finishes, short-circuits, throws, or is cancelled.
 *
 * @param fn - A function that receives a `RaiseContext` and returns a generator.
 *
 * @example
 * ```ts
 * const result = either(function* (raise) {
 *   const user = yield* getUser(id)            // Left short-circuits here
 *   if (!user.active) return raise("Inactive") // narrows: user.active is true below
 *   return user
 * })
 * ```
 */
export function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: RaiseContext) => Generator<Eff, Ret>,
): Either<
  InferE<Eff> | InferE<Extract<Ret, Left<any>>>,
  Exclude<Ret, Left<any>>
>

export function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: RaiseContext) => AsyncGenerator<Eff, Ret>,
): Promise<
  Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>
>

export function either<Eff extends Either<any, any>, Ret>(
  signal: AbortSignal,
  fn: (raise: RaiseContext, signal: ScopeSignal) => AsyncGenerator<Eff, Ret>,
): Promise<
  Either<
    Aborted | InferE<Eff> | InferE<Extract<Ret, Left<any>>>,
    Exclude<Ret, Left<any>>
  >
>

export function either<Eff extends Either<any, any>, Ret>(
  signalOrFn:
    | AbortSignal
    | ((
        raise: RaiseContext,
      ) => Generator<Eff, Ret, unknown> | AsyncGenerator<Eff, Ret, unknown>),
  fn?: (
    raise: RaiseContext,
    signal: ScopeSignal,
  ) => AsyncGenerator<Eff, Ret, unknown>,
): Either<any, any> | Promise<Either<any, any>> {
  if (typeof signalOrFn !== 'function') {
    const context = createRaiseContext(signalOrFn)
    const scope = ensureRaiseContextScope(context)
    scope.enableFork()
    const gen = fn?.(context, scope.signal)
    if (gen === undefined) {
      throw new TypeError('either(signal, fn) requires an async generator')
    }
    return eitherAsync(gen, scope)
  }

  if (Object.getPrototypeOf(signalOrFn) === SYNC_GENERATOR_FUNCTION) {
    return eitherSync(signalOrFn(syncRaiseContext()) as Generator<Eff, Ret>)
  }

  const context = signalOrFn.length === 0 ? undefined : createRaiseContext()
  const gen =
    context === undefined
      ? (
          signalOrFn as () =>
            | Generator<Eff, Ret, unknown>
            | AsyncGenerator<Eff, Ret, unknown>
        )()
      : signalOrFn(context)
  if (Symbol.asyncIterator in gen) {
    if (context !== undefined) enableRaiseContextFork(context)
    return eitherAsync(gen, context?.[RAISE_CONTEXT_STATE])
  }

  if (context === undefined) return eitherSync(gen)
  const contextState = context[RAISE_CONTEXT_STATE]
  contextState.sync = true
  if (contextState.scope === undefined) return eitherSync(gen)

  try {
    return eitherSync(gen)
  } finally {
    const scope = contextState.scope
    if (scope !== undefined) void scope.close()
  }
}

/**
 * Yields an `Either` and unwraps the success value, for use inside a
 * {@link validate} generator. Unlike `yield*` inside {@link either}, a `Left`
 * does **not** short-circuit: all checks run and errors are accumulated.
 *
 * Returns `undefined` when the value is a `Left`; the caller should treat the
 * result as potentially undefined within the generator body.
 *
 * @param e - An `Either` value to check.
 */
function* check<E, A>(
  e: Either<E, A>,
): Generator<Either<E, A>, A | undefined, undefined> {
  yield e
  return e._tag === 'Right' ? e.value : undefined
}

/** The type of the {@link check} function, for use in generator signatures. */
export type Check = typeof check

/**
 * Runs a generator as a validation computation, accumulating **all** errors
 * rather than stopping at the first `Left`.
 *
 * Each `Either` should be yielded via the injected {@link check} helper, which
 * allows the generator to continue past failures. If any errors were collected,
 * returns `Left<E[]>`; otherwise returns `Right<Ret>`.
 *
 * @param fn - A function that receives `check` and returns a generator.
 *
 * @example
 * ```ts
 * const result = validate(function* (check) {
 *   const age  = yield* check(validateAge(input.age))
 *   const name = yield* check(validateName(input.name))
 *   return { age, name }
 * })
 * ```
 */
export function validate<Eff extends Either<any, any>, Ret>(
  fn: (check: Check) => Generator<Eff, Ret>,
): Either<InferE<Eff>[], Ret> {
  const gen = fn(check)
  let errors: InferE<Eff>[] | undefined
  let next = gen.next()

  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') (errors ??= []).push(eff.error)
    next = gen.next()
  }

  return errors === undefined ? right(next.value) : left(errors)
}

/**
 * Runs a generator as a "first success" computation. Yields are tried in
 * order; the first `Right` short-circuits and is returned. If every yielded
 * value fails, returns `Left<E[]>` with all collected errors.
 *
 * @param fn - A zero-argument function that returns a generator of `Either` values.
 *
 * @example
 * ```ts
 * const result = firstOf(function* () {
 *   yield fetchFromCache()   // Left → continue
 *   yield fetchFromDb()      // Left → continue
 *   yield fetchFromApi()     // Right → return immediately
 * })
 * ```
 */
export function firstOf<Eff extends Either<any, any>, Ret>(
  fn: () => Generator<Eff, Ret>,
): Either<InferE<Eff>[], InferA<Eff> | Ret> {
  const gen = fn()
  let errors: InferE<Eff>[] | undefined
  let next = gen.next()

  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Right') {
      gen.return(undefined as Ret)
      return right(eff.value)
    }
    ;(errors ??= []).push(eff.error)
    next = gen.next()
  }

  return errors === undefined ? right(next.value) : left(errors)
}

/**
 * The result of a {@link collect} computation, partitioned into errors and
 * success values.
 *
 * @typeParam E - The error type.
 * @typeParam A - The success type.
 */
export type Collected<E, A> = { errors: E[]; values: A[] }

/**
 * Runs a generator as a collection computation. Every `Either` is yielded and
 * partitioned. `Left` values go into `errors`, `Right` values into `values`.
 * Never short-circuits; always returns a {@link Collected} result.
 *
 * @param fn - A zero-argument function that returns a `void`-returning generator.
 *
 * @example
 * ```ts
 * const { errors, values } = collect(function* () {
 *   for (const item of items) yield validate(item)
 * })
 * ```
 */
export function collect<Eff extends Either<any, any>>(
  fn: () => Generator<Eff, void>,
): Collected<InferE<Eff>, InferA<Eff>> {
  const gen = fn()
  const errors: InferE<Eff>[] = []
  const values: InferA<Eff>[] = []
  let next = gen.next()

  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') errors.push(eff.error)
    else values.push(eff.value)
    next = gen.next()
  }

  return { errors, values }
}

/**
 * A value or thunk accepted by {@link all} and {@link collectAll}.
 *
 * Promise rejections, rejected thenables, and synchronous throws from thunks
 * are captured as `Left<Rejected>`.
 */
export type AllInput<E = unknown, A = unknown> =
  | Either<E, A>
  | PromiseLike<Either<E, A>>
  | (() => Either<E, A> | PromiseLike<Either<E, A>>)

type AwaitedAllInput<T> = T extends () => infer R ? Awaited<R> : Awaited<T>

/** Extracts the error type from an {@link AllInput}. */
export type AllError<T> = InferE<AwaitedAllInput<T>>

/** Extracts the success type from an {@link AllInput}. */
export type AllValue<T> = InferA<AwaitedAllInput<T>>

/** Tuple of success values produced by {@link all}. */
export type AllValues<T extends readonly unknown[]> = {
  -readonly [K in keyof T]: AllValue<T[K]>
}

type IsAsyncAllInput<T> = T extends () => infer R
  ? R extends PromiseLike<unknown>
    ? true
    : false
  : T extends PromiseLike<unknown>
    ? true
    : false

type HasAsyncAllInput<T extends readonly unknown[]> = true extends {
  [K in keyof T]: IsAsyncAllInput<T[K]>
}[number]
  ? true
  : false

type CanRejectAllInput<T> = T extends PromiseLike<unknown> | (() => unknown)
  ? true
  : false

type HasRejectableAllInput<T extends readonly unknown[]> = true extends {
  [K in keyof T]: CanRejectAllInput<T[K]>
}[number]
  ? true
  : false

type AllResultError<T extends readonly unknown[]> =
  | AllError<T[number]>
  | (HasRejectableAllInput<T> extends true ? Rejected : never)

/** Return type produced by {@link all}. */
export type AllResult<T extends readonly AllInput<any, any>[]> =
  HasAsyncAllInput<T> extends true
    ? Promise<Either<AllResultError<T>, AllValues<T>>>
    : Either<AllResultError<T>, AllValues<T>>

/** Return type produced by {@link collectAll}. */
export type CollectAllResult<T extends readonly AllInput<any, any>[]> =
  HasAsyncAllInput<T> extends true
    ? Promise<Collected<AllResultError<T>, AllValue<T[number]>>>
    : Collected<AllResultError<T>, AllValue<T[number]>>

/**
 * Runs `Either` values and `Promise<Either>` values together, returning the
 * first `Left` by input order or all success values as a tuple.
 *
 * Async inputs are observed concurrently with `Promise.all`. Promise rejections
 * and synchronous throws from thunk inputs are captured as `Left<Rejected>`.
 *
 * @param inputs - Eithers, promises of Eithers, or thunks that produce them.
 *
 * @example
 * ```ts
 * const result = await either(async function* () {
 *   const [user, settings] = yield* await all([
 *     fetchUser(id),
 *     fetchSettings(id),
 *   ])
 *
 *   return { user, settings }
 * })
 * ```
 */
export function all<const T extends readonly AllInput<any, any>[]>(
  inputs: T,
): AllResult<T> {
  const settled: (Either<any, any> | Promise<Either<any, any>>)[] = []
  settled.length = inputs.length
  let hasAsync = false

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index] as AllInput<any, any>
    const value = settleAllInput(input)
    settled[index] = value
    if (isPromiseLike(value)) hasAsync = true
  }

  if (hasAsync) {
    return Promise.all(settled as readonly Promise<Either<any, any>>[]).then(
      finishAll,
    ) as AllResult<T>
  }

  return finishAll(settled as Either<any, any>[]) as AllResult<T>
}

/**
 * Runs `Either` values and `Promise<Either>` values together, partitioning all
 * successes and failures without short-circuiting.
 *
 * Async inputs are observed concurrently with `Promise.all`. Promise rejections
 * and synchronous throws from thunk inputs are captured as `Rejected` errors.
 *
 * @param inputs - Eithers, promises of Eithers, or thunks that produce them.
 */
export function collectAll<const T extends readonly AllInput<any, any>[]>(
  inputs: T,
): CollectAllResult<T> {
  const settled: (Either<any, any> | Promise<Either<any, any>>)[] = []
  settled.length = inputs.length
  let hasAsync = false

  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index] as AllInput<any, any>
    const value = settleAllInput(input)
    settled[index] = value
    if (isPromiseLike(value)) hasAsync = true
  }

  if (hasAsync) {
    return Promise.all(settled as readonly Promise<Either<any, any>>[]).then(
      finishCollectAll,
    ) as CollectAllResult<T>
  }

  return finishCollectAll(settled as Either<any, any>[]) as CollectAllResult<T>
}

function settleAllInput(
  input: AllInput<any, any>,
): Either<any, any> | Promise<Either<any, any>> {
  try {
    const value = typeof input === 'function' ? input() : input
    if (isPromiseLike(value)) {
      return Promise.resolve(value).then(undefined, toRejectedLeft)
    }
    return value
  } catch (cause) {
    return toRejectedLeft(cause)
  }
}

function finishAll(results: readonly Either<any, any>[]): Either<any, any[]> {
  for (let index = 0; index < results.length; index++) {
    const result = results[index] as Either<any, any>
    if (result._tag === 'Left') return result
  }

  const values: any[] = []
  values.length = results.length
  for (let index = 0; index < results.length; index++) {
    values[index] = (results[index] as Right<any>).value
  }
  return right(values)
}

function finishCollectAll(
  results: readonly Either<any, any>[],
): Collected<any, any> {
  const errors: any[] = []
  const values: any[] = []

  for (let index = 0; index < results.length; index++) {
    const result = results[index] as Either<any, any>
    if (result._tag === 'Left') errors.push(result.error)
    else values.push(result.value)
  }

  return { errors, values }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  )
}

/**
 * Returns `Right<void>` when `cond` is `true`, otherwise calls `onFail` and
 * returns its result as `Left<E>`.
 *
 * @param cond - The condition to assert.
 * @param onFail - Produces the error value when the condition is false.
 */
export function ensure<const E>(
  cond: boolean,
  onFail: () => E,
): Either<E, void> {
  return cond ? RIGHT_VOID : left(onFail())
}

/**
 * Returns `Right<A>` when `value` is non-nullish, otherwise calls `onNull`
 * and returns its result as `Left<E>`.
 *
 * @param value - The potentially nullish value.
 * @param onNull - Produces the error value when `value` is `null` or `undefined`.
 */
export function ensureNotNull<A, const E>(
  value: A | null | undefined,
  onNull: () => E,
): Either<E, A> {
  return value != null ? right(value) : left(onNull())
}
