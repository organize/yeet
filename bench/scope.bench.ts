import { bench, describe } from 'vitest'

import { forkEachStopped, rejected, siblingSettled } from '../src/async.ts'
import { either } from '../src/combinators.ts'
import { type Either, left, right } from '../src/either.ts'
import { BENCH_OPTS, readPositiveInt } from './bench-options.ts'

type Candidate = (
  signal: AbortSignal,
) => Either<unknown, unknown> | PromiseLike<Either<unknown, unknown>>

const BENCH_BATCH = readPositiveInt('SCOPE_BENCH_BATCH', 16)
const FORK_EACH_BENCH_BATCH = readPositiveInt('FORK_EACH_BENCH_BATCH', 8)
const RESOURCE_BENCH_BATCH = readPositiveInt('RESOURCE_BENCH_BATCH', 16)
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

type EachMapper = (
  item: number,
  signal: AbortSignal,
  index: number,
) => Either<unknown, number> | PromiseLike<Either<unknown, number>>

type EachScenario = {
  readonly source: () => Iterable<number> | AsyncIterable<number>
  readonly concurrency: number
  readonly task: EachMapper
  readonly limit?: number
}

const immediateEach: EachScenario = {
  source: () => [0, 1, 2, 3, 4, 5, 6, 7],
  concurrency: 4,
  task: (item) => right(item),
}

const mixedEach: EachScenario = {
  source: () => [0, 1, 2, 3, 4, 5, 6, 7],
  concurrency: 4,
  task: (item) => (item % 3 === 0 ? left(item) : right(item)),
}

const outOfOrderEach: EachScenario = {
  source: () => [0, 1, 2, 3, 4, 5, 6, 7],
  concurrency: 4,
  task: async (item) => {
    for (let turn = 0; turn < (7 - item) % 4; turn++) await Promise.resolve()
    return right(item)
  },
}

const asyncSourceEach: EachScenario = {
  source: async function* () {
    for (let item = 0; item < 8; item++) {
      await Promise.resolve()
      yield item
    }
  },
  concurrency: 4,
  task: (item) => right(item),
}

const earlyBreakEach: EachScenario = {
  source: () => [0, 1, 2, 3, 4, 5, 6, 7],
  concurrency: 4,
  // oxlint-disable-next-line typescript/promise-function-async
  task: (item, signal) => (item === 0 ? right(item) : waitForEachAbort(signal)),
  limit: 1,
}

describe('scoped completion stream: immediate success', () => {
  benchmarkEachPair(immediateEach)
})

describe('scoped completion stream: mixed failures', () => {
  benchmarkEachPair(mixedEach)
})

describe('scoped completion stream: out-of-order async completion', () => {
  benchmarkEachPair(outOfOrderEach)
})

describe('scoped completion stream: async source backpressure', () => {
  benchmarkEachPair(asyncSourceEach)
})

describe('scoped completion stream: early-break cancellation', () => {
  benchmarkEachPair(earlyBreakEach)
})

type ResourceTiming = 'sync' | 'immediate' | 'pending'
type ResourceScenario = {
  readonly count: number
  readonly timing: ResourceTiming
  readonly fail: boolean
}

for (const scenario of [
  { count: 1, timing: 'sync', fail: false },
  { count: 1, timing: 'immediate', fail: false },
  { count: 1, timing: 'pending', fail: false },
  { count: 8, timing: 'sync', fail: false },
  { count: 8, timing: 'sync', fail: true },
] as const satisfies readonly ResourceScenario[]) {
  describe(`scoped resources: ${scenario.count} ${scenario.timing} ${scenario.fail ? 'Left' : 'success'}`, () =>
    benchmarkResourcePair(scenario))
}

describe('scoped resources: native async disposable', () => {
  bench(
    'native await using',
    async () => consumeResourceBatch(nativeUsingResource),
    BENCH_OPTS,
  )
  bench(
    'yeet signal.acquire native disposable',
    async () => consumeResourceBatch(yeetNativeResource),
    BENCH_OPTS,
  )
})

describe('scoped resources: abort during acquisition', () => {
  bench(
    'manual AsyncDisposableStack + abort check',
    async () => consumeResourceBatch(manualAbortDuringAcquire),
    BENCH_OPTS,
  )
  bench(
    'yeet signal.acquire',
    async () => consumeResourceBatch(yeetAbortDuringAcquire),
    BENCH_OPTS,
  )
})

