import { type Either, type SerializedEither, fromJSON } from '#/either.js'

const VENDOR = 'yeet'

/** A Standard Schema issue. */
export type StandardSchemaIssue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
}

/** A Standard Schema validation result. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> }

/** A dependency-free copy of the Standard Schema v1 interface. */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
      options?: { readonly libraryOptions?: Record<string, unknown> },
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
    readonly types?: { readonly input: Input; readonly output: Output }
  }
}

/** A dependency-free copy of the Standard JSON Schema v1 interface. */
export type StandardJSONSchemaV1<Input = unknown, Output = Input> = {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly jsonSchema: {
      readonly input: (options: StandardJSONSchemaOptions) => JsonSchema
      readonly output: (options: StandardJSONSchemaOptions) => JsonSchema
    }
    readonly types?: { readonly input: Input; readonly output: Output }
  }
}

/** Options passed to Standard JSON Schema converters. */
export type StandardJSONSchemaOptions = {
  readonly target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string)
  readonly libraryOptions?: Record<string, unknown>
}

/** A JSON Schema object. */
export type JsonSchema = Record<string, unknown>

/** A Standard Schema that may also expose Standard JSON Schema conversion. */
export type StandardSchemaWithOptionalJSONSchemaV1<
  Input = unknown,
  Output = Input,
> = {
  readonly '~standard': StandardSchemaV1<Input, Output>['~standard'] & {
    readonly jsonSchema?: StandardJSONSchemaV1<
      Input,
      Output
    >['~standard']['jsonSchema']
  }
}

/** Options for {@link serializedEitherSchema} and {@link eitherSchema}. */
export type EitherSchemaOptions<E, A> = {
  readonly error?: StandardSchemaWithOptionalJSONSchemaV1<unknown, E>
  readonly value?: StandardSchemaWithOptionalJSONSchemaV1<unknown, A>
}

/** A Standard Schema for serialized `Either` JSON. */
export type SerializedEitherSchema<E, A> = StandardSchemaV1<
  unknown,
  SerializedEither<E, A>
> &
  StandardJSONSchemaV1<unknown, SerializedEither<E, A>>

/** A Standard Schema that validates serialized JSON and rehydrates an `Either`. */
export type EitherSchema<E, A> = StandardSchemaV1<unknown, Either<E, A>>

type InnerResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> }

/**
 * Creates a Standard Schema for the serialized JSON representation of
 * {@link Either}.
 *
 * Optional `error` and `value` schemas validate the nested payloads.
 */
export function serializedEitherSchema<E = unknown, A = unknown>(
  options: EitherSchemaOptions<E, A> = {},
): SerializedEitherSchema<E, A> {
  return {
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate(
        value,
      ):
        | StandardSchemaResult<SerializedEither<E, A>>
        | Promise<StandardSchemaResult<SerializedEither<E, A>>> {
        return validateSerialized(value, options, false)
      },
      jsonSchema: {
        input: (jsonSchemaOptions) =>
          eitherJsonSchema(options, 'input', jsonSchemaOptions),
        output: (jsonSchemaOptions) =>
          eitherJsonSchema(options, 'output', jsonSchemaOptions),
      },
    },
  }
}

/**
 * Creates a Standard Schema that validates serialized `Either` JSON and
 * rehydrates it into a {@link Left} or {@link Right} instance.
 *
 * Optional `error` and `value` schemas validate the nested payloads before
 * rehydration.
 */
export function eitherSchema<E = unknown, A = unknown>(
  options: EitherSchemaOptions<E, A> = {},
): EitherSchema<E, A> {
  return {
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate(
        value,
      ):
        | StandardSchemaResult<Either<E, A>>
        | Promise<StandardSchemaResult<Either<E, A>>> {
        return validateSerialized(value, options, true)
      },
    },
  }
}

function validateSerialized<E, A>(
  value: unknown,
  options: EitherSchemaOptions<E, A>,
  hydrate: false,
):
  | StandardSchemaResult<SerializedEither<E, A>>
  | Promise<StandardSchemaResult<SerializedEither<E, A>>>

function validateSerialized<E, A>(
  value: unknown,
  options: EitherSchemaOptions<E, A>,
  hydrate: true,
):
  | StandardSchemaResult<Either<E, A>>
  | Promise<StandardSchemaResult<Either<E, A>>>

