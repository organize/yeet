import { bench, describe } from 'vitest'

import { rejected, siblingSettled } from './async.ts'
import { BENCH_OPTS } from './bench-options.ts'
import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type Candidate = (
  signal: AbortSignal,
) => Either<unknown, unknown> | PromiseLike<Either<unknown, unknown>>

const BENCH_BATCH = readPositiveInt('SCOPE_BENCH_BATCH', 16)
const sink = { value: undefined as unknown }

const immediateSuccess = [
  () => right('first'),
  () => right('second'),
  () => right('third'),
] as const satisfies readonly Candidate[]

const failuresThenSuccess = [
  () => left('first failed'),
  () => left('second failed'),
  () => right('third'),
] as const satisfies readonly Candidate[]

const allFail = [
  () => left('first failed'),
  () => left('second failed'),
  () => left('third failed'),
] as const satisfies readonly Candidate[]

const cancelLosers = [
  waitForAbort,
  () => right('winner'),
  waitForAbort,
] as const satisfies readonly Candidate[]

describe('scoped first success: immediate success', () => {
  benchmarkPair(immediateSuccess)
})

describe('scoped first success: failures then success', () => {
  benchmarkPair(failuresThenSuccess)
})

describe('scoped first success: all fail', () => {
  benchmarkPair(allFail)
})

describe('scoped first success: cancel losers', () => {
  benchmarkPair(cancelLosers)
})

function benchmarkPair(tasks: readonly Candidate[]): void {
  bench(
    'manual cancellation-aware first Right',
    async () => {
      await consumeBatch(manualFirst, tasks)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet signal.forkFirst',
    async () => {
      await consumeBatch(yeetFirst, tasks)
    },
    BENCH_OPTS,
  )
}

async function consumeBatch(
  run: (tasks: readonly Candidate[]) => Promise<Either<unknown, unknown>>,
  tasks: readonly Candidate[],
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = await run(tasks)
  }
  sink.value = value
}

async function yeetFirst(
  tasks: readonly Candidate[],
): Promise<Either<unknown, unknown>> {
  return await either(async function* ({ signal }) {
    return yield* await signal.forkFirst(tasks)
  })
}

// oxlint-disable-next-line typescript/promise-function-async
function manualFirst(
  tasks: readonly Candidate[],
): Promise<Either<unknown, unknown>> {
  if (tasks.length === 0) return Promise.resolve(left([]))

  const controllers = Array.from(
    { length: tasks.length },
    () => new AbortController(),
  )
  const promises: Promise<Either<unknown, unknown>>[] = []
  promises.length = tasks.length
  const done = new Uint8Array(tasks.length)
  const errors: unknown[] = []
  errors.length = tasks.length
  let remaining = tasks.length
  let settled = false

  return new Promise((resolve) => {
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index] as Candidate
      const controller = controllers[index] as AbortController
      const promise = Promise.try(() => task(controller.signal)).then(
        (result) => result,
        (cause) => left(rejected(cause)),
      )
      promises[index] = promise

      void promise.then(async (result) => {
        if (settled) return
        done[index] = 1

        if (result._tag === 'Left') {
          errors[index] = result.error
          remaining--
          if (remaining === 0) {
            settled = true
            resolve(left(errors))
          }
          return
        }

        settled = true
        const pending: Promise<Either<unknown, unknown>>[] = []
        for (let loser = 0; loser < tasks.length; loser++) {
          if (done[loser] === 1) continue
          ;(controllers[loser] as AbortController).abort(siblingSettled())
          pending.push(promises[loser] as Promise<Either<unknown, unknown>>)
        }
        if (pending.length > 0) await Promise.allSettled(pending)
        resolve(result)
      })
    }
  })
}

// oxlint-disable-next-line typescript/promise-function-async
function waitForAbort(
  signal: AbortSignal,
): Promise<Either<'Cancelled', never>> {
  if (signal.aborted) return Promise.resolve(left('Cancelled'))

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(left('Cancelled')), {
      once: true,
    })
  })
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
