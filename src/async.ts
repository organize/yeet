import { type Either, left, right } from '#/either'

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
 * - **`raise(promise)`**: wraps a `Promise<T>` into
 *   `Promise<Either<Rejected, T>>`, catching rejections as `Left<Rejected>`.
 *   Use with `yield* await raise(promise)` to safely unwrap async operations.
 * - **`raise(error)`**: wraps any value into a `Left<E>` for use as a
 *   short-circuiting return: `return raise("MyError")`.
 *
 * The `Promise` overload must be declared first so that TypeScript resolves it
 * before the generic `Left<E>` overload when a `Promise` is passed.
 *
 * @param p - A promise whose rejection should be captured.
 */
export function raise<T>(p: Promise<T>): Promise<Either<Rejected, T>>
/**
 * @param e - An error value to wrap as `Left<E>`.
 */
export function raise<const E>(e: E): import('./either').Left<E>
export function raise(
  x: unknown,
): Promise<Either<Rejected, unknown>> | import('./either').Left<any> {
  if (x instanceof Promise) {
    return x.then(right, (e) => left(rejected(e)))
  }
  return left(x)
}

export type Raise = typeof raise
