import {
  type Aborted,
  type AbortRaise,
  type Exit,
  type RaiseContext,
  type Rejected,
  type ScopeSignal,
  type ScopeTask,
  aborted,
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
  type Left,
  type Right,
  left,
  right,
} from './either.ts'

const RIGHT_VOID = right(undefined) as Right<void>

type MaybeLeft = { readonly _tag?: unknown }

function finishEither(ret: unknown): Either<any, any> {
  return ret !== null &&
    typeof ret === 'object' &&
    (ret as MaybeLeft)._tag === 'Left'
    ? (ret as unknown as Left<any>)
    : right(ret)
}

function eitherSyncContinue<Eff extends Either<any, any>, Ret>(
  gen: Generator<Eff, Ret, unknown>,
  value: unknown,
): Either<any, any> {
  let next = gen.next(value)
  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') {
      closeSyncGenerator(gen)
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
  try {
    let value: unknown
    let hasValue = false

    while (true) {
      const step = await nextOrScope(gen, value, hasValue, scope)
      const next = step.result
      if (isScopeFailure(next)) {
        await closeAsyncGenerator(gen, step.pending)
        result = next
        break
      }

      if (next.done) {
        result = finishEither(next.value)
        break
      }

      const eff = next.value
      if (eff._tag === 'Left') {
        await closeAsyncGenerator(gen)
        result = eff
        break
      }
      value = eff.value
      hasValue = true
    }
  } finally {
    const closeFailure = await closeScope(scope)
    if (closeFailure !== undefined && closeFailure !== result) {
      result =
        result?._tag === 'Left'
          ? withSuppressed(result, cleanupFailuresFromLeft(closeFailure))
          : closeFailure
    }
  }

  return result
}

type ScopeStep<Eff, Ret> = {
  readonly result: IteratorResult<Eff, Ret> | Left<any>
  readonly pending?: Promise<IteratorResult<Eff, Ret>>
}

type ScopeRuntime = {
  readonly failure: Promise<Left<any>>
  readonly signal: ScopeSignal
  readonly enableFork: () => void
  readonly abort: (reason?: unknown) => void
  readonly close: () => Promise<Left<any> | undefined>
  readonly fail: (failure: Left<any>, reason?: unknown) => void
  readonly currentFailure: () => Left<any> | undefined
}

type ScopedTaskHandle<E, A> = {
  readonly promise: Promise<Exit<E, A>>
  readonly abort: (reason?: unknown) => void
}

type ScopeSource = ScopeRuntime | RaiseContextHandle

type RaiseContextHandle = {
  readonly context: RaiseContext
  readonly enableFork: () => void
  readonly ensureScope: () => ScopeRuntime
  readonly peekScope: () => ScopeRuntime | undefined
}

