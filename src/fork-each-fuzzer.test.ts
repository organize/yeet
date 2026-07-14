import { describe, expect, it } from 'vitest'

import {
  type Exit,
  type ForkEachIterator,
  forkEachStopped,
  rejected,
} from './async.ts'
import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type TaskError = { readonly _tag: 'TaskFailed'; readonly index: number }
type TaskValue = { readonly index: number }
type Completion = {
  readonly index: number
  readonly result: Exit<TaskError, TaskValue>
}

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
}

describe('forkEach state-machine fuzzer', () => {
  it('fuzzes settlement order, buffering, exhaustion, and concurrency invariants', async () => {
    for (let seed = 1; seed <= 120; seed++) {
      try {
        await fuzzCompletions(seed)
      } catch (cause) {
        throw new Error(`forkEach completion seed ${seed}`, { cause })
      }
    }
  }, 10_000)

  it('fuzzes stop, parent abort, nested teardown, and cleanup rejection', async () => {
    for (let seed = 1; seed <= 80; seed++) {
      try {
        await fuzzTeardown(seed)
      } catch (cause) {
        throw new Error(`forkEach teardown seed ${seed}`, { cause })
      }
    }
  }, 10_000)

  it('fuzzes source failures while bounded children are active', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      try {
        await fuzzSourceFailure(seed)
      } catch (cause) {
        throw new Error(`forkEach source-failure seed ${seed}`, { cause })
      }
    }
  }, 10_000)
})

async function fuzzCompletions(seed: number): Promise<void> {
  const random = randomFor(seed)
  const count = 1 + random(8)
  const concurrency = 1 + random(Math.min(4, count))
  const tasks = Array.from({ length: count }, () =>
    deferred<Either<TaskError, TaskValue>>(),
  )
  const states: TaskState[] = Array.from({ length: count }, () => 'idle')
  const expected: Completion[] = []
  const iteratorReady =
    deferred<ForkEachIterator<number, TaskError, TaskValue>>()
  const release = deferred<void>()
  let active = 0
  let peakActive = 0
  let sourcePulls = 0
  let concurrentPulls = 0
  let peakSourcePulls = 0
  let sourceIndex = 0

  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          concurrentPulls++
          peakSourcePulls = Math.max(peakSourcePulls, concurrentPulls)
          sourcePulls++
          await Promise.resolve()
          concurrentPulls--
          return sourceIndex < count
            ? { done: false, value: sourceIndex++ }
            : { done: true, value: undefined }
        },
      }
    },
  }

  const runner = either(
    // oxlint-disable-next-line require-yield
    async function* ({ signal }) {
      const iterator = signal.forkEach(
        source,
        { concurrency },
        async (_item, _child, index) => {
          states[index] = 'active'
          active++
          peakActive = Math.max(peakActive, active)
          try {
            return await tasks[index]!.promise
          } finally {
            active--
          }
        },
      )
      iteratorReady.resolve(iterator)
      await release.promise
      return 'done' as const
    },
  )

  const iterator = await iteratorReady.promise
  let next = iterator.next()
  await flushAsyncWork()

  const delivered: Completion[] = []
  while (delivered.length < count) {
    const activeIndices = states.flatMap((state, index) =>
      state === 'active' ? [index] : [],
    )
    expect(activeIndices.length).toBeGreaterThan(0)

    const batchSize = Math.min(
      activeIndices.length,
      expected.length === 0 && random(3) === 0 ? 2 : 1,
    )
    for (let offset = 0; offset < batchSize; offset++) {
      const available = states.flatMap((state, index) =>
        state === 'active' ? [index] : [],
      )
      const index = available[random(available.length)] as number
      const kind = random(3)
      states[index] = 'settled'
      if (kind === 0) {
        const result = right({ index })
        expected.push({ index, result })
        tasks[index]!.resolve(result)
      } else if (kind === 1) {
        const result = left({ _tag: 'TaskFailed', index } as const)
        expected.push({ index, result })
        tasks[index]!.resolve(result)
      } else {
        const cause = { _tag: 'TaskRejected', index } as const
        expected.push({ index, result: left(rejected(cause)) })
        tasks[index]!.reject(cause)
      }
      await flushAsyncWork()
    }

    while (expected.length > 0) {
      const step = await next
      expect(step.done).toBe(false)
      if (step.done) throw new Error('iterator ended before every task settled')

      const wanted = expected.shift() as Completion
      expect(step.value.index).toBe(wanted.index)
      expectEither(step.value.result, wanted.result)
      delivered.push(step.value)
      next = iterator.next()
      await flushAsyncWork()

      expect(peakActive).toBeLessThanOrEqual(concurrency)
      expect(peakSourcePulls).toBe(1)
    }
  }

  expect((await next).done).toBe(true)
  expect(sourcePulls).toBe(count + 1)
  release.resolve()
  expectEither(await runner, right('done'))
}

