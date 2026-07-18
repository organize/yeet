import { describe, expect, it } from 'vitest'

import {
  left,
  right,
  isLeft,
  isRight,
  fromJSON,
  isSerializedEither,
} from './either.ts'
import {
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
  eitherSchema,
  exitErrorSchema,
  exitSchema,
  serializedEitherSchema,
  serializedExitSchema,
} from './schema.js'

const stringSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      return typeof value === 'string'
        ? { value }
        : { issues: [{ message: 'Expected string' }] }
    },
    jsonSchema: {
      input: () => ({ type: 'string' }),
      output: () => ({ type: 'string' }),
    },
  },
} satisfies StandardSchemaV1<unknown, string> &
  StandardJSONSchemaV1<unknown, string>

const numberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      return typeof value === 'number'
        ? { value }
        : { issues: [{ message: 'Expected number' }] }
    },
    jsonSchema: {
      input: () => ({ type: 'number' }),
      output: () => ({ type: 'number' }),
    },
  },
} satisfies StandardSchemaV1<unknown, number> &
  StandardJSONSchemaV1<unknown, number>

type SensorTimeout = {
  readonly _tag: 'SensorTimeout'
  readonly sensor: string
  readonly deadlineMs: number
}

const sensorTimeoutSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      return value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>)['_tag'] === 'SensorTimeout' &&
        typeof (value as Record<string, unknown>)['sensor'] === 'string' &&
        typeof (value as Record<string, unknown>)['deadlineMs'] === 'number'
        ? { value: value as SensorTimeout }
        : { issues: [{ message: 'Expected SensorTimeout' }] }
    },
    jsonSchema: {
      input: () => ({
        type: 'object',
        properties: {
          _tag: { enum: ['SensorTimeout'] },
          sensor: { type: 'string' },
          deadlineMs: { type: 'number' },
        },
        required: ['_tag', 'sensor', 'deadlineMs'],
        additionalProperties: false,
      }),
      output: () => ({
        type: 'object',
        properties: {
          _tag: { enum: ['SensorTimeout'] },
          sensor: { type: 'string' },
          deadlineMs: { type: 'number' },
        },
        required: ['_tag', 'sensor', 'deadlineMs'],
        additionalProperties: false,
      }),
    },
  },
} satisfies StandardSchemaV1<unknown, SensorTimeout> &
  StandardJSONSchemaV1<unknown, SensorTimeout>

type AbortReason = {
  readonly _tag: 'Deadline'
  readonly operation: string
}

const abortReasonSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      return value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>)['_tag'] === 'Deadline' &&
        typeof (value as Record<string, unknown>)['operation'] === 'string'
        ? { value: value as AbortReason }
        : { issues: [{ message: 'Expected Deadline' }] }
    },
    jsonSchema: {
      input: () => ({
        type: 'object',
        properties: {
          _tag: { enum: ['Deadline'] },
          operation: { type: 'string' },
        },
        required: ['_tag', 'operation'],
        additionalProperties: false,
      }),
      output: () => ({
        type: 'object',
        properties: {
          _tag: { enum: ['Deadline'] },
          operation: { type: 'string' },
        },
        required: ['_tag', 'operation'],
        additionalProperties: false,
      }),
    },
  },
} satisfies StandardSchemaV1<unknown, AbortReason> &
  StandardJSONSchemaV1<unknown, AbortReason>

const stringToNumberSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate(value: unknown) {
      return typeof value === 'string'
        ? { value: Number(value) }
        : { issues: [{ message: 'Expected numeric string' }] }
    },
    jsonSchema: {
      input: ({ target }) => ({ type: 'string', title: target }),
      output: ({ target }) => ({ type: 'number', title: target }),
    },
  },
} satisfies StandardSchemaV1<string, number> &
  StandardJSONSchemaV1<string, number>

class TaggedTransportError extends Error {
  readonly _tag = 'TaggedTransportError'
  readonly entity: string

  constructor(entity: string) {
    super(`${entity} not found`)
    this.entity = entity
  }

  toJSON() {
    return {
      _tag: this._tag,
      entity: this.entity,
      message: this.message,
    }
  }
}