function createScopeRuntime(parent?: AbortSignal): ScopeRuntime {
  const controller = new AbortController()
  const { promise, resolve } = Promise.withResolvers<Left<any>>()
  const children = new Set<Promise<Either<any, any>>>()
  const lateCleanupFailures: Rejected[] = []
  let failure: Left<any> | undefined
  let closed = false
  let closing = false
  let forkEnabled = false
  let parentCleanup: (() => void) | undefined

  const fail = (nextFailure: Left<any>, reason = nextFailure.error): void => {
    if (failure !== undefined || closing) return
    failure = nextFailure
    resolve(nextFailure)
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

  const signal = controller.signal as ScopeSignal
  Object.defineProperties(signal, {
    fork: {
      configurable: true,
      // oxlint-disable-next-line typescript/promise-function-async
      value: <E, A>(task: ScopeTask<E, A>) => forkScopedTask(scope, task),
    },
    forkAll: {
      configurable: true,
      // oxlint-disable-next-line typescript/promise-function-async
      value: <const T extends readonly ScopeTask<any, any>[]>(tasks: T) =>
        forkAllScopedTasks(scope, tasks),
    },
    forkRace: {
      configurable: true,
      // oxlint-disable-next-line typescript/promise-function-async
      value: <const T extends readonly ScopeTask<any, any>[]>(tasks: T) =>
        forkRaceScopedTasks(scope, tasks),
    },
  })

  const scope = {
    failure: promise,
    signal,
    enableFork() {
      forkEnabled = true
    },
    abort(reason?: unknown) {
      if (!controller.signal.aborted) controller.abort(reason)
    },
    close: async () => {
      if (closed) return
      closed = true
      closing = true
      parentCleanup?.()
      if (children.size > 0 && !controller.signal.aborted) {
        controller.abort(new DOMException('Scope closed', 'AbortError'))
      }
      if (children.size === 0)
        return leftFromCleanupFailures(lateCleanupFailures, failure)

      const settled = await Promise.allSettled(children)
      return leftFromCleanupFailures(
        [
          ...lateCleanupFailures,
          ...cleanupFailuresFromSettledChildren(settled),
        ],
        failure,
      )
    },
    fail,
    currentFailure: () => failure,
  } as const satisfies ScopeRuntime

  // oxlint-disable-next-line typescript/promise-function-async
  function forkScopedTask<E, A>(
    owner: ScopeRuntime,
    task: ScopeTask<E, A>,
  ): Promise<Exit<E, A>> {
    ensureForkEnabled('fork')
    const existing = failure
    if (existing !== undefined) {
      return Promise.resolve(existing as Exit<E, A>)
    }

    const child = startScopedTask(owner, task)
    return child.promise.then((result) => {
      if (result._tag === 'Left') {
        if (owner.currentFailure() === undefined) owner.fail(result)
      }
      return result
    })
  }

  // oxlint-disable-next-line typescript/promise-function-async
  function forkAllScopedTasks<const T extends readonly ScopeTask<any, any>[]>(
    owner: ScopeRuntime,
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
        const handle = startScopedTask(
          owner,
          tasks[index] as ScopeTask<any, any>,
        )
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
            owner.fail(finalResult)
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
  function forkRaceScopedTasks<const T extends readonly ScopeTask<any, any>[]>(
    owner: ScopeRuntime,
    tasks: T,
  ): Promise<Exit<any, any>> {
    ensureForkEnabled('forkRace')

    const existing = failure
    if (existing !== undefined) return Promise.resolve(existing)
    if (tasks.length === 0) {
      const result = toRejectedLeft(
        new TypeError('signal.forkRace() requires at least one task'),
      )
      owner.fail(result)
      return Promise.resolve(result)
    }

    const handles: (ScopedTaskHandle<any, any> | undefined)[] = []
    handles.length = tasks.length

    let settled = false

    return new Promise((resolve) => {
      for (let index = 0; index < tasks.length; index++) {
        const handle = startScopedTask(
          owner,
          tasks[index] as ScopeTask<any, any>,
        )
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
            owner.fail(finalResult)
            resolve(finalResult)
            return
          }

          resolve(result)
        })
      }
    })
  }

  function startScopedTask<E, A>(
    owner: ScopeRuntime,
    task: ScopeTask<E, A>,
  ): ScopedTaskHandle<E, A> {
    if (closed) {
      const result = left(aborted(controller.signal.reason)) as Exit<E, A>
      return {
        promise: Promise.resolve(result),
        abort: () => {},
      }
    }

    const childScope = createScopeRuntime(owner.signal)
    childScope.enableFork()
    const existing = childScope.currentFailure()
    if (existing !== undefined) {
      return {
        promise: Promise.resolve(existing as Exit<E, A>),
        abort: childScope.abort,
      }
    }

    const childPromise = runScopedTask(childScope, task)

    children.add(childPromise)
    void childPromise.then(
      (result) => {
        recordLateCleanupFailures(result)
        children.delete(childPromise)
      },
      (cause) => {
        recordLateCleanupFailures(toRejectedLeft(cause))
        children.delete(childPromise)
      },
    )

    return {
      promise: childPromise,
      abort: childScope.abort,
    }
  }

  function recordLateCleanupFailures(result: Either<any, any>): void {
    if (closing) return

    const currentFailure = failure
    if (currentFailure === undefined) return

    const cleanupFailures = cleanupFailuresFromResult(result)
    if (cleanupFailures.length > 0) {
      failure = withSuppressed(currentFailure, cleanupFailures)
    }
  }

  function ensureForkEnabled(method: 'fork' | 'forkAll' | 'forkRace'): void {
    if (!forkEnabled) {
      throw new TypeError(
        `signal.${method}() is only available in async either`,
      )
    }
  }

  return scope
}