async function fuzzTeardown(seed: number): Promise<void> {
  type TeardownError =
    | { readonly nested: number }
    | { readonly stopped: number }

  const random = randomFor(seed)
  const concurrency = 2 + random(3)
  const controller = new AbortController()
  const iteratorReady =
    deferred<ForkEachIterator<number, TeardownError, TaskValue>>()
  const release = deferred<void>()
  const winner = deferred<Either<never, TaskValue>>()
  const taskCleanupCauses = new Map<number, unknown>()
  const childReasons = new Map<number, unknown>()
  const nestedReasons = new Map<number, unknown>()
  const sourceCleanupCause = random(4) === 0 ? { source: seed } : undefined
  let sourceReason: unknown
  let sourceIndex = 0

  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return { done: false, value: sourceIndex++ }
        },
        async return(reason?: unknown) {
          sourceReason = reason
          if (sourceCleanupCause !== undefined) throw sourceCleanupCause
          return { done: true, value: undefined }
        },
      }
    },
  }

  const runner = either(
    controller.signal,
    // oxlint-disable-next-line require-yield
    async function* ({ signal }) {
      const iterator = signal.forkEach<number, TeardownError, TaskValue>(
        source,
        { concurrency },
        async (_item, child, index) => {
          if (index === 0) return await winner.promise

          if (index % 2 === 0) {
            void child.fork(
              async (grandchild) =>
                await new Promise<Either<{ readonly nested: number }, never>>(
                  (resolve) => {
                    grandchild.addEventListener(
                      'abort',
                      () => {
                        nestedReasons.set(index, grandchild.reason)
                        resolve(left({ nested: index }))
                      },
                      { once: true },
                    )
                  },
                ),
            )
          }

          return await new Promise<Either<{ readonly stopped: number }, never>>(
            (resolve, rejectPromise) => {
              child.addEventListener(
                'abort',
                () => {
                  childReasons.set(index, child.reason)
                  if ((seed + index) % 3 === 0) {
                    const cause = { cleanup: index }
                    taskCleanupCauses.set(index, cause)
                    rejectPromise(cause)
                  } else resolve(left({ stopped: index }))
                },
                { once: true },
              )
            },
          )
        },
      )
      iteratorReady.resolve(iterator)
      await release.promise
      return 'done' as const
    },
  )

  const iterator = await iteratorReady.promise
  const first = iterator.next()
  await flushAsyncWork()
  winner.resolve(right({ index: 0 }))
  const firstStep = await first
  expect(firstStep.done).toBe(false)
  if (firstStep.done) throw new Error('winner completion was not delivered')
  expect(firstStep.value.item).toBe(0)
  expect(firstStep.value.index).toBe(0)
  expectEither(firstStep.value.result, right({ index: 0 }))

  const parentAbort = random(3) === 0
  const reason = parentAbort
    ? ({ _tag: 'ParentAbort', seed } as const)
    : forkEachStopped()
  if (parentAbort) controller.abort(reason)
  await iterator.return?.()
  release.resolve()

  const result = await runner
  const cleanup = [...taskCleanupCauses.entries()]
    .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
    .map(([, cause]) => rejected(cause))
  if (sourceCleanupCause !== undefined)
    cleanup.push(rejected(sourceCleanupCause))

  const primary = parentAbort
    ? left({ _tag: 'Aborted', reason } as const)
    : cleanup.length === 0
      ? right('done' as const)
      : cleanup.length === 1
        ? left(cleanup[0])
        : left({
            _tag: 'Suppressed',
            error: cleanup[0],
            suppressed: cleanup.slice(1),
          } as const)
  const expected =
    parentAbort && cleanup.length > 0
      ? left({
          _tag: 'Suppressed',
          error: primary._tag === 'Left' ? primary.error : undefined,
          suppressed: cleanup,
        } as const)
      : primary

  expectEither(result, expected)
  expect(sourceReason).toEqual(reason)
  for (const [index, childReason] of childReasons) {
    expect(childReason, `child ${index}`).toEqual(reason)
  }
  for (const [index, nestedReason] of nestedReasons) {
    expect(nestedReason, `nested child ${index}`).toEqual(reason)
  }

  controller.abort({ _tag: 'LateAbort', seed })
  await iterator[Symbol.asyncDispose]()
  expectEither(result, expected)
}

async function fuzzSourceFailure(seed: number): Promise<void> {
  const random = randomFor(seed)
  const concurrency = 1 + random(4)
  const sourceCause = { _tag: 'SourceFailed', seed } as const
  const cleanupCauses: unknown[] = []
  let sourceIndex = 0

  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (sourceIndex === concurrency) throw sourceCause
          return { done: false, value: sourceIndex++ }
        },
      }
    },
  }

  const result = await either(async function* ({ signal }) {
    for await (const completion of signal.forkEach(
      source,
      { concurrency: concurrency + 1 },
      async (_item, child, index) =>
        await new Promise<Either<{ readonly stopped: number }, never>>(
          (resolve, rejectPromise) => {
            child.addEventListener(
              'abort',
              () => {
                if ((seed + index) % 3 === 0) {
                  const cause = { cleanup: index }
                  cleanupCauses.push(cause)
                  rejectPromise(cause)
                } else resolve(left({ stopped: index }))
              },
              { once: true },
            )
          },
        ),
    )) {
      yield* completion.result
    }
    return 'unreachable' as const
  })

  const cleanup = cleanupCauses.map((cause) => rejected(cause))
  const expected =
    cleanup.length === 0
      ? left(rejected(sourceCause))
      : left({
          _tag: 'Suppressed',
          error: rejected(sourceCause),
          suppressed: cleanup,
        })
  expectEither(result, expected)
}

type TaskState = 'idle' | 'active' | 'settled'

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function randomFor(seed: number): (max: number) => number {
  let state = seed >>> 0
  return (max) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state % max
  }
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

function expectEither(
  actual: Either<unknown, unknown>,
  expected: Either<unknown, unknown>,
): void {
  expect(actual._tag).toBe(expected._tag)
  if (actual._tag === 'Left' && expected._tag === 'Left') {
    expect(actual.error).toEqual(expected.error)
    return
  }
  if (actual._tag === 'Right' && expected._tag === 'Right') {
    expect(actual.value).toEqual(expected.value)
  }
}
