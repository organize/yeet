import { describe, expect, it } from 'vitest'

import {
  left,
  right,
  isLeft,
  isRight,
  isLeftReturn,
  fromJSON,
  isSerializedEither,
} from '#/either.js'
import {
  type JsonSchema,
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
  eitherSchema,
  serializedEitherSchema,
} from '#/schema.js'

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

describe('isLeftReturn', () => {
  it('returns true for a Left', () => {
    expect(isLeftReturn(left('e'))).toBe(true)
  })

  it('returns false for a Right', () => {
    expect(isLeftReturn(right(1))).toBe(false)
  })

  it('returns false for non-Either objects', () => {
    expect(isLeftReturn(null)).toBe(false)
    expect(isLeftReturn({ _tag: 'Right' })).toBe(false)
    expect(isLeftReturn('string')).toBe(false)
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

    expect(jsonSchema satisfies JsonSchema).toEqual({
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
