import { describe, expect, it } from 'vitest'

import { type Rejected, type ScopeSignal, type ScopeTask } from './async.ts'
import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type Mode = 'fork' | 'all' | 'race'

type FuzzError =
  | { readonly _tag: 'TaskFailed'; readonly id: number }
  | { readonly _tag: 'TaskAborted'; readonly id: number }

type FuzzValue = { readonly id: number; readonly value: string }
type RejectCause = { readonly _tag: 'RejectCause'; readonly id: number }
type ParentReason = { readonly _tag: 'ParentAbort'; readonly seed: number }

type SettleKind = 'right' | 'left' | 'reject'

type Operation =
  | { readonly _tag: 'Settle'; readonly id: number; readonly kind: SettleKind }
  | { readonly _tag: 'ParentAbort' }

type Scenario = {
  readonly seed: number
  readonly mode: Mode
  readonly taskCount: number
  readonly withParent: boolean
  readonly parentReason: ParentReason
  readonly operations: readonly Operation[]
}

type Expected =
  | {
      readonly _tag: 'Right'
      readonly value: unknown
      readonly abortIds: ReadonlySet<number>
      readonly terminalIndex: number
    }
  | {
      readonly _tag: 'Left'
      readonly error: unknown
      readonly abortIds: ReadonlySet<number>
      readonly terminalIndex: number
    }

type Deferred<T> = {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (cause: unknown) => void
}

type FuzzTask = {
  readonly id: number
  readonly value: FuzzValue
  readonly leftError: FuzzError
  readonly abortError: FuzzError
  readonly rejectCause: RejectCause
  readonly task: ScopeTask<FuzzError, FuzzValue>
  readonly abortReasons: unknown[]
  startCount: number
  state: 'pending' | 'right' | 'left' | 'rejected' | 'aborted'
  signal?: ScopeSignal
  settle: (kind: SettleKind) => void
}

describe('scoped signal fuzzer', () => {
  it('fuzzes fork/all/race settlement and abort interleavings', async () => {
    for (let seed = 1; seed <= 180; seed++) {
      const scenario = createScenario(seed)
      try {
        await runScenario(scenario)
      } catch (cause) {
        throw new Error(formatScenario(scenario), { cause })
      }
    }
  }, 10_000)
})

async function runScenario(scenario: Scenario): Promise<void> {
  const tasks = Array.from({ length: scenario.taskCount }, (_, id) =>
    createFuzzTask(id),
  )
  const expected = computeExpected(scenario, tasks)
  const controller = scenario.withParent ? new AbortController() : undefined
  const resultPromise =
    controller === undefined
      ? either(async function* ({ signal }) {
          return yield* runScopedMode(scenario.mode, signal, tasks)
        })
      : either(controller.signal, async function* ({ signal }) {
          return yield* runScopedMode(scenario.mode, signal, tasks)
        })

  await flushAsyncWork()
  for (const task of tasks) {
    expect(task.startCount, taskLabel(scenario, task)).toBe(1)
  }

  for (let index = 0; index < scenario.operations.length; index++) {
    const operation = scenario.operations[index] as Operation
    if (operation._tag === 'ParentAbort') {
      controller?.abort(scenario.parentReason)
    } else {
      tasks[operation.id]?.settle(operation.kind)
    }
    await flushAsyncWork()
    if (index === expected.terminalIndex) break
  }

  const result = await withTimeout(resultPromise, formatScenario(scenario))

  assertExpectedResult(result, expected, scenario)
  assertTaskInvariants(tasks, expected, scenario)

  controller?.abort({ _tag: 'LateAbort', seed: scenario.seed })
  await flushAsyncWork()
  assertTaskInvariants(tasks, expected, scenario)
}

async function* runScopedMode(
  mode: Mode,
  signal: ScopeSignal,
  tasks: readonly FuzzTask[],
): AsyncGenerator<Either<unknown, unknown>, unknown> {
  const scopedTasks = tasks.map((task) => task.task)

  if (mode === 'race') {
    const value = yield* await signal.race(scopedTasks)
    const after = yield* right('after' as const)
    return { mode, value, after }
  }

  if (mode === 'all') {
    const values = yield* await signal.all(scopedTasks)
    return { mode, values }
  }

  const forked: Promise<Either<unknown, FuzzValue>>[] = []
  forked.length = scopedTasks.length
  for (let index = 0; index < scopedTasks.length; index++) {
    forked[index] = signal.fork(
      scopedTasks[index] as ScopeTask<unknown, FuzzValue>,
    )
  }
  const values: FuzzValue[] = []
  values.length = forked.length
  for (let index = 0; index < forked.length; index++) {
    values[index] = yield* await (forked[index] as Promise<
      Either<unknown, FuzzValue>
    >)
  }
  return { mode, values }
}

