import { type Either, Left, left, right } from '#/either'

/**
 * Represents a `Promise` rejection captured as a typed `Left` value.
 * Produced by {@link raise} when passed a rejected `Promise`.
 */
export type Rejected = { readonly _tag: 'Rejected'; readonly cause: unknown }

/**
 * Constructs a {@link Rejected} value from an arbitrary thrown cause.
 * @param cause - The value thrown by the rejected promise.
 */
export const rejected = (cause: unknown): Rejected => ({
  _tag: 'Rejected',
  cause,
})

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
    return Promise.try(x as () => unknown).then(right, (e) => left(rejected(e)))
  }

  if (typeof x === 'object' && x !== null) {
    let then: unknown
    try {
      then = (x as { readonly then?: unknown }).then
    } catch {
      return Promise.try(() => x).then(right, (e) => left(rejected(e)))
    }

    if (typeof then === 'function') {
      return Promise.try(() => x).then(right, (e) => left(rejected(e)))
    }
  }

  return left(x)
}

export type Raise = typeof raise
