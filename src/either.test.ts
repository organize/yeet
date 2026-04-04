import { left, right, isLeft, isRight, isLeftReturn } from '#/either'
import { describe, expect, it } from 'vitest'

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