describe('scoped resources: unused paths', () => {
  bench(
    'async either without signal',
    async () => consumeResourceBatch(yeetWithoutSignal),
    BENCH_OPTS,
  )
  bench(
    'async either with signal, no acquire',
    async () => consumeResourceBatch(yeetSignalOnly),
    BENCH_OPTS,
  )
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

function benchmarkEachPair(scenario: EachScenario): void {
  bench(
    'manual bounded completion pool',
    async () => {
      await consumeEachBatch(manualEach, scenario)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet signal.forkEach',
    async () => {
      await consumeEachBatch(yeetEach, scenario)
    },
    BENCH_OPTS,
  )
}

function benchmarkResourcePair(scenario: ResourceScenario): void {
  if (scenario.count === 1) {
    bench(
      'manual try/finally',
      async () =>
        await consumeResourceBatch(
          async () => await manualSingleResource(scenario),
        ),
      BENCH_OPTS,
    )
  }
  bench(
    'manual AsyncDisposableStack',
    async () =>
      await consumeResourceBatch(async () => await manualResources(scenario)),
    BENCH_OPTS,
  )
  bench(
    'yeet signal.acquire',
    async () =>
      await consumeResourceBatch(async () => await yeetResources(scenario)),
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

async function consumeEachBatch(
  run: (scenario: EachScenario) => Promise<Either<unknown, unknown>>,
  scenario: EachScenario,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < FORK_EACH_BENCH_BATCH; batch++) {
    value = await run(scenario)
  }
  sink.value = value
}

async function consumeResourceBatch(
  run: () => Promise<Either<unknown, unknown>>,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < RESOURCE_BENCH_BATCH; batch++) value = await run()
  sink.value = value
}

type BenchResource = { readonly index: number }

async function manualSingleResource(
  scenario: ResourceScenario,
): Promise<Either<'Stop', number>> {
  const resource = await openBenchResource(scenario.timing, 0)
  try {
    return scenario.fail ? left('Stop' as const) : right(1)
  } finally {
    releaseBenchResource(resource)
  }
}

async function manualResources(
  scenario: ResourceScenario,
): Promise<Either<'Stop', number>> {
  const stack = new AsyncDisposableStack()
  try {
    for (let index = 0; index < scenario.count; index++) {
      const resource = await openBenchResource(scenario.timing, index)
      stack.adopt(resource, releaseBenchResource)
    }
    return scenario.fail ? left('Stop' as const) : right(scenario.count)
  } finally {
    await stack.disposeAsync()
  }
}

async function yeetResources(
  scenario: ResourceScenario,
): Promise<Either<unknown, number>> {
  return await either(async function* ({ signal }) {
    for (let index = 0; index < scenario.count; index++) {
      yield* signal.acquire(
        // Preserve the synchronous acquisition benchmark case.
        // oxlint-disable-next-line typescript/promise-function-async
        () => openBenchResource(scenario.timing, index),
        releaseBenchResource,
      )
    }
    return scenario.fail ? left('Stop' as const) : scenario.count
  })
}

function openBenchResource(
  timing: ResourceTiming,
  index: number,
): BenchResource | Promise<BenchResource> {
  const resource = { index }
  if (timing === 'sync') return resource
  if (timing === 'immediate') return Promise.resolve(resource)
  return Promise.resolve().then(() => resource)
}

function releaseBenchResource(_resource: BenchResource): void {}

async function nativeUsingResource(): Promise<Either<never, number>> {
  await using resource = {
    index: 1,
    async [Symbol.asyncDispose]() {},
  }
  return right(resource.index)
}

async function yeetNativeResource(): Promise<Either<unknown, number>> {
  return await either(async function* ({ signal }) {
    const resource = yield* signal.acquire(() => ({
      index: 1,
      async [Symbol.asyncDispose]() {},
    }))
    return resource.index
  })
}

async function manualAbortDuringAcquire(): Promise<Either<unknown, never>> {
  const controller = new AbortController()
  const stack = new AsyncDisposableStack()
  try {
    const pending = Promise.resolve().then(() => ({ index: 1 }))
    controller.abort('Stop')
    stack.adopt(await pending, releaseBenchResource)
    return left({ _tag: 'Aborted', reason: controller.signal.reason })
  } finally {
    await stack.disposeAsync()
  }
}

async function yeetAbortDuringAcquire(): Promise<Either<unknown, unknown>> {
  const controller = new AbortController()
  return await either(controller.signal, async function* (_raise, signal) {
    return yield* signal.acquire(async () => {
      const pending = Promise.resolve().then(() => ({ index: 1 }))
      controller.abort('Stop')
      return await pending
    }, releaseBenchResource)
  })
}

async function yeetWithoutSignal(): Promise<Either<never, number>> {
  // oxlint-disable-next-line require-yield
  return await either(async function* () {
    return 1
  })
}

async function yeetSignalOnly(): Promise<Either<never, number>> {
  return await either(
    // oxlint-disable-next-line require-yield
    async function* ({ signal }) {
      void signal.aborted
      return 1
    },
  )
}

async function yeetFirst(
  tasks: readonly Candidate[],
): Promise<Either<unknown, unknown>> {
  return await either(async function* ({ signal }) {
    return yield* await signal.forkFirst(tasks)
  })
}

async function yeetEach(
  scenario: EachScenario,
): Promise<Either<unknown, unknown>> {
  return await either(
    // oxlint-disable-next-line require-yield
    async function* ({ signal }) {
      const completions: unknown[] = []
      for await (const completion of signal.forkEach(
        scenario.source(),
        { concurrency: scenario.concurrency },
        scenario.task,
      )) {
        completions.push(completion)
        if (
          scenario.limit !== undefined &&
          completions.length === scenario.limit
        )
          break
      }
      return completions
    },
  )
}

async function manualEach(
  scenario: EachScenario,
): Promise<Either<unknown, unknown>> {
  const completions: unknown[] = []
  for await (const completion of manualEachIterator(scenario)) {
    completions.push(completion)
    if (scenario.limit !== undefined && completions.length === scenario.limit)
      break
  }
  return right(completions)
}

async function* manualEachIterator(
  scenario: EachScenario,
): AsyncGenerator<unknown> {
  const input = scenario.source()
  const asyncIterator = (input as AsyncIterable<number>)[Symbol.asyncIterator]
  const source =
    typeof asyncIterator === 'function'
      ? asyncIterator.call(input)
      : (input as Iterable<number>)[Symbol.iterator]()
  const active = new Map<
    number,
    {
      readonly controller: AbortController
      readonly promise: Promise<{
        readonly item: number
        readonly index: number
        readonly result: Either<unknown, number>
      }>
    }
  >()
  let index = 0
  let sourceDone = false

  const refill = async (): Promise<void> => {
    while (!sourceDone && active.size < scenario.concurrency) {
      const next = await source.next()
      if (next.done) {
        sourceDone = true
        return
      }

      const taskIndex = index++
      const controller = new AbortController()
      const promise = Promise.try(() =>
        scenario.task(next.value, controller.signal, taskIndex),
      ).then(
        (result) => ({ item: next.value, index: taskIndex, result }),
        (cause) => ({
          item: next.value,
          index: taskIndex,
          result: left(rejected(cause)),
        }),
      )
      active.set(taskIndex, { controller, promise })
    }
  }

  try {
    await refill()
    while (active.size > 0) {
      const completion = await Promise.race(
        [...active.values()].map(
          // oxlint-disable-next-line typescript/promise-function-async
          ({ promise }) => promise,
        ),
      )
      active.delete(completion.index)
      yield completion
      await refill()
    }
  } finally {
    const reason = forkEachStopped()
    for (const { controller } of active.values()) controller.abort(reason)
    await Promise.allSettled(
      [...active.values()].map(
        // oxlint-disable-next-line typescript/promise-function-async
        ({ promise }) => promise,
      ),
    )
    if (!sourceDone) await source.return?.(reason)
  }
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

// oxlint-disable-next-line typescript/promise-function-async
function waitForEachAbort(
  signal: AbortSignal,
): Promise<Either<'Cancelled', never>> {
  if (signal.aborted) return Promise.resolve(left('Cancelled'))

  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(left('Cancelled')), {
      once: true,
    })
  })
}
