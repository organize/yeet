import type { Aborted, Exit, ExitError, Rejected, Suppressed } from './async.ts'

import { type Either, type SerializedEither, fromJSON } from './either.ts'

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

export type StandardJSONSchemaOptions = {
  readonly target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | ({} & string)
  readonly libraryOptions?: Record<string, unknown>
}

type JsonSchema = Record<string, unknown>

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

/** Options for {@link exitErrorSchema}. */
export type ExitErrorSchemaOptions<E, Reason = unknown, Cause = unknown> = {
  readonly error?: StandardSchemaWithOptionalJSONSchemaV1<unknown, E>
  readonly reason?: StandardSchemaWithOptionalJSONSchemaV1<unknown, Reason>
  readonly cause?: StandardSchemaWithOptionalJSONSchemaV1<unknown, Cause>
}

/** Options for {@link serializedExitSchema} and {@link exitSchema}. */
export type ExitSchemaOptions<
  E,
  A,
  Reason = unknown,
  Cause = unknown,
> = ExitErrorSchemaOptions<E, Reason, Cause> & {
  readonly value?: StandardSchemaWithOptionalJSONSchemaV1<unknown, A>
}

/** A Standard Schema for yeet's typed scoped error surface. */
export type ExitErrorSchema<
  E = never,
  Reason = unknown,
  Cause = unknown,
> = StandardSchemaV1<unknown, ExitError<E, Reason, Cause>> &
  StandardJSONSchemaV1<unknown, ExitError<E, Reason, Cause>>

/** A Standard Schema for serialized `Exit` JSON. */
export type SerializedExitSchema<
  E,
  A,
  Reason = unknown,
  Cause = unknown,
> = SerializedEitherSchema<ExitError<E, Reason, Cause>, A>

/** A Standard Schema that validates serialized JSON and rehydrates an `Exit`. */
export type ExitSchema<
  E,
  A,
  Reason = unknown,
  Cause = unknown,
> = StandardSchemaV1<unknown, Exit<E, A, Reason, Cause>>

type InnerResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> }

type SerializedEitherCandidate = {
  readonly _tag?: unknown
  readonly error?: unknown
  readonly value?: unknown
}

type ExitErrorCandidate = {
  readonly _tag?: unknown
  readonly reason?: unknown
  readonly cause?: unknown
  readonly error?: unknown
  readonly suppressed?: unknown
}

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

/**
 * Creates a Standard Schema for yeet's scoped error surface:
 * domain errors, `Aborted`, and `Rejected`.
 */
export function exitErrorSchema<E = never, Reason = unknown, Cause = unknown>(
  options: ExitErrorSchemaOptions<E, Reason, Cause> = {},
): ExitErrorSchema<E, Reason, Cause> {
  return {
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate(
        value,
      ):
        | StandardSchemaResult<ExitError<E, Reason, Cause>>
        | Promise<StandardSchemaResult<ExitError<E, Reason, Cause>>> {
        return validateExitError(value, options)
      },
      jsonSchema: {
        input: (jsonSchemaOptions) =>
          exitErrorJsonSchema(options, 'input', jsonSchemaOptions),
        output: (jsonSchemaOptions) =>
          exitErrorJsonSchema(options, 'output', jsonSchemaOptions),
      },
    },
  }
}

/**
 * Creates a Standard Schema for serialized `Exit` JSON.
 */
export function serializedExitSchema<
  E = never,
  A = unknown,
  Reason = unknown,
  Cause = unknown,
>(
  options: ExitSchemaOptions<E, A, Reason, Cause> = {},
): SerializedExitSchema<E, A, Reason, Cause> {
  const error = exitErrorSchema(options)
  return serializedEitherSchema(
    options.value === undefined ? { error } : { error, value: options.value },
  )
}

/**
 * Creates a Standard Schema that validates serialized `Exit` JSON and
 * rehydrates it into a {@link Left} or {@link Right} instance.
 */
export function exitSchema<
  E = never,
  A = unknown,
  Reason = unknown,
  Cause = unknown,
