import {
  type Either,
  type InferA,
  type InferE,
  Left,
  type Right,
  left,
  right,
} from './either.ts'

/**
 * Represents a `Promise` rejection captured as a typed `Left` value.
 * Produced by {@link raise} when passed a rejected `Promise`.
 */
export type Rejected<Cause = unknown> = {
  readonly _tag: 'Rejected'
  readonly cause: Cause
}

/**
 * Constructs a {@link Rejected} value from an arbitrary thrown cause.
 * @param cause - The value thrown by the rejected promise.
 */
export const rejected = <const Cause>(cause: Cause): Rejected<Cause> => ({
  _tag: 'Rejected',
  cause,
})

export const toRejectedLeft = (cause: unknown): Left<Rejected> =>
  left(rejected(cause))

/**
 * Represents an outcome where the primary failure is preserved, but cleanup or
 * sibling teardown also failed while the scope was unwinding.
 */
export type Suppressed<Error = unknown, SuppressedError = unknown> = {
  readonly _tag: 'Suppressed'
  readonly error: Error
  readonly suppressed: readonly SuppressedError[]
}

/**
 * Constructs a {@link Suppressed} value.
 * @param error - The primary failure that decided the outcome.
 * @param suppressed - Secondary failures observed while unwinding.
 */
export const suppressed = <const Error, const SuppressedError>(
  error: Error,
  suppressed: readonly SuppressedError[],
): Suppressed<Error, SuppressedError> => ({
  _tag: 'Suppressed',
  error,
  suppressed,
})

/**
 * The cancellation reason used when a scoped race has a `Right` winner and
 * aborts its losing sibling tasks.
 */
export type SiblingSettled = {
  readonly _tag: 'SiblingSettled'
}

const SIBLING_SETTLED: SiblingSettled = { _tag: 'SiblingSettled' }

/**
 * Returns the singleton {@link SiblingSettled} cancellation reason.
 */
export const siblingSettled = (): SiblingSettled => SIBLING_SETTLED

/**
 * Represents an `AbortSignal` cancellation captured as a typed `Left` value.
 * Produced by `either(signal, async function* () { ... })` when the signal
 * aborts while the async generator is running.
 */
export type Aborted<Reason = unknown> = {
  readonly _tag: 'Aborted'
  readonly reason: Reason
}

/**
 * Constructs an {@link Aborted} value from an `AbortSignal` reason.
 * @param reason - The value carried by `signal.reason`.
 */
export const aborted = <const Reason>(reason: Reason): Aborted<Reason> => ({
  _tag: 'Aborted',
  reason,
})

/**
 * The failure surface of a scoped yeet computation.
 *
 * Domain errors stay as-is, while thrown/rejected work is represented as
 * `Rejected` and cooperative cancellation is represented as `Aborted`.
 */
export type ExitError<E = never, Reason = unknown, Cause = unknown> =
  | E
  | Aborted<Reason>
  | Rejected<Cause>
  | Suppressed<
      | E
      | Aborted<Reason>
      | Rejected<Cause>
      | Suppressed<unknown, Rejected<Cause>>,
      Rejected<Cause>
    >

/**
 * A typed outcome for scoped async work.
 */
export type Exit<
  E = never,
  A = void,
  Reason = unknown,
  Cause = unknown,
> = Either<ExitError<E, Reason, Cause>, A>

/**
 * Polymorphic error injection for use inside `either` generators.
 *
 * - **`raise(promise)`**: wraps a `PromiseLike<T>` into
 *   `Promise<Either<Rejected, T>>`, catching rejections as `Left<Rejected>`.
 * - **`raise(fn)`**: calls a sync or async function with `Promise.try`, wrapping
 *   thrown exceptions and rejected promises as `Left<Rejected>`.
 *   Use with `yield* await raise(promise)` when you already have a promise, or
 *   `yield* await raise(fn)` when starting the operation can throw
 *   synchronously.
 * - **`raise(error)`**: wraps any value into a `Left<E>` for use as a
 *   short-circuiting return: `return raise("MyError")`.
 *
 * The callable and `PromiseLike` overloads must be declared first so that
 * TypeScript resolves them before the generic `Left<E>` overload.
 *
 * @param fn - A function whose thrown or rejected cause should be captured.
 */
export function raise<T>(
  fn: () => T | PromiseLike<T>,
): Promise<Either<Rejected, Awaited<T>>>

/**
 * @param p - A promise-like value whose rejection should be captured.
 */
export function raise<T>(p: PromiseLike<T>): Promise<Either<Rejected, T>>

/**
 * @param e - An error value to wrap as `Left<E>`.
 */
export function raise<const E>(e: E): Left<E>
export function raise(
  x: unknown,
): Promise<Either<Rejected, unknown>> | Left<any> {
  if (typeof x === 'function') {
    return Promise.try(x as () => unknown).then(right, toRejectedLeft)
  }

  if (typeof x === 'object' && x !== null) {
    let then: unknown
    try {
      then = (x as { readonly then?: unknown }).then
    } catch {
      return Promise.try(() => x).then(right, toRejectedLeft)
    }

    if (typeof then === 'function') {
      return Promise.try(() => x).then(right, toRejectedLeft)
    }
  }

  return left(x)
}

export type Raise = typeof raise

/**
 * A child task started by {@link ScopeSignal.fork}.
 *
 * The task receives a child signal that aborts with the enclosing async
 * `either` scope.
 */
export type ScopeTask<E, A> = (
  signal: ScopeSignal,
) => Either<E, A> | PromiseLike<Either<E, A>>

type AwaitedScopeTask<T> = T extends (signal: ScopeSignal) => infer R
  ? Awaited<R>
  : never

/** Extracts the domain error type from a scoped task. */
export type ScopeTaskError<T> = InferE<AwaitedScopeTask<T>>

/** Extracts the success value type from a scoped task. */
export type ScopeTaskValue<T> = InferA<AwaitedScopeTask<T>>

/** Tuple of success values produced by {@link ScopeSignal.forkAll}. */
export type ScopeTaskValues<T extends readonly ScopeTask<any, any>[]> = {
  -readonly [K in keyof T]: ScopeTaskValue<T[K]>
}

/** Position-preserving failures produced when every `forkFirst` task fails. */
export type ScopeTaskErrors<T extends readonly ScopeTask<any, any>[]> = {
  -readonly [K in keyof T]: ExitError<ScopeTaskError<T[K]>>
}

/**
 * An `AbortSignal` enriched with scoped child work for async `either` flows.
 */
export type ScopeSignal = AbortSignal & {
  fork<A>(
    task: (signal: ScopeSignal) => Right<A> | PromiseLike<Right<A>>,
  ): Promise<Exit<never, A>>
  fork<E>(
    task: (signal: ScopeSignal) => Left<E> | PromiseLike<Left<E>>,
  ): Promise<Exit<E, never>>
  fork<E, A>(task: ScopeTask<E, A>): Promise<Exit<E, A>>
  forkAll<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskError<T[number]>, ScopeTaskValues<T>>>
  forkFirst<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskErrors<T>, ScopeTaskValue<T[number]>>>
  forkRace<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskError<T[number]>, ScopeTaskValue<T[number]>>>
}

/**
 * The first parameter injected into `either` generators.
 *
 * It is callable like {@link raise}, exposes `raise` for destructuring, and
 * lazily exposes a scoped signal in async flows.
 */
export type RaiseContext = Raise & {
  readonly raise: Raise
  readonly signal: ScopeSignal
}

/**
 * Backwards-compatible name for the abort-aware `either` context.
 */
export type AbortRaise = RaiseContext