describe('left / right constructors', () => {
  it('left holds the error value', () => {
    const e = left('oops')
    expect(e._tag).toBe('Left')
    expect(e.error).toBe('oops')
  })

  it('right holds the success value', () => {
    const v = right(42)
    expect(v._tag).toBe('Right')
    expect(v.value).toBe(42)
  })

  it('right is its own completed iterator result without changing its own shape', () => {
    const value = right(42)
    const iterator = value[Symbol.iterator]()

    expect(iterator.next()).toBe(value)
    expect(value.done).toBe(true)
    expect(Object.keys(value)).toEqual(['_tag', 'value'])
  })
})

describe('isLeft / isRight', () => {
  it('isLeft narrows correctly', () => {
    expect(isLeft(left('e'))).toBe(true)
    expect(isLeft(right(1))).toBe(false)
  })

  it('isRight narrows correctly', () => {
    expect(isRight(right(1))).toBe(true)
    expect(isRight(left('e'))).toBe(false)
  })
})

describe('Symbol.toStringTag', () => {
  it('left has the correct tag', () => {
    expect(Object.prototype.toString.call(left('e'))).toBe(
      '[object Either.Left]',
    )
  })

  it('right has the correct tag', () => {
    expect(Object.prototype.toString.call(right(1))).toBe(
      '[object Either.Right]',
    )
  })
})

describe('toJSON', () => {
  it('left serialises correctly', () => {
    expect(JSON.parse(JSON.stringify(left('oops')))).toEqual({
      _tag: 'Left',
      error: 'oops',
    })
  })

  it('right serialises correctly', () => {
    expect(JSON.parse(JSON.stringify(right(42)))).toEqual({
      _tag: 'Right',
      value: 42,
    })
  })

  it('serializes nested values with toJSON before returning the transport object', () => {
    const serialized = left(new TaggedTransportError('User')).toJSON()

    expect(serialized.error).toEqual({
      _tag: 'TaggedTransportError',
      entity: 'User',
      message: 'User not found',
    })
    expect(serialized.error).not.toBeInstanceOf(Error)
  })

  it('serializes plain Error values into plain objects', () => {
    const serialized = left(new TypeError('boom')).toJSON()

    expect(serialized.error).toEqual({
      name: 'TypeError',
      message: 'boom',
    })
    expect(serialized.error).not.toBeInstanceOf(Error)
  })
})

