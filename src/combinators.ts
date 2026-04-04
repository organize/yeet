import { type Raise, raise } from '#/async'
import {
  Left,
  type Either,
  type InferE,
  type InferA,
  left,
  right,
} from '#/either'
import { type Step, fold } from '#/fold'

// The async path must be a named function because async functions cannot
// be inlined into a synchronous call stack.
async function eitherAsync<Eff extends Either<any, any>, Ret>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
): Promise<Either<any, any>> {
  let next = await gen.next()
  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') return eff
    next = await gen.next(eff.value)
  }
  const ret = next.value
  return ret instanceof Left ? ret : right(ret)
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
 * - `yield* await raise(promise)`: converts a raw `Promise<T>` rejection into
 *   `Left<Rejected>` so it can be short-circuited safely.
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
): Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>

export function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: Raise) => AsyncGenerator<Eff, Ret>,
): Promise<Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>>

export function either<Eff extends Either<any, any>, Ret>(
  fn: (
    raise: Raise,
  ) => Generator<Eff, Ret, unknown> | AsyncGenerator<Eff, Ret, unknown>,
): Either<any, any> | Promise<Either<any, any>> {
  const gen = fn(raise)
  if (Symbol.asyncIterator in gen) {
    return eitherAsync(gen)
  }
  let next = gen.next()
  while (!next.done) {
    const eff = next.value
    if (eff._tag === 'Left') return eff
    next = gen.next(eff.value)
  }
  const ret = next.value
  return ret instanceof Left ? ret : right(ret)
}

// ---------------------------------------------------------------------------
// Shared hoisted step/finish functions.
//
// Declared at module scope so every fold call reuses the same function
// references — no closures allocated per call.
// ---------------------------------------------------------------------------

function _validateStep<Eff extends Either<any, any>>(
  eff: Eff,
  acc: InferE<Eff>[],
): Step<InferE<Eff>[], never> {
  if (eff._tag === 'Left') acc.push(eff.error)
  return { done: false, send: undefined, acc }
}

function _firstOfStep<Eff extends Either<any, any>>(
  eff: Eff,
  acc: InferE<Eff>[],
): Step<InferE<Eff>[], Either<InferE<Eff>[], InferA<Eff>>> {
  if (eff._tag === 'Right') return { done: true, result: right(eff.value) }
  acc.push(eff.error)
  return { done: false, send: undefined, acc }
}

function _collectStep<Eff extends Either<any, any>>(
  eff: Eff,
  acc: Collected<InferE<Eff>, InferA<Eff>>,
): Step<Collected<InferE<Eff>, InferA<Eff>>, never> {
  if (eff._tag === 'Left') acc.errors.push(eff.error)
  else acc.values.push(eff.value)
  return { done: false, send: undefined, acc }
}

// validate and firstOf generators do not use `return raise()`, so Ret is
// always the plain success type — no Exclude needed here.
function _accFinish<E, Ret>(ret: Ret, acc: E[]): Either<E[], Ret> {
  return acc.length > 0 ? left(acc) : right(ret)
}

function _collectFinish<E, A>(
  _ret: void,
  acc: Collected<E, A>,
): Collected<E, A> {
  return acc
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
  return fold(() => fn(check), {
    init: (): InferE<Eff>[] => [],
    step: _validateStep<Eff>,
    finish: _accFinish<InferE<Eff>, Ret>,
  })
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
  // R is provided explicitly because step short-circuits with Right<InferA<Eff>>
  // while finish returns Either<E[], Ret>; TypeScript cannot unify these on its
  // own without the explicit annotation.
  type R = Either<InferE<Eff>[], InferA<Eff> | Ret>
  return fold<Eff, Ret, InferE<Eff>[], R>(fn, {
    init: (): InferE<Eff>[] => [],
    step: _firstOfStep<Eff>,
    finish: _accFinish<InferE<Eff>, Ret>,
  })
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
  return fold(fn, {
    init: (): Collected<InferE<Eff>, InferA<Eff>> => ({
      errors: [],
      values: [],
    }),
    step: _collectStep<Eff>,
    finish: _collectFinish<InferE<Eff>, InferA<Eff>>,
  })
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
  return cond ? right(undefined) : left(onFail())
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