function validateSerialized<E, A>(
  value: unknown,
  options: EitherSchemaOptions<E, A>,
  hydrate: boolean,
):
  | StandardSchemaResult<Either<E, A>>
  | StandardSchemaResult<SerializedEither<E, A>>
  | Promise<StandardSchemaResult<Either<E, A>>>
  | Promise<StandardSchemaResult<SerializedEither<E, A>>> {
  if (!isRecord(value)) {
    return failure('Expected serialized Either object')
  }

  if (value['_tag'] === 'Left') {
    if (!('error' in value)) return failure('Expected Left.error', ['error'])

    const result = validateInner(options.error, value['error'], 'error')
    if (hydrate) {
      if (isPromiseLike(result)) return result.then(finishLeftHydrated<E, A>)
      return finishLeftHydrated<E, A>(result)
    }

    if (isPromiseLike(result)) return result.then(finishLeftSerialized<E, A>)
    return finishLeftSerialized<E, A>(result)
  }

  if (value['_tag'] === 'Right') {
    if (!('value' in value)) return failure('Expected Right.value', ['value'])

    const result = validateInner(options.value, value['value'], 'value')
    if (hydrate) {
      if (isPromiseLike(result)) return result.then(finishRightHydrated<E, A>)
      return finishRightHydrated<E, A>(result)
    }

    if (isPromiseLike(result)) return result.then(finishRightSerialized<E, A>)
    return finishRightSerialized<E, A>(result)
  }

  return failure('Expected _tag to be "Left" or "Right"', ['_tag'])
}

function validateInner<T>(
  schema: StandardSchemaWithOptionalJSONSchemaV1<unknown, T> | undefined,
  value: unknown,
  path: PropertyKey,
): InnerResult<T> | Promise<InnerResult<T>> {
  if (schema === undefined) return { value: value as T }

  const result = schema['~standard'].validate(value)
  if (isPromiseLike(result)) {
    return result.then((inner) => prefixIssues(inner, path))
  }
  return prefixIssues(result, path)
}

function prefixIssues<T>(
  result: StandardSchemaResult<T>,
  path: PropertyKey,
): InnerResult<T> {
  if (result.issues !== undefined) {
    return {
      issues: result.issues.map((issue) => ({
        ...issue,
        path: [path, ...(issue.path ?? [])],
      })),
    }
  }
  return result
}

function finishLeftSerialized<E, A>(
  result: InnerResult<E>,
): StandardSchemaResult<SerializedEither<E, A>> {
  if (result.issues !== undefined) return result

  const serialized = { _tag: 'Left' as const, error: result.value }
  return { value: serialized }
}

function finishLeftHydrated<E, A>(
  result: InnerResult<E>,
): StandardSchemaResult<Either<E, A>> {
  if (result.issues !== undefined) return result

  return { value: fromJSON<E, A>({ _tag: 'Left', error: result.value }) }
}

function finishRightSerialized<E, A>(
  result: InnerResult<A>,
): StandardSchemaResult<SerializedEither<E, A>> {
  if (result.issues !== undefined) return result

  const serialized = { _tag: 'Right' as const, value: result.value }
  return { value: serialized }
}

function finishRightHydrated<E, A>(
  result: InnerResult<A>,
): StandardSchemaResult<Either<E, A>> {
  if (result.issues !== undefined) return result

  return { value: fromJSON<E, A>({ _tag: 'Right', value: result.value }) }
}

function failure(
  message: string,
  path?: ReadonlyArray<PropertyKey>,
): { readonly issues: ReadonlyArray<StandardSchemaIssue> } {
  return {
    issues: [path === undefined ? { message } : { message, path }],
  }
}

function eitherJsonSchema<E, A>(
  options: EitherSchemaOptions<E, A>,
  direction: 'input' | 'output',
  jsonSchemaOptions: StandardJSONSchemaOptions,
): JsonSchema {
  return {
    oneOf: [
      {
        type: 'object',
        properties: {
          _tag: { enum: ['Left'] },
          error: jsonSchemaFor(options.error, direction, jsonSchemaOptions),
        },
        required: ['_tag', 'error'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          _tag: { enum: ['Right'] },
          value: jsonSchemaFor(options.value, direction, jsonSchemaOptions),
        },
        required: ['_tag', 'value'],
        additionalProperties: false,
      },
    ],
  }
}

function jsonSchemaFor(
  schema: StandardSchemaWithOptionalJSONSchemaV1 | undefined,
  direction: 'input' | 'output',
  options: StandardJSONSchemaOptions,
): JsonSchema {
  const jsonSchema = schema?.['~standard'].jsonSchema
  if (jsonSchema === undefined) return {}

  return jsonSchema[direction](options)
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