describe('serialization schemas', () => {
  it('rehydrates serialized Left and Right values', () => {
    const leftResult = fromJSON({ _tag: 'Left', error: 'oops' })
    const rightResult = fromJSON({ _tag: 'Right', value: 42 })

    expect(leftResult._tag).toBe('Left')
    if (leftResult._tag === 'Left') expect(leftResult.error).toBe('oops')

    expect(rightResult._tag).toBe('Right')
    if (rightResult._tag === 'Right') expect(rightResult.value).toBe(42)
  })

  it('validates serialized Either JSON with Standard Schema', async () => {
    const schema = serializedEitherSchema({
      error: stringSchema,
      value: numberSchema,
    })

    const result = await schema['~standard'].validate(
      JSON.parse(JSON.stringify(left('oops'))),
    )

    expect(result).toEqual({ value: { _tag: 'Left', error: 'oops' } })
  })

  it('detects strict serialized Either envelopes', () => {
    expect(isSerializedEither({ _tag: 'Left', error: 'oops' })).toBe(true)
    expect(isSerializedEither({ _tag: 'Right', value: 42 })).toBe(true)
    expect(
      isSerializedEither({ _tag: 'Right', value: 42, error: 'oops' }),
    ).toBe(false)
    expect(
      isSerializedEither({ _tag: 'Left', error: 'oops', extra: true }),
    ).toBe(false)
  })

  it('rejects ambiguous serialized Either envelopes', async () => {
    const schema = serializedEitherSchema()

    const result = await schema['~standard'].validate({
      _tag: 'Left',
      error: 'oops',
      value: 42,
    })

    expect(result).toEqual({
      issues: [
        { message: 'Unexpected serialized Either property', path: ['value'] },
      ],
    })
  })

  it('uses nested Standard Schema output when validation transforms values', async () => {
    const schema = serializedEitherSchema({
      value: stringToNumberSchema,
    })

    const result = await schema['~standard'].validate({
      _tag: 'Right',
      value: '42',
    })

    expect(result).toEqual({ value: { _tag: 'Right', value: 42 } })
  })

  it('validates and hydrates serialized Either JSON with Standard Schema', async () => {
    const schema = eitherSchema({
      error: stringSchema,
      value: numberSchema,
    })

    const result = await schema['~standard'].validate(
      JSON.parse(JSON.stringify(right(42))),
    )

    expect(result).toEqual({ value: right(42) })
  })

  it('prefixes nested Standard Schema issue paths', async () => {
    const schema = eitherSchema({
      error: stringSchema,
      value: numberSchema,
    })

    const result = await schema['~standard'].validate({
      _tag: 'Left',
      error: 42,
    })

    expect(result).toEqual({
      issues: [{ message: 'Expected string', path: ['error'] }],
    })
  })

  it('ships a Standard JSON Schema for the serialized shape', () => {
    const schema = serializedEitherSchema({
      error: stringSchema,
      value: numberSchema,
    })

    const jsonSchema = schema['~standard'].jsonSchema.output({
      target: 'draft-2020-12',
    })

    expect(jsonSchema).toEqual({
      oneOf: [
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Left'] },
            error: { type: 'string' },
          },
          required: ['_tag', 'error'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Right'] },
            value: { type: 'number' },
          },
          required: ['_tag', 'value'],
          additionalProperties: false,
        },
      ],
    })
  })

  it('separates input and output JSON Schema for nested transforms', () => {
    const schema = serializedEitherSchema({
      value: stringToNumberSchema,
    })

    const input = schema['~standard'].jsonSchema.input({
      target: 'draft-07',
    })
    const output = schema['~standard'].jsonSchema.output({
      target: 'draft-07',
    })

    expect(input).toEqual({
      oneOf: [
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Left'] },
            error: {},
          },
          required: ['_tag', 'error'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Right'] },
            value: { type: 'string', title: 'draft-07' },
          },
          required: ['_tag', 'value'],
          additionalProperties: false,
        },
      ],
    })
    expect(output).toEqual({
      oneOf: [
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Left'] },
            error: {},
          },
          required: ['_tag', 'error'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Right'] },
            value: { type: 'number', title: 'draft-07' },
          },
          required: ['_tag', 'value'],
          additionalProperties: false,
        },
      ],
    })
  })

  it('validates built-in Exit errors with Standard Schema', async () => {
    const schema = serializedExitSchema({
      value: numberSchema,
    })

    const aborted = await schema['~standard'].validate({
      _tag: 'Left',
      error: { _tag: 'Aborted', reason: 'Stop' },
    })
    const rejected = await schema['~standard'].validate({
      _tag: 'Left',
      error: { _tag: 'Rejected', cause: 'Boom' },
    })

    expect(aborted).toEqual({
      value: { _tag: 'Left', error: { _tag: 'Aborted', reason: 'Stop' } },
    })
    expect(rejected).toEqual({
      value: { _tag: 'Left', error: { _tag: 'Rejected', cause: 'Boom' } },
    })
  })

  it('validates Suppressed Exit errors with Standard Schema', async () => {
    const schema = exitSchema({
      error: stringSchema,
      cause: stringSchema,
      value: numberSchema,
    })

    const result = await schema['~standard'].validate({
      _tag: 'Left',
      error: {
        _tag: 'Suppressed',
        error: 'PrimaryFailed',
        suppressed: [{ _tag: 'Rejected', cause: 'CleanupFailed' }],
      },
    })

    expect(result.issues).toBeUndefined()
    if (result.issues !== undefined) return
    expect(isLeft(result.value)).toBe(true)
    if (result.value._tag === 'Left') {
      expect(result.value.error).toEqual({
        _tag: 'Suppressed',
        error: 'PrimaryFailed',
        suppressed: [{ _tag: 'Rejected', cause: 'CleanupFailed' }],
      })
    }
  })

  it('rejects domain Exit errors without a domain error schema', async () => {
    const schema = serializedExitSchema()

    const result = await schema['~standard'].validate({
      _tag: 'Left',
      error: 'DomainError',
    })

    expect(result).toEqual({
      issues: [{ message: 'Expected Exit error', path: ['error'] }],
    })
  })

  it('allows domain Exit errors with an error schema and hydrates the result', async () => {
    const schema = exitSchema({
      error: stringSchema,
      value: numberSchema,
    })

    const result = await schema['~standard'].validate({
      _tag: 'Left',
      error: 'DomainError',
    })

    expect(result.issues).toBeUndefined()
    if (result.issues !== undefined) return
    expect(result.value._tag).toBe('Left')
    if (result.value._tag === 'Left')
      expect(result.value.error).toBe('DomainError')
  })

  it('round-trips typed Exit errors into branchable hydrated Lefts', async () => {
    const serialized = serializedExitSchema({
      error: sensorTimeoutSchema,
      reason: abortReasonSchema,
      value: stringSchema,
    })
    const hydrated = exitSchema({
      error: sensorTimeoutSchema,
      reason: abortReasonSchema,
      value: stringSchema,
    })

    const domainJson = {
      _tag: 'Left',
      error: {
        _tag: 'SensorTimeout',
        sensor: 'imu-7',
        deadlineMs: 250,
      },
    }
    const abortJson = {
      _tag: 'Left',
      error: {
        _tag: 'Aborted',
        reason: { _tag: 'Deadline', operation: 'scan' },
      },
    }

    expect(await serialized['~standard'].validate(domainJson)).toEqual({
      value: domainJson,
    })

    const domain = await hydrated['~standard'].validate(domainJson)
    const aborted = await hydrated['~standard'].validate(abortJson)

    expect(domain.issues).toBeUndefined()
    expect(aborted.issues).toBeUndefined()
    if (domain.issues !== undefined || aborted.issues !== undefined) return

    expect(isLeft(domain.value)).toBe(true)
    expect(isLeft(aborted.value)).toBe(true)
    if (domain.value._tag === 'Left') {
      expect(domain.value.error._tag).toBe('SensorTimeout')
      if (domain.value.error._tag === 'SensorTimeout')
        expect(domain.value.error.sensor).toBe('imu-7')
    }
    if (aborted.value._tag === 'Left') {
      expect(aborted.value.error._tag).toBe('Aborted')
      if (aborted.value.error._tag === 'Aborted')
        expect(aborted.value.error.reason).toEqual({
          _tag: 'Deadline',
          operation: 'scan',
        })
    }
  })

  it('validates nested Exit reason and cause schemas', async () => {
    const schema = exitErrorSchema({
      reason: stringSchema,
      cause: stringSchema,
    })

    const result = await schema['~standard'].validate({
      _tag: 'Aborted',
      reason: 42,
    })

    expect(result).toEqual({
      issues: [{ message: 'Expected string', path: ['reason'] }],
    })
  })

  it('ships a Standard JSON Schema for Exit errors', () => {
    const schema = serializedExitSchema({
      error: stringSchema,
      value: numberSchema,
      reason: stringSchema,
      cause: stringSchema,
    })

    const jsonSchema = schema['~standard'].jsonSchema.output({
      target: 'draft-2020-12',
    })

    expect(jsonSchema).toEqual({
      oneOf: [
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Left'] },
            error: {
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    _tag: { enum: ['Aborted'] },
                    reason: { type: 'string' },
                  },
                  required: ['_tag', 'reason'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: {
                    _tag: { enum: ['Rejected'] },
                    cause: { type: 'string' },
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
                          cause: { type: 'string' },
                        },
                        required: ['_tag', 'cause'],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ['_tag', 'error', 'suppressed'],
                  additionalProperties: false,
                },
                { type: 'string' },
              ],
            },
          },
          required: ['_tag', 'error'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            _tag: { enum: ['Right'] },
            value: { type: 'number' },
          },
          required: ['_tag', 'value'],
          additionalProperties: false,
        },
      ],
    })
  })
})

describe('Symbol.toPrimitive', () => {
  it('right used as a number yields the value', () => {
    expect(+right(42) + 1).toBe(43)
  })

  it('left used as a number yields NaN', () => {
    expect(+left('oops')).toBeNaN()
  })

  it('right converts to string', () => {
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(right('hello'))).toBe('hello')
  })

  it('left converts to string via its error', () => {
    // oxlint-disable-next-line typescript/no-base-to-string
    expect(String(left('oops'))).toBe('oops')
  })
})
