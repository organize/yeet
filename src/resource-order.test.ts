import { describe, expect, it } from 'vitest'

import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type UsedAfterRelease = {
  readonly _tag: 'UsedAfterRelease'
  readonly worker: number
  readonly phase: 'teardown'
}

type Connection = {
  poisoned: boolean
}

type SweepRow = {
  readonly abort: 'N-1' | 'N' | 'N+1' | 'N+2'
  readonly opened: number
  readonly released: number
  readonly exposed: boolean
}

describe('scoped resource ordering', () => {
  it('awaits forkEach child teardown before releasing an outer resource', async () => {
    const { result, events, defects } = await runOwnershipScenario(false)

    expectLeft(result, { _tag: 'LiveDemoDetected' })
    expect(defects).toEqual([])
    expect(events).toHaveLength(5)
    expect(events.at(-1)).toBe('release connection')
    expect(new Set(events.slice(0, -1))).toEqual(
      new Set(
        Array.from({ length: 4 }, (_, worker) => `teardown worker:${worker}`),
      ),
    )
  })

  it('retains a tagged use-after-release cleanup defect in the memo', async () => {
    const { result, defects } = await runOwnershipScenario(true)

    expect(defects).toEqual([
      { _tag: 'UsedAfterRelease', worker: 1, phase: 'teardown' },
      { _tag: 'UsedAfterRelease', worker: 2, phase: 'teardown' },
      { _tag: 'UsedAfterRelease', worker: 3, phase: 'teardown' },
    ])
    expectLeft(result, {
      _tag: 'Suppressed',
      error: { _tag: 'LiveDemoDetected' },
      suppressed: defects.map((cause) => ({ _tag: 'Rejected', cause })),
    })
  })

  it('releases but never exposes resources across the acquisition abort window', async () => {
    const rows: SweepRow[] = []
    for (const offset of [-1, 0, 1, 2]) {
      rows.push(await runAcquisitionSweep(offset))
    }

    expect(rows).toEqual([
      { abort: 'N-1', opened: 1, released: 1, exposed: false },
      { abort: 'N', opened: 1, released: 1, exposed: false },
      { abort: 'N+1', opened: 1, released: 1, exposed: false },
      { abort: 'N+2', opened: 1, released: 1, exposed: false },
    ])
  })
})

async function runOwnershipScenario(poisonBeforeClose: boolean): Promise<{
  readonly result: Either<unknown, unknown>
  readonly events: readonly string[]
  readonly defects: readonly UsedAfterRelease[]
}> {
  const workerCount = 4
  const allStarted = deferred<void>()
  const events: string[] = []
  const defects: UsedAfterRelease[] = []
  let started = 0

  const result = await either(async function* ({ signal }) {
    const connection = yield* signal.acquire(
      (): Connection => ({ poisoned: false }),
      (resource) => {
        resource.poisoned = true
        events.push('release connection')
      },
    )

    const completions = signal.forkEach(
      Array.from({ length: workerCount }, (_, worker) => worker),
      { concurrency: workerCount },
      async (worker, child) =>
        await either(child, async function* ({ signal: childScope }) {
          yield* childScope.acquire(
            () => worker,
            () => {
              events.push(`teardown worker:${worker}`)
              if (!connection.poisoned) return

              const defect = {
                _tag: 'UsedAfterRelease',
                worker,
                phase: 'teardown',
              } satisfies UsedAfterRelease
              defects.push(defect)
              throw defect
            },
          )

          started++
          if (started === workerCount) allStarted.resolve()
          await allStarted.promise

          if (worker === 0) {
            return left({ _tag: 'LiveDemoDetected' as const })
          }

          await aborted(childScope)
          return right(`stopped:${worker}` as const)
        }),
    )

    const first = await completions.next()
    if (first.done) return 'NoCompletions' as const
    if (poisonBeforeClose) connection.poisoned = true
    return first.value.result
  })

  return { result, events, defects }
}

async function runAcquisitionSweep(offset: number): Promise<SweepRow> {
  const openTicks = 4
  const controller = new AbortController()
  let opened = 0
  let released = 0
  let exposed = false

  // Queue cancellation first so a same-microtask tie is adversarial.
  const abort = microtasks(openTicks + offset).then(() => {
    controller.abort({ _tag: 'SweepAbort', offset })
  })

  const outcome = either(controller.signal, async function* ({ signal }) {
    const resource = yield* signal.acquire(
      async () => {
        await microtasks(openTicks)
        opened++
        return { id: opened }
      },
      () => {
        released++
      },
    )
    exposed = true
    return resource
  })

  const [result] = await Promise.all([outcome, abort])
  expect(result._tag).toBe('Left')

  return {
    abort: formatOffset(offset),
    opened,
    released,
    exposed,
  }
}

function formatOffset(offset: number): SweepRow['abort'] {
  if (offset === -1) return 'N-1'
  if (offset === 0) return 'N'
  if (offset === 1) return 'N+1'
  return 'N+2'
}

async function microtasks(count: number): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
} {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

function expectLeft<E>(result: Either<E, unknown>, error: E): void {
  expect(result._tag).toBe('Left')
  if (result._tag === 'Left') expect(result.error).toEqual(error)
}
