import { describe, expect, it } from 'vitest'

import {
  type ForkEachCompletion,
  type ForkEachTask,
  type ScopeTask,
} from './async.ts'
import { either } from './combinators.ts'
import {
  type Either,
  type Left,
  type Right,
  type SerializedEither,
  isLeft,
  left,
  right,
} from './either.ts'

type NarrowError = {
  readonly _tag: 'NarrowError'
  readonly detail: 'specific'
}

type WideError = {
  readonly _tag: string
  readonly detail: string
}

const narrowError: NarrowError = {
  _tag: 'NarrowError',
  detail: 'specific',
}

const unwrapInfallible = <A>(result: Either<never, A>): A =>
  isLeft(result) ? result.error : result.value

describe('variance and infallible inference', () => {
  it('keeps immutable Either branches covariant', () => {
    const narrowLeft: Left<NarrowError> = left(narrowError)
    const wideLeft: Left<WideError> = narrowLeft
    const narrowRight: Right<'ready'> = right('ready')
    const wideRight: Right<string> = narrowRight
    const narrowEither: Either<NarrowError, 'ready'> = narrowRight
    const wideEither: Either<WideError, string> = narrowEither
    const serialized: SerializedEither<WideError, string> =
      narrowEither.toJSON()

    expect(wideLeft).toBe(narrowLeft)
    expect(wideRight).toBe(narrowRight)
    expect(wideEither).toBe(narrowEither)
    expect(serialized).toEqual({ _tag: 'Right', value: 'ready' })
  })

  it('tracks task inputs contravariantly and outcomes covariantly', () => {
    const broadTask: ForkEachTask<unknown, NarrowError, 'ready'> = () =>
      right('ready')
    const stringTask: ForkEachTask<string, WideError, string> = broadTask
    const narrowScopeTask: ScopeTask<NarrowError, 'ready'> = () =>
      right('ready')
    const wideScopeTask: ScopeTask<WideError, string> = narrowScopeTask
    const narrowCompletion: ForkEachCompletion<'item', NarrowError, 'ready'> = {
      item: 'item',
      index: 0,
      result: right('ready'),
    }
    const wideCompletion: ForkEachCompletion<string, WideError, string> =
      narrowCompletion

    expect(stringTask).toBe(broadTask)
    expect(wideScopeTask).toBe(narrowScopeTask)
    expect(wideCompletion).toBe(narrowCompletion)
  })

  it('infers never for effect-free sync and async either bodies', async () => {
    const sync = either(
      // oxlint-disable-next-line require-yield
      function* () {
        return 42 as const
      },
    )
    const asyncResult = either(
      // oxlint-disable-next-line require-yield
      async function* () {
        return 'ready' as const
      },
    )

    const typedSync: Either<never, 42> = sync
    const typedAsync: Promise<Either<never, 'ready'>> = asyncResult

    expect(unwrapInfallible(typedSync)).toBe(42)
    expect(unwrapInfallible(await typedAsync)).toBe('ready')
  })
})
