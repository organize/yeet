import { describe, expect, it } from 'vitest'

import { rejected, suppressed } from './async.ts'
import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type Terminal = 'none' | 'left' | 'reject' | 'abort'
type Body = 'right' | 'left' | 'throw'

type Scenario = {
  readonly seed: number
  readonly count: number
  readonly terminal: Terminal
  readonly terminalIndex: number
  readonly body: Body
  readonly nested: boolean
  readonly cleanupFails: readonly boolean[]
  readonly domainError: {
    readonly _tag: 'AcquireFailed'
    readonly index: number
  }
  readonly factoryError: Error
  readonly bodyError: Error
  readonly abortReason: { readonly _tag: 'FuzzAbort'; readonly seed: number }
  readonly cleanupErrors: readonly Error[]
}

describe('signal.acquire lifecycle fuzzer', () => {
  it('fuzzes acquisition, abort, nesting, and cleanup precedence', async () => {
    for (let seed = 0; seed < 128; seed++) {
      try {
        await runScenario(makeScenario(seed))
      } catch (cause) {
        throw new Error(`resource lifecycle seed ${seed}`, { cause })
      }
    }
  })
})

async function runScenario(scenario: Scenario): Promise<void> {
  const controller = new AbortController()
  const events: string[] = []
  const expectedAcquired = acquiredIndices(scenario)
  let outcome: Either<unknown, readonly number[]> | undefined
  let thrown: unknown

  try {
    outcome = await either(controller.signal, async function* (_raise, signal) {
      const values: number[] = []
      for (let index = 0; index < scenario.count; index++) {
        const resource = yield* signal.acquire(
          async (received) => {
            expect(received).toBe(signal)
            await microtasks((scenario.seed + index) % 3)
            if (index === scenario.terminalIndex) {
              if (scenario.terminal === 'left')
                return left(scenario.domainError)
              if (scenario.terminal === 'reject') throw scenario.factoryError
              if (scenario.terminal === 'abort') {
                controller.abort(scenario.abortReason)
                await Promise.resolve()
              }
            }
            return right({ index })
          },
          ({ index }) => {
            events.push(`dispose parent:${index}`)
            if (scenario.cleanupFails[index])
              throw scenario.cleanupErrors[index]
          },
        )
        events.push(`use parent:${resource.index}`)
        values.push(resource.index)
      }

      if (scenario.nested) {
        yield* await signal.fork(
          async (childSignal) =>
            await either(
              childSignal,
              async function* (_childRaise, childScope) {
                const child = yield* childScope.acquire(
                  () => right({ index: scenario.seed }),
                  ({ index }) => {
                    events.push(`dispose child:${index}`)
                  },
                )
                events.push(`use child:${child.index}`)
                return child.index
              },
            ),
        )
      }

      if (scenario.body === 'left')
        return left({ _tag: 'BodyFailed' as const, seed: scenario.seed })
      if (scenario.body === 'throw') throw scenario.bodyError
      return values
    })
  } catch (cause) {
    thrown = cause
  }

  const cleanupErrors = expectedAcquired
    .filter((index) => scenario.cleanupFails[index])
    .map((index) => scenario.cleanupErrors[index] as Error)
  const expectedDisposals = [
    ...(scenario.nested && scenario.terminal === 'none'
      ? [`dispose child:${scenario.seed}`]
      : []),
    ...expectedAcquired.toReversed().map((index) => `dispose parent:${index}`),
  ]
  expect(events.filter((event) => event.startsWith('dispose'))).toEqual(
    expectedDisposals,
  )
  expect(new Set(expectedDisposals).size).toBe(expectedDisposals.length)

  if (scenario.terminal === 'none' && scenario.body === 'throw') {
    expect(outcome).toBeUndefined()
    expectNativeSuppression(thrown, cleanupErrors, scenario.bodyError)
    return
  }

  expect(thrown).toBeUndefined()
  const primary = primaryError(scenario)
  if (primary !== undefined) {
    expectLeftOutcome(
      outcome,
      cleanupErrors.length === 0
        ? primary
        : suppressed(primary, cleanupErrors.map(rejected)),
    )
    return
  }

  if (cleanupErrors.length > 0) {
    const [first, ...rest] = cleanupErrors.map(rejected)
    expectLeftOutcome(
      outcome,
      rest.length === 0 ? first : suppressed(first, rest),
    )
    return
  }

  expect(outcome?._tag).toBe('Right')
  if (outcome?._tag === 'Right') expect(outcome.value).toEqual(expectedAcquired)
}

function expectLeftOutcome(
  outcome: Either<unknown, unknown> | undefined,
  error: unknown,
): void {
  expect(outcome?._tag).toBe('Left')
  if (outcome?._tag === 'Left') expect(outcome.error).toEqual(error)
}

function primaryError(scenario: Scenario): unknown {
  if (scenario.terminal === 'abort') {
    return { _tag: 'Aborted', reason: scenario.abortReason }
  }
  if (scenario.terminal === 'left') return scenario.domainError
  if (scenario.terminal === 'reject') return rejected(scenario.factoryError)
  if (scenario.body === 'left') {
    return { _tag: 'BodyFailed', seed: scenario.seed }
  }
  return undefined
}

function acquiredIndices(scenario: Scenario): number[] {
  const end =
    scenario.terminal === 'none'
      ? scenario.count
      : scenario.terminal === 'abort'
        ? scenario.terminalIndex + 1
        : scenario.terminalIndex
  return Array.from({ length: end }, (_, index) => index)
}

function expectNativeSuppression(
  thrown: unknown,
  cleanupErrors: readonly Error[],
  bodyError: Error,
): void {
  let current = thrown
  for (const cleanupError of cleanupErrors) {
    expect(current).toBeInstanceOf(SuppressedError)
    if (!(current instanceof SuppressedError)) return
    expect(current.error).toBe(cleanupError)
    current = current.suppressed
  }
  expect(current).toBe(bodyError)
}

function makeScenario(seed: number): Scenario {
  const random = mulberry32(seed + 1)
  const count = 1 + Math.floor(random() * 4)
  const terminal = pick<Terminal>(random, ['none', 'left', 'reject', 'abort'])
  const terminalIndex = Math.floor(random() * count)
  const cleanupFails = Array.from({ length: count }, () => random() < 0.45)

  return {
    seed,
    count,
    terminal,
    terminalIndex,
    body: pick<Body>(random, ['right', 'left', 'throw']),
    nested: random() < 0.5,
    cleanupFails,
    domainError: { _tag: 'AcquireFailed', index: terminalIndex },
    factoryError: new Error(`factory:${seed}:${terminalIndex}`),
    bodyError: new Error(`body:${seed}`),
    abortReason: { _tag: 'FuzzAbort', seed },
    cleanupErrors: Array.from(
      { length: count },
      (_, index) => new Error(`cleanup:${seed}:${index}`),
    ),
  }
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T
}

async function microtasks(count: number): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
