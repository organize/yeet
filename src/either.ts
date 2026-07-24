/**
 * A value that is either an error `Left<E>` or a success `Right<A>`.
 * @typeParam E - The error type.
 * @typeParam A - The success type.
 */
export type Either<E, A> = Left<E> | Right<A>

/** A plain JSON-friendly fallback for native `Error` values. */
export type SerializedError = {
  readonly name: string
  readonly message: string
  readonly cause?: unknown
  readonly [key: string]: unknown
}

/** The JSON payload representation of a value. */
export type SerializedPayload<T> = T extends { toJSON(): infer J }
  ? J
  : T extends Error
    ? SerializedError
    : T

/** The JSON representation of a {@link Left}. */
export type SerializedLeft<out E> = {
  readonly _tag: 'Left'
  readonly error: E
}

/** The JSON representation of a {@link Right}. */
export type SerializedRight<out A> = {
  readonly _tag: 'Right'
  readonly value: A
}

/** The JSON representation of an {@link Either}. */
export type SerializedEither<E, A> = SerializedLeft<E> | SerializedRight<A>

type ToJSONLike = {
  toJSON(): unknown
}

type SerializedEitherCandidate = {
  readonly _tag?: unknown
  readonly error?: unknown
  readonly value?: unknown
}

class LeftIterator<E> implements Iterator<Left<E>, never, unknown> {
  #left: Left<E> | undefined

  constructor(left: Left<E>) {
    this.#left = left
  }

  next(): IteratorResult<Left<E>, never> {
    const left = this.#left
    if (left === undefined) {
      throw new Error('Unreachable: Left yielded but generator continued')
    }
    this.#left = undefined
    return { value: left, done: false }
  }

  return(value: never): IteratorReturnResult<never> {
    this.#left = undefined
    return { value, done: true }
  }

  throw(e: unknown): IteratorResult<Left<E>, never> {
    this.#left = undefined
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
export class Left<out E> {
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

  toJSON(): SerializedLeft<SerializedPayload<E>> {
    return { _tag: 'Left', error: toSerializedPayload(this.error) }
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string | number {
    return hint === 'string' ? String(this.error) : Number.NaN
  }
}

/**
 * The success branch of an {@link Either}.
 *
 * @typeParam A - The success type.
 */
export class Right<out A> {
  readonly _tag = 'Right' as const
  readonly value: A

  constructor(value: A) {
    this.value = value
  }

  [Symbol.iterator](): Iterator<never, A, unknown> {
    return this
  }

  // A Right never yields, so it can be its own completed iterator.
  get done(): true {
    return true
  }

  next(): IteratorReturnResult<A> {
    return this
  }

  get [Symbol.toStringTag]() {
    return 'Either.Right'
  }

  toJSON(): SerializedRight<SerializedPayload<A>> {
    return { _tag: 'Right', value: toSerializedPayload(this.value) }
  }

  [Symbol.toPrimitive](hint: 'string' | 'number' | 'default'): string | A {
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
 * Rehydrates a serialized {@link Either} into a {@link Left} or {@link Right}.
 *
 * Use {@link eitherSchema} when the input comes from an untrusted source.
 *
 * @param value - The serialized either value to rehydrate.
 */
export function fromJSON<E, A>(value: SerializedEither<E, A>): Either<E, A> {
  return value._tag === 'Left' ? left(value.error) : right(value.value)
}

/**
 * Checks whether an unknown value is exactly the serialized {@link Either}
 * envelope.
 *
 * This intentionally validates only the outer transport shape. Use
 * {@link eitherSchema} to validate nested payloads too.
 *
 * @param value - The unknown value to test.
 */
export function isSerializedEither(
  value: unknown,
): value is SerializedEither<unknown, unknown> {
  if (!isSerializedEitherCandidate(value)) return false

  if (value._tag === 'Left') {
    return hasOnlySerializedKeys(value, 'error')
  }

  if (value._tag === 'Right') {
    return hasOnlySerializedKeys(value, 'value')
  }

  return false
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

function toSerializedPayload<T>(
  value: T,
  seen?: WeakSet<object>,
): SerializedPayload<T> {
  if (hasToJSON(value)) return value.toJSON() as SerializedPayload<T>
  if (value instanceof Error)
    return serializeError(
      value,
      seen ?? new WeakSet<object>(),
    ) as SerializedPayload<T>
  return value as SerializedPayload<T>
}

function serializeError(error: Error, seen: WeakSet<object>): SerializedError {
  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
  }

  if (seen.has(error)) return serialized as SerializedError
  seen.add(error)

  const fields = error as unknown as Record<string, unknown>
  for (const key of Object.keys(error)) {
    if (key === 'stack') continue
    serialized[key] = toSerializedPayload(fields[key], seen)
  }

  if (
    'cause' in error &&
    error.cause !== undefined &&
    serialized['cause'] === undefined
  ) {
    serialized['cause'] = toSerializedPayload(error.cause, seen)
  }

  return serialized as SerializedError
}

function hasToJSON(value: unknown): value is ToJSONLike {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  )
}

function hasOnlySerializedKeys(
  value: SerializedEitherCandidate,
  payloadKey: 'error' | 'value',
): boolean {
  const keys = Object.keys(value)
  return (
    keys.length === 2 &&
    Object.prototype.hasOwnProperty.call(value, '_tag') &&
    Object.prototype.hasOwnProperty.call(value, payloadKey)
  )
}

function isSerializedEitherCandidate(
  value: unknown,
): value is SerializedEitherCandidate {
  return typeof value === 'object' && value !== null
}