async function runScopedTask<E, A>(
  childScope: ScopeRuntime,
  task: ScopeTask<E, A>,
): Promise<Exit<E, A>> {
  let result: Exit<E, A>

  try {
    const taskResult = await Promise.try(() => task(childScope.signal))
    result = finishScopedTaskResult(childScope, taskResult as Exit<E, A>)
  } catch (cause) {
    result = finishScopedTaskResult(
      childScope,
      toRejectedLeft(cause) as Exit<E, A>,
    )
  }

  const closeFailure = await childScope.close()
  if (closeFailure === undefined || closeFailure === result) return result

  return (
    result._tag === 'Left'
      ? withSuppressed(result, cleanupFailuresFromLeft(closeFailure))
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

  const cleanupFailures = cleanupFailuresFromLeft(result)
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
): readonly Rejected[] {
  const failures: Rejected[] = []

  for (const result of settled) {
    if (result.status === 'rejected') {
      failures.push(rejected(result.reason))
      continue
    }

    failures.push(...cleanupFailuresFromResult(result.value))
  }

  return failures
}

function cleanupFailuresFromResult(
  result: Either<any, any>,
): readonly Rejected[] {
  return result._tag === 'Left' ? cleanupFailuresFromLeft(result) : []
}

function cleanupFailuresFromLeft(result: Left<any>): readonly Rejected[] {
  return cleanupFailuresFromError(result.error)
}

function cleanupFailuresFromError(error: unknown): readonly Rejected[] {
  if (isRejectedError(error)) return [error]
  if (isSuppressedError(error)) {
    return error.suppressed.flatMap((suppressedError) =>
      cleanupFailuresFromError(suppressedError),
    )
  }

  return []
}

function leftFromCleanupFailures(
  cleanupFailures: readonly Rejected[],
  primary?: Left<any>,
): Left<any> | undefined {
  if (cleanupFailures.length === 0) return primary
  if (primary !== undefined) return withSuppressed(primary, cleanupFailures)

  const [first, ...rest] = cleanupFailures
  if (first === undefined) return undefined
  return rest.length === 0 ? left(first) : left(suppressed(first, rest))
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
  let scope: ScopeRuntime | undefined
  let forkEnabled = false
  const ensureScope = (): ScopeRuntime => {
    if (scope === undefined) {
      scope = createScopeRuntime(parent)
      if (forkEnabled) scope.enableFork()
    }
    return scope
  }

  // oxlint-disable-next-line typescript/promise-function-async
  const context = ((x: unknown) => raise(x as never)) as RaiseContext
  Object.defineProperties(context, {
    raise: { configurable: true, get: () => raise },
    signal: { configurable: true, get: () => ensureScope().signal },
  })

  return {
    context,
    enableFork() {
      forkEnabled = true
      scope?.enableFork()
    },
    ensureScope,
    peekScope: () => scope,
  }
}

async function nextOrScope<Eff extends Either<any, any>, Ret>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  value: unknown,
  hasValue: boolean,
  source: ScopeSource | undefined,
): Promise<ScopeStep<Eff, Ret>> {
  const scope = peekScope(source)
  const failure = scope?.currentFailure()
  if (failure !== undefined) return { result: failure }

  const next = hasValue ? gen.next(value) : gen.next()
  const currentScope = peekScope(source)
  if (currentScope !== undefined) {
    const result = await Promise.race([next, currentScope.failure])
    return isScopeFailure(result) ? { result, pending: next } : { result }
  }

  return { result: await next }
}

function isScopeFailure<Eff, Ret>(
  result: IteratorResult<Eff, Ret> | Left<any>,
): result is Left<any> {
  return !('done' in result)
}

function isRaiseContextHandle(
  source: ScopeSource,
): source is RaiseContextHandle {
  return 'context' in source
}

function peekScope(source: ScopeSource | undefined): ScopeRuntime | undefined {
  if (source === undefined) return undefined
  return isRaiseContextHandle(source) ? source.peekScope() : source
}

async function closeScope(
  source: ScopeSource | undefined,
): Promise<Left<any> | undefined> {
  return await peekScope(source)?.close()
}

function closeSyncGenerator(gen: Generator<any, any, unknown>): void {
  gen.return(undefined)
}

async function closeAsyncGenerator(
  gen: AsyncGenerator<any, any, unknown>,
  pending?: Promise<IteratorResult<any, any>>,
): Promise<void> {
  if (pending !== undefined) await pending
  await gen.return(undefined)
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
  fn: (raise: AbortRaise, signal: ScopeSignal) => AsyncGenerator<Eff, Ret>,
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
    raise: AbortRaise,
    signal: ScopeSignal,
  ) => AsyncGenerator<Eff, Ret, unknown>,
): Either<any, any> | Promise<Either<any, any>> {
  if (typeof signalOrFn !== 'function') {
    const context = createRaiseContext(signalOrFn)
    const scope = context.ensureScope()
    scope.enableFork()
    const gen = fn?.(context.context, scope.signal)
    if (gen === undefined) {
      throw new TypeError('either(signal, fn) requires an async generator')
    }
    return eitherAsync(gen, scope)
  }

  const context = signalOrFn.length === 0 ? undefined : createRaiseContext()
  const gen =
    context === undefined
      ? (
          signalOrFn as () =>
            | Generator<Eff, Ret, unknown>
            | AsyncGenerator<Eff, Ret, unknown>
        )()
      : signalOrFn(context.context)
  if (Symbol.asyncIterator in gen) {
    context?.enableFork()
    return eitherAsync(gen, context)
  }

  try {
    const next = gen.next()
    if (!next.done) {
      const eff = next.value
      if (eff._tag === 'Left') {
        closeSyncGenerator(gen)
        return eff
      }
      return eitherSyncContinue(gen, eff.value)
    }

    return finishEither(next.value)
  } finally {
    const scope = context?.peekScope()
    if (scope !== undefined) void scope.close()
  }
}

/**
 * Captures an {@link Either} as a normal value inside {@link either}, preventing
 * a `Left` from short-circuiting until the caller decides what to do with it.
 *
 * Useful for retries, fallbacks, logging, or selectively re-raising errors with
 * ordinary JavaScript control flow.
 *
 * @param e - The `Either` value to capture.
 *
 * @example
 * ```ts
 * const result = either(function* (raise) {
 *   const cached = yield* capture(getFromCache(key))
 *   if (cached._tag === "Right") return cached.value
 *
 *   if (cached.error !== "CacheMiss") return raise(cached.error)
 *   return yield* getFromDatabase(key)
 * })
 * ```
 */
export function capture<E, A>(e: Either<E, A>): Right<Either<E, A>> {
  return right(e)
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
export function* check<E, A>(
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
      closeSyncGenerator(gen)
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