>(
  options: ExitSchemaOptions<E, A, Reason, Cause> = {},
): ExitSchema<E, A, Reason, Cause> {
  const error = exitErrorSchema(options)
  return eitherSchema(
    options.value === undefined ? { error } : { error, value: options.value },
  ) as ExitSchema<E, A, Reason, Cause>
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
  if (!isSerializedEitherCandidate(value)) {
    return failure('Expected serialized Either object')
  }

  if (value._tag === 'Left') {
    if (!('error' in value)) return failure('Expected Left.error', ['error'])

    const unexpected = unexpectedSerializedProperty(value, 'error')
    if (unexpected !== undefined) {
      return failure('Unexpected serialized Either property', [unexpected])
    }

    const result = validateInner(options.error, value.error, 'error')
    if (hydrate) {
      if (isPromiseLike(result)) return result.then(finishLeftHydrated<E, A>)
      return finishLeftHydrated<E, A>(result)
    }

    if (isPromiseLike(result)) return result.then(finishLeftSerialized<E, A>)
    return finishLeftSerialized<E, A>(result)
  }

  if (value._tag === 'Right') {
    if (!('value' in value)) return failure('Expected Right.value', ['value'])

    const unexpected = unexpectedSerializedProperty(value, 'value')
    if (unexpected !== undefined) {
      return failure('Unexpected serialized Either property', [unexpected])
    }

    const result = validateInner(options.value, value.value, 'value')
    if (hydrate) {
      if (isPromiseLike(result)) return result.then(finishRightHydrated<E, A>)
      return finishRightHydrated<E, A>(result)
    }

    if (isPromiseLike(result)) return result.then(finishRightSerialized<E, A>)
    return finishRightSerialized<E, A>(result)
  }

  return failure('Expected _tag to be "Left" or "Right"', ['_tag'])
}

function validateExitError<E, Reason, Cause>(
  value: unknown,
  options: ExitErrorSchemaOptions<E, Reason, Cause>,
):
  | StandardSchemaResult<ExitError<E, Reason, Cause>>
  | Promise<StandardSchemaResult<ExitError<E, Reason, Cause>>> {
  if (isExitErrorCandidate(value) && value._tag === 'Aborted') {
    if (!('reason' in value))
      return failure('Expected Aborted.reason', ['reason'])

    const unexpected = unexpectedExitErrorProperty(value, ['reason'])
    if (unexpected !== undefined) {
      return failure('Unexpected Exit error property', [unexpected])
    }

    const result = validateInner(options.reason, value.reason, 'reason')
    if (isPromiseLike(result)) return result.then(finishAborted<Reason>)
    return finishAborted(result)
  }

  if (isExitErrorCandidate(value) && value._tag === 'Rejected') {
    return validateRejected(value, options)
  }

  if (isExitErrorCandidate(value) && value._tag === 'Suppressed') {
    if (!('error' in value))
      return failure('Expected Suppressed.error', ['error'])
    if (!('suppressed' in value)) {
      return failure('Expected Suppressed.suppressed', ['suppressed'])
    }

    const unexpected = unexpectedExitErrorProperty(value, [
      'error',
      'suppressed',
    ])
    if (unexpected !== undefined) {
      return failure('Unexpected Exit error property', [unexpected])
    }

    if (!Array.isArray(value.suppressed)) {
      return failure('Expected Suppressed.suppressed array', ['suppressed'])
    }

    const primary = validateExitError(value.error, options)
    const suppressed = validateRejectedList(value.suppressed, options)
    if (isPromiseLike(primary) || isPromiseLike(suppressed)) {
      return Promise.all([primary, suppressed]).then(([error, suppressed]) =>
        finishSuppressed(error, suppressed),
      )
    }

    return finishSuppressed(primary, suppressed)
  }

  if (options.error === undefined) return failure('Expected Exit error')

  return options.error['~standard'].validate(value) as
    | StandardSchemaResult<ExitError<E, Reason, Cause>>
    | Promise<StandardSchemaResult<ExitError<E, Reason, Cause>>>
}

function validateRejected<Cause>(
  value: ExitErrorCandidate,
  options: ExitErrorSchemaOptions<unknown, unknown, Cause>,
):
  | StandardSchemaResult<Rejected<Cause>>
  | Promise<StandardSchemaResult<Rejected<Cause>>> {
  if (!('cause' in value)) return failure('Expected Rejected.cause', ['cause'])

  const unexpected = unexpectedExitErrorProperty(value, ['cause'])
  if (unexpected !== undefined) {
    return failure('Unexpected Exit error property', [unexpected])
  }

  const result = validateInner(options.cause, value.cause, 'cause')
  if (isPromiseLike(result)) return result.then(finishRejected<Cause>)
  return finishRejected(result)
}

