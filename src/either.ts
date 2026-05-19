/**
 * A value that is either an error `Left<E>` or a success `Right<A>`.
 * @typeParam E - The error type.
 * @typeParam A - The success type.
 */
export type Either<E, A> = Left<E> | Right<A>

class LeftIterator<E> implements Iterator<Left<E>, never, unknown> {
  private left: Left<E> | undefined

  constructor(left: Left<E>) {
    this.left = left
  }

  next(): IteratorResult<Left<E>, never> {
    const left = this.left
    if (left === undefined) {
      throw new Error('Unreachable: Left yielded but generator continued')
    }
    this.left = undefined
    return { value: left, done: false }
  }

  return(value: never): IteratorReturnResult<never> {
    this.left = undefined
    return { value, done: true }
  }

  throw(e: unknown): IteratorResult<Left<E>, never> {
    this.left = undefined
    throw e
  }

  [Symbol.iterator](): Iterator<Left<E>, never, unknown> {
    return this
  }
}

/**
 * The error branch of an {@link Either}. Yielding a `Left` from a generator
 * short-circuits the computation; returning one propagates the error through
 * the finish handler of the active {@link Strategy}.
 *
 * @typeParam E - The error type.
 */
export class Left<E> {
  readonly _tag = 'Left' as const
  readonly error: E

  constructor(error: E) {
    this.error = error
  }

  [Symbol.iterator](): Iterator<Left<E>, never, unknown> {
    return new LeftIterator(this)
  }

  get [Symbol.toStringTag]() {
    return 'Either.Left'
  }

  toJSON(): { _tag: 'Left'; error: E } {
    return { _tag: 'Left', error: this.error }
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default') {
    return hint === 'string' ? String(this.error) : Number.NaN
  }
}

/**
 * The success branch of an {@link Either}.
 *
 * @typeParam A - The success type.
 */
export class Right<A> {
  readonly _tag = 'Right' as const
  readonly value: A

  constructor(value: A) {
    this.value = value
  }

  [Symbol.iterator](): Iterator<never, A, unknown> {
    return this
  }

  // A Right never yields, so it can be its own completed iterator.
  next(): IteratorReturnResult<A> {
    return { value: this.value, done: true }
  }

  get [Symbol.toStringTag]() {
    return 'Either.Right'
  }

  toJSON(): { _tag: 'Right'; value: A } {
    return { _tag: 'Right', value: this.value }
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default') {
    return hint === 'string' ? String(this.value) : this.value
  }
}

/**
 * Constructs a {@link Left} (error) value.
 * @param e - The error.
 */
export function left<E>(e: E): Left<E> {
  return new Left(e)
}

/**
 * Constructs a {@link Right} (success) value.
 * @param a - The success value.
 */
export function right<A>(a: A): Right<A> {
  return new Right(a)
}

/**
 * Extracts the error type `E` from a `Left<E>`, or `never` for any other type.
 * @typeParam T - A type to inspect.
 */
export type InferE<T> = T extends Left<infer E> ? E : never

/**
 * Extracts the success type `A` from a `Right<A>`, or `never` for any other type.
 * @typeParam T - A type to inspect.
 */
export type InferA<T> = T extends Right<infer A> ? A : never

/**
 * Narrows an `Either<E, A>` to `Left<E>`.
 * @param value - The value to test.
 */
export function isLeft<E, A>(value: Either<E, A>): value is Left<E> {
  return value._tag === 'Left'
}

/**
 * Narrows an `Either<E, A>` to `Right<A>`.
 * @param value - The value to test.
 */
export function isRight<E, A>(value: Either<E, A>): value is Right<A> {
  return value._tag === 'Right'
}

/**
 * Narrows an arbitrary return value `T` to `Extract<T, Left<any>>`.
 *
 * Used by strategy `finish` handlers to detect when a generator returns a
 * `Left` directly rather than yielding it. This is necessary because a generator's
 * return type is not constrained to `Either`.
 *
 * @param value - The value to test.
 */
export function isLeftReturn<T>(value: T): value is Extract<T, Left<any>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    '_tag' in value &&
    value._tag === 'Left'
  )
}
