import {
  type Aborted,
  type AbortRaise,
  type Raise,
  type Rejected,
  aborted,
  raise,
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
): Promise<Either<any, any>> {
  let next = await gen.next()
  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') {
      await closeAsyncGenerator(gen)
      return eff
    }
    next = await gen.next(eff.value)
  }
  return finishEither(next.value)
}

type AbortState = {
  readonly signal: AbortSignal
  readonly promise: Promise<Left<Aborted>>
  readonly result: () => Left<Aborted>
  readonly cleanup: () => void
}

type AbortableNext<Eff, Ret> = IteratorResult<Eff, Ret> | Left<Aborted>

async function eitherAsyncAbortable<Eff extends Either<any, any>, Ret>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  signal: AbortSignal,
): Promise<Either<any, any>> {
  const abort = createAbortState(signal)
  try {
    let next = await nextOrAbort(gen, undefined, false, abort)
    while (!isAbortResult(next) && !next.done) {
      const eff = next.value
      if (eff._tag === 'Left') {
        await closeAsyncGenerator(gen)
        return eff
      }
      next = await nextOrAbort(gen, eff.value, true, abort)
    }

    if (isAbortResult(next)) {
      await closeAsyncGenerator(gen)
      return next
    }

    return finishEither(next.value)
  } finally {
    abort.cleanup()
  }
}

function createAbortState(signal: AbortSignal): AbortState {
  const { promise, resolve } = Promise.withResolvers<Left<Aborted>>()
  const result = () => left(aborted(signal.reason))
  const onAbort = () => resolve(result())

  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  return {
    signal,
    promise,
    result,
    cleanup: () => signal.removeEventListener('abort', onAbort),
  }
}

async function nextOrAbort<Eff extends Either<any, any>, Ret>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  value: unknown,
  hasValue: boolean,
  abort: AbortState,
): Promise<AbortableNext<Eff, Ret>> {
  if (abort.signal.aborted) return abort.result()

  const next = hasValue ? gen.next(value) : gen.next()
  return Promise.race([next, abort.promise])
}

function isAbortResult<Eff, Ret>(
  result: AbortableNext<Eff, Ret>,
): result is Left<Aborted> {
  return !('done' in result)
}

function closeSyncGenerator(gen: Generator<any, any, unknown>): void {
  gen.return(undefined)
}

async function closeAsyncGenerator(
  gen: AsyncGenerator<any, any, unknown>,
): Promise<void> {
  await gen.return(undefined)
}

/**
 * Runs a generator as an `Either` computation, short-circuiting on the first
 * `Left` that is yielded or returned.
 *
 * Accepts both synchronous and asynchronous generators. When an async generator
 * is provided the return type is `Promise<Either<...>>`.
 *
 * The `raise` parameter injected into the generator serves two roles:
 * - `return raise(error)`: short-circuits with `Left<E>`. TypeScript narrows
 *   control flow correctly — code after the `return` is unreachable, and
 *   guarded values (e.g. `if (!x) return raise(e)`) are narrowed on the happy
 *   path without requiring non-null assertions.
 * - `yield* await raise(fn)` / `yield* await raise(promise)`: converts thrown
 *   exceptions and rejected promises into `Left<Rejected>` so they can be
 *   short-circuited safely.
 *
 * @param fn - A function that receives `raise` and returns a generator.
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
  fn: (raise: Raise) => Generator<Eff, Ret>,
): Either<
  InferE<Eff> | InferE<Extract<Ret, Left<any>>>,
  Exclude<Ret, Left<any>>
>

export function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: Raise) => AsyncGenerator<Eff, Ret>,
): Promise<
  Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>
>

export function either<Eff extends Either<any, any>, Ret>(
  signal: AbortSignal,
  fn: (raise: AbortRaise, signal: AbortSignal) => AsyncGenerator<Eff, Ret>,
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
        raise: Raise,
      ) => Generator<Eff, Ret, unknown> | AsyncGenerator<Eff, Ret, unknown>),
  fn?: (
    raise: AbortRaise,
    signal: AbortSignal,
  ) => AsyncGenerator<Eff, Ret, unknown>,
): Either<any, any> | Promise<Either<any, any>> {
  if (typeof signalOrFn !== 'function') {
    const gen = fn?.(raiseWithSignal(signalOrFn), signalOrFn)
    if (gen === undefined) {
      throw new TypeError('either(signal, fn) requires an async generator')
    }
    return eitherAsyncAbortable(gen, signalOrFn)
  }

  const gen = signalOrFn(raise)
  if (Symbol.asyncIterator in gen) {
    return eitherAsync(gen)
  }

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
}

function raiseWithSignal(signal: AbortSignal): AbortRaise {
  // eslint-disable-next-line promise-function-async
  const scopedRaise = ((x: unknown) => raise(x as never)) as Raise
  return Object.assign(scopedRaise, { signal })
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