function createFuzzTask(id: number): FuzzTask {
  const deferred = createDeferred<Either<FuzzError, FuzzValue>>()
  const value = { id, value: `value-${id}` }
  const leftError = { _tag: 'TaskFailed' as const, id }
  const abortError = { _tag: 'TaskAborted' as const, id }
  const rejectCause = { _tag: 'RejectCause' as const, id }
  const abortReasons: unknown[] = []

  const record: FuzzTask = {
    id,
    value,
    leftError,
    abortError,
    rejectCause,
    abortReasons,
    startCount: 0,
    state: 'pending',
    async task(signal) {
      record.startCount++
      record.signal = signal
      if (signal.aborted) {
        record.abortReasons.push(signal.reason)
        settleAbort(record)
      } else {
        signal.addEventListener(
          'abort',
          () => {
            record.abortReasons.push(signal.reason)
            settleAbort(record)
          },
          { once: true },
        )
      }
      return deferred.promise
    },
    settle(kind) {
      if (record.state !== 'pending') return

      if (kind === 'right') {
        record.state = 'right'
        deferred.resolve(right(value))
        return
      }

      if (kind === 'left') {
        record.state = 'left'
        deferred.resolve(left(leftError))
        return
      }

      record.state = 'rejected'
      deferred.reject(rejectCause)
    },
  }

  function settleAbort(task: FuzzTask): void {
    if (task.state !== 'pending') return

    task.state = 'aborted'
    deferred.resolve(left(abortError))
  }

  return record
}

function computeExpected(
  scenario: Scenario,
  tasks: readonly FuzzTask[],
): Expected {
  const pending = new Set(tasks.map((task) => task.id))
  const values: FuzzValue[] = []
  values.length = tasks.length

  for (let index = 0; index < scenario.operations.length; index++) {
    const operation = scenario.operations[index] as Operation
    if (operation._tag === 'ParentAbort') {
      return {
        _tag: 'Left',
        error: { _tag: 'Aborted', reason: scenario.parentReason },
        abortIds: new Set(pending),
        terminalIndex: index,
      }
    }

    const task = tasks[operation.id]
    if (task === undefined || !pending.has(task.id)) continue

    pending.delete(task.id)

    if (operation.kind === 'right') {
      if (scenario.mode === 'race') {
        return {
          _tag: 'Right',
          value: { mode: 'race', value: task.value, after: 'after' },
          abortIds: new Set(pending),
          terminalIndex: index,
        }
      }

      values[task.id] = task.value
      if (pending.size === 0) {
        return {
          _tag: 'Right',
          value: { mode: scenario.mode, values },
          abortIds: new Set(),
          terminalIndex: index,
        }
      }
      continue
    }

    return {
      _tag: 'Left',
      error:
        operation.kind === 'left'
          ? task.leftError
          : ({ _tag: 'Rejected', cause: task.rejectCause } satisfies Rejected),
      abortIds: new Set(pending),
      terminalIndex: index,
    }
  }

  throw new Error('Scenario did not contain a settling operation')
}

function assertExpectedResult(
  result: Either<unknown, unknown>,
  expected: Expected,
  scenario: Scenario,
): void {
  expect(result._tag, formatScenario(scenario)).toBe(expected._tag)

  if (result._tag === 'Right' && expected._tag === 'Right') {
    expect(result.value, formatScenario(scenario)).toEqual(expected.value)
    return
  }

  if (result._tag === 'Left' && expected._tag === 'Left') {
    expect(result.error, formatScenario(scenario)).toEqual(expected.error)
  }
}

function assertTaskInvariants(
  tasks: readonly FuzzTask[],
  expected: Expected,
  scenario: Scenario,
): void {
  for (const task of tasks) {
    const label = taskLabel(scenario, task)
    expect(task.startCount, label).toBe(1)
    expect(task.abortReasons.length, label).toBeLessThanOrEqual(1)
    expect(task.abortReasons.length, label).toBe(
      expected.abortIds.has(task.id) ? 1 : 0,
    )

    if (expected.abortIds.has(task.id)) {
      expect(task.state, label).toBe('aborted')
      expect(task.signal?.aborted, label).toBe(true)
    }
  }
}

function createScenario(seed: number): Scenario {
  const random = mulberry32(seed)
  const mode = pick(random, ['fork', 'all', 'race'] as const)
  const taskCount = 1 + randomInt(random, 5)
  const ids = shuffled(
    random,
    Array.from({ length: taskCount }, (_, id) => id),
  )
  const operations: Operation[] = ids.map((id) => ({
    _tag: 'Settle',
    id,
    kind: pick(random, ['right', 'right', 'right', 'left', 'reject'] as const),
  }))
  const hasParentAbort = random() < 0.3
  if (hasParentAbort) {
    operations.splice(randomInt(random, operations.length + 1), 0, {
      _tag: 'ParentAbort',
    })
  }

  return {
    seed,
    mode,
    taskCount,
    withParent: hasParentAbort || random() < 0.5,
    parentReason: { _tag: 'ParentAbort', seed },
    operations,
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {}
  let reject: (cause: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function randomInt(random: () => number, exclusiveMax: number): number {
  return Math.floor(random() * exclusiveMax)
}

function pick<const T extends readonly unknown[]>(
  random: () => number,
  values: T,
): T[number] {
  return values[randomInt(random, values.length)] as T[number]
}

function shuffled<T>(random: () => number, values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const swapIndex = randomInt(random, index + 1)
    const value = values[index] as T
    values[index] = values[swapIndex] as T
    values[swapIndex] = value
  }
  return values
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 500)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function formatScenario(scenario: Scenario): string {
  return `seed=${scenario.seed} mode=${scenario.mode} parent=${scenario.withParent} ops=${scenario.operations
    .map((operation) =>
      operation._tag === 'ParentAbort'
        ? 'abort'
        : `${operation.id}:${operation.kind}`,
    )
    .join(',')}`
}

function taskLabel(scenario: Scenario, task: FuzzTask): string {
  return `${formatScenario(scenario)} task=${task.id} state=${task.state}`
}