// oxlint-disable-next-line typescript/promise-function-async
function validateRejectedList<Cause>(
  values: readonly unknown[],
  options: ExitErrorSchemaOptions<unknown, unknown, Cause>,
):
  | InnerResult<readonly Rejected<Cause>[]>
  | Promise<InnerResult<readonly Rejected<Cause>[]>> {
  const results = values.map(
    // oxlint-disable-next-line typescript/promise-function-async
    (value, index) => {
      if (!isExitErrorCandidate(value) || value._tag !== 'Rejected') {
        return failure('Expected Rejected', ['suppressed', index])
      }

      const result = validateRejected(value, options)
      if (isPromiseLike(result)) {
        return result.then((inner) => prefixIssues(inner, index))
      }
      return prefixIssues(result, index)
    },
  )

  if (results.some(isPromiseLike)) {
    return Promise.all(
      results.map(
        // oxlint-disable-next-line typescript/promise-function-async
        (result) => Promise.resolve(result),
      ),
    ).then(finishRejectedList)
  }

  return finishRejectedList(results as readonly InnerResult<Rejected<Cause>>[])
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

function finishAborted<Reason>(
  result: InnerResult<Reason>,
): StandardSchemaResult<Aborted<Reason>> {
  if (result.issues !== undefined) return result

  return { value: { _tag: 'Aborted', reason: result.value } }
}

function finishRejected<Cause>(
  result: InnerResult<Cause>,
): StandardSchemaResult<Rejected<Cause>> {
  if (result.issues !== undefined) return result

  return { value: { _tag: 'Rejected', cause: result.value } }
}

function finishRejectedList<Cause>(
  results: readonly InnerResult<Rejected<Cause>>[],
): InnerResult<readonly Rejected<Cause>[]> {
  const issues = results.flatMap((result) => result.issues ?? [])
  if (issues.length > 0) return { issues }

  return {
    value: results.map(
      (result) => (result as { readonly value: Rejected<Cause> }).value,
    ),
  }
}

function finishSuppressed<E, Reason, Cause>(
  error: StandardSchemaResult<ExitError<E, Reason, Cause>>,
  suppressed: InnerResult<readonly Rejected<Cause>[]>,
): StandardSchemaResult<
  Suppressed<ExitError<E, Reason, Cause>, Rejected<Cause>>
> {
  if (error.issues !== undefined || suppressed.issues !== undefined) {
    return {
      issues: [
        ...(error.issues?.map((issue) => ({
          ...issue,
          path: ['error', ...(issue.path ?? [])],
        })) ?? []),
        ...(suppressed.issues ?? []),
      ],
    }
  }

  return {
    value: {
      _tag: 'Suppressed',
      error: error.value,
      suppressed: suppressed.value,
    },
  }
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

function unexpectedSerializedProperty(
  value: SerializedEitherCandidate,
  payloadKey: 'error' | 'value',
): string | undefined {
  for (const key of Object.keys(value)) {
    if (key !== '_tag' && key !== payloadKey) return key
  }
  return undefined
}

function unexpectedExitErrorProperty(
  value: ExitErrorCandidate,
  payloadKeys: readonly ('reason' | 'cause' | 'error' | 'suppressed')[],
): string | undefined {
  for (const key of Object.keys(value)) {
    if (key !== '_tag' && !payloadKeys.includes(key as never)) return key
  }
  return undefined
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

function exitErrorJsonSchema<E, Reason, Cause>(
  options: ExitErrorSchemaOptions<E, Reason, Cause>,
  direction: 'input' | 'output',
  jsonSchemaOptions: StandardJSONSchemaOptions,
): JsonSchema {
  const variants: JsonSchema[] = [
    {
      type: 'object',
      properties: {
        _tag: { enum: ['Aborted'] },
        reason: jsonSchemaFor(options.reason, direction, jsonSchemaOptions),
      },
      required: ['_tag', 'reason'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        _tag: { enum: ['Rejected'] },
        cause: jsonSchemaFor(options.cause, direction, jsonSchemaOptions),
      },
      required: ['_tag', 'cause'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        _tag: { enum: ['Suppressed'] },
        error: {},
        suppressed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              _tag: { enum: ['Rejected'] },
              cause: jsonSchemaFor(options.cause, direction, jsonSchemaOptions),
            },
            required: ['_tag', 'cause'],
            additionalProperties: false,
          },
        },
      },
      required: ['_tag', 'error', 'suppressed'],
      additionalProperties: false,
    },
  ]

  if (options.error !== undefined) {
    variants.push(jsonSchemaFor(options.error, direction, jsonSchemaOptions))
  }

  return { anyOf: variants }
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

function isSerializedEitherCandidate(
  value: unknown,
): value is SerializedEitherCandidate {
  return typeof value === 'object' && value !== null
}

function isExitErrorCandidate(value: unknown): value is ExitErrorCandidate {
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
