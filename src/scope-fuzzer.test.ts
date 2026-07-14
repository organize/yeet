import { describe, expect, it } from 'vitest'

import { type Rejected, type ScopeSignal, type ScopeTask } from './async.ts'
import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'

type Mode = 'fork' | 'forkAll' | 'forkFirst' | 'forkRace'

type FuzzError =
  | { readonly _tag: 'TaskFailed'; readonly id: number }
  | { readonly _tag: 'TaskAborted'; readonly id: number }

type FuzzValue = { readonly id: number; readonly value: string }
type RejectCause = { readonly _tag: 'RejectCause'; readonly id: number }
type AbortRejectCause = {
  readonly _tag: 'AbortRejectCause'
  readonly id: number
}
type ParentReason = { readonly _tag: 'ParentAbort'; readonly seed: number }

type SettleKind = 'right' | 'left' | 'reject' | 'reject-on-abort'

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

type NestedScenario = {
  readonly seed: number
  readonly depth: number
  readonly settleKind: Exclude<SettleKind, 'reject-on-abort'>
  readonly parentFirst: boolean
  readonly parentReason: ParentReason
}

type Expected =
  | {
      readonly _tag: 'Right'
      readonly value: unknown
      readonly abortIds: ReadonlySet<number>
      readonly cleanupRejectIds: ReadonlySet<number>
      readonly terminalIndex: number
    }
  | {
      readonly _tag: 'Left'
      readonly error: unknown
      readonly abortIds: ReadonlySet<number>
      readonly cleanupRejectIds: ReadonlySet<number>
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
  readonly abortRejectCause: AbortRejectCause
  readonly task: ScopeTask<FuzzError, FuzzValue>
  readonly abortReasons: unknown[]
  startCount: number
  rejectOnAbort: boolean
  state:
    | 'pending'
    | 'right'
    | 'left'
    | 'rejected'
    | 'aborted'
    | 'abort-rejected'
  signal?: ScopeSignal
  settle: (kind: SettleKind) => void
}

describe('scoped signal fuzzer', () => {
  it('fuzzes fork/forkAll/forkFirst/forkRace settlement and abort interleavings', async () => {
    for (let seed = 1; seed <= 240; seed++) {
      const scenario = createScenario(seed)
      try {
        await runScenario(scenario)
      } catch (cause) {
        throw new Error(formatScenario(scenario), { cause })
      }
    }
  }, 10_000)

  it('fuzzes nested fork teardown and parent abort interleavings', async () => {
    for (let seed = 1; seed <= 120; seed++) {
      const scenario = createNestedScenario(seed)
      try {
        await runNestedScenario(scenario)
      } catch (cause) {
        throw new Error(formatNestedScenario(scenario), { cause })
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

async function runNestedScenario(scenario: NestedScenario): Promise<void> {
  const leaf = createFuzzTask(0)
  const records = Array.from({ length: scenario.depth }, (_, level) => ({
    level,
    startCount: 0,
    abortReasons: [] as unknown[],
    signal: undefined as ScopeSignal | undefined,
  }))
  const controller = new AbortController()
  const resultPromise = either(controller.signal, async function* ({ signal }) {
    return yield* await signal.fork(
      createNestedTask(records, leaf, 0, scenario.depth),
    )
  })

  await flushAsyncWork()
  for (const record of records) {
    expect(record.startCount, formatNestedScenario(scenario)).toBe(1)
  }
  expect(leaf.startCount, formatNestedScenario(scenario)).toBe(1)

  if (scenario.parentFirst) {
    controller.abort(scenario.parentReason)
  } else {
    leaf.settle(scenario.settleKind)
  }

  await flushAsyncWork()
  const result = await withTimeout(
    resultPromise,
    formatNestedScenario(scenario),
  )
  assertNestedExpectedResult(result, scenario, leaf)

  controller.abort({ _tag: 'LateNestedAbort', seed: scenario.seed })
  await flushAsyncWork()

  if (scenario.parentFirst) {
    for (const record of records) {
      expect(record.signal?.aborted, formatNestedScenario(scenario)).toBe(true)
      expect(record.abortReasons).toEqual([scenario.parentReason])
    }
    expect(leaf.signal?.aborted, formatNestedScenario(scenario)).toBe(true)
    expect(leaf.abortReasons).toEqual([scenario.parentReason])
  }
}

function createNestedTask(
  records: readonly {
    startCount: number
    abortReasons: unknown[]
    signal: ScopeSignal | undefined
  }[],
  leaf: FuzzTask,
  level: number,
  depth: number,
): ScopeTask<unknown, unknown> {
  return async (signal) => {
    const record = records[level]
    if (record !== undefined) {
      record.startCount++
      record.signal = signal
      if (signal.aborted) record.abortReasons.push(signal.reason)
      else {
        signal.addEventListener(
          'abort',
          () => record.abortReasons.push(signal.reason),
          { once: true },
        )
      }
    }

    if (level === depth - 1) return leaf.task(signal)
    return await signal.fork(createNestedTask(records, leaf, level + 1, depth))
  }
}

async function* runScopedMode(
  mode: Mode,
  signal: ScopeSignal,
  tasks: readonly FuzzTask[],
): AsyncGenerator<Either<unknown, unknown>, unknown> {
  const scopedTasks = tasks.map((task) => task.task)

  if (mode === 'forkRace') {
    const value = yield* await signal.forkRace(scopedTasks)
    const after = yield* right('after' as const)
    return { mode, value, after }
  }

  if (mode === 'forkFirst') {
    const value = yield* await signal.forkFirst(scopedTasks)
    const after = yield* right('after' as const)
    return { mode, value, after }
  }

  if (mode === 'forkAll') {
    const values = yield* await signal.forkAll(scopedTasks)
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
  const abortRejectCause = { _tag: 'AbortRejectCause' as const, id }
  const abortReasons: unknown[] = []

  const record: FuzzTask = {
    id,
    value,
    leftError,
    abortError,
    rejectCause,
    abortRejectCause,
    abortReasons,
    startCount: 0,
    rejectOnAbort: false,
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

      if (kind === 'reject-on-abort') {
        record.rejectOnAbort = true
        if (record.signal?.aborted === true) settleAbort(record)
        return
      }

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

    if (task.rejectOnAbort) {
      task.state = 'abort-rejected'
      deferred.reject(task.abortRejectCause)
      return
    }

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
  const rejectOnAbort = new Set<number>()
  const values: FuzzValue[] = []
  values.length = tasks.length
  const errors: unknown[] = []
  errors.length = tasks.length

  for (let index = 0; index < scenario.operations.length; index++) {
    const operation = scenario.operations[index] as Operation
    if (operation._tag === 'ParentAbort') {
      const cleanupRejectIds = intersectSets(pending, rejectOnAbort)
      return {
        _tag: 'Left',
        error: withCleanupFailures(
          { _tag: 'Aborted', reason: scenario.parentReason },
          cleanupFailuresForIds(cleanupRejectIds, tasks),
        ),
        abortIds: new Set(pending),
        cleanupRejectIds,
        terminalIndex: index,
      }
    }

    const task = tasks[operation.id]
    if (task === undefined || !pending.has(task.id)) continue

    if (operation.kind === 'reject-on-abort') {
      rejectOnAbort.add(task.id)
      continue
    }

    pending.delete(task.id)

    if (operation.kind === 'right') {
      if (scenario.mode === 'forkRace' || scenario.mode === 'forkFirst') {
        const cleanupRejectIds = intersectSets(pending, rejectOnAbort)
        const cleanupFailures = cleanupFailuresForIds(cleanupRejectIds, tasks)
        if (cleanupFailures.length > 0) {
          return {
            _tag: 'Left',
            error: primaryFromCleanupFailures(cleanupFailures),
            abortIds: new Set(pending),
            cleanupRejectIds,
            terminalIndex: index,
          }
        }

        return {
          _tag: 'Right',
          value: { mode: scenario.mode, value: task.value, after: 'after' },
          abortIds: new Set(pending),
          cleanupRejectIds,
          terminalIndex: index,
        }
      }

      values[task.id] = task.value
      if (pending.size === 0) {
        return {
          _tag: 'Right',
          value: { mode: scenario.mode, values },
          abortIds: new Set(),
          cleanupRejectIds: new Set(),
          terminalIndex: index,
        }
      }
      continue
    }

    const taskError =
      operation.kind === 'left'
        ? task.leftError
        : ({ _tag: 'Rejected', cause: task.rejectCause } satisfies Rejected)

    if (scenario.mode === 'forkFirst') {
      errors[task.id] = taskError
      if (pending.size > 0) continue

      return {
        _tag: 'Left',
        error: errors,
        abortIds: new Set(),
        cleanupRejectIds: new Set(),
        terminalIndex: index,
      }
    }

    const cleanupRejectIds = intersectSets(pending, rejectOnAbort)
    return {
      _tag: 'Left',
      error: withCleanupFailures(
        taskError,
        cleanupFailuresForIds(cleanupRejectIds, tasks),
      ),
      abortIds: new Set(pending),
      cleanupRejectIds,
      terminalIndex: index,
    }
  }

  throw new Error('Scenario did not contain a settling operation')
}

function intersectSets(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): ReadonlySet<number> {
  const result = new Set<number>()
  for (const value of left) {
    if (right.has(value)) result.add(value)
  }
  return result
}

function cleanupFailuresForIds(
  ids: ReadonlySet<number>,
  tasks: readonly FuzzTask[],
): readonly Rejected[] {
  return Array.from(ids, (id) => ({
    _tag: 'Rejected' as const,
    cause: (tasks[id] as FuzzTask).abortRejectCause,
  }))
}

function primaryFromCleanupFailures(
  cleanupFailures: readonly Rejected[],
): unknown {
  const [first, ...rest] = cleanupFailures
  return rest.length === 0
    ? first
    : { _tag: 'Suppressed', error: first, suppressed: rest }
}

function withCleanupFailures(
  primary: unknown,
  cleanupFailures: readonly Rejected[],
): unknown {
  return cleanupFailures.length === 0
    ? primary
    : {
        _tag: 'Suppressed',
        error: primary,
        suppressed: cleanupFailures,
      }
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
      expect(task.state, label).toBe(
        expected.cleanupRejectIds.has(task.id) ? 'abort-rejected' : 'aborted',
      )
      expect(task.signal?.aborted, label).toBe(true)
    }
  }
}

function assertNestedExpectedResult(
  result: Either<unknown, unknown>,
  scenario: NestedScenario,
  leaf: FuzzTask,
): void {
  const label = formatNestedScenario(scenario)

  if (scenario.parentFirst) {
    expect(result._tag, label).toBe('Left')
    if (result._tag === 'Left')
      expect(result.error, label).toEqual({
        _tag: 'Aborted',
        reason: scenario.parentReason,
      })
    expect(leaf.state, label).toBe('aborted')
    return
  }

  if (scenario.settleKind === 'right') {
    expect(result._tag, label).toBe('Right')
    if (result._tag === 'Right') expect(result.value, label).toEqual(leaf.value)
    return
  }

  if (scenario.settleKind === 'left') {
    expect(result._tag, label).toBe('Left')
    if (result._tag === 'Left')
      expect(result.error, label).toEqual(leaf.leftError)
    return
  }

  expect(result._tag, label).toBe('Left')
  if (result._tag === 'Left')
    expect(result.error, label).toEqual({
      _tag: 'Rejected',
      cause: leaf.rejectCause,
    })
}

function createScenario(seed: number): Scenario {
  const random = mulberry32(seed)
  const mode = pick(random, [
    'fork',
    'forkAll',
    'forkFirst',
    'forkRace',
  ] as const)
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

  for (const id of ids) {
    if (random() >= 0.35) continue
    operations.splice(randomInt(random, operations.length), 0, {
      _tag: 'Settle',
      id,
      kind: 'reject-on-abort',
    })
  }

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

function createNestedScenario(seed: number): NestedScenario {
  const random = mulberry32(seed)
  return {
    seed,
    depth: 1 + randomInt(random, 4),
    settleKind: pick(random, ['right', 'left', 'reject'] as const),
    parentFirst: random() < 0.5,
    parentReason: { _tag: 'ParentAbort', seed },
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
  return values[randomInt(random, values.length)]
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

function formatNestedScenario(scenario: NestedScenario): string {
  return `seed=${scenario.seed} depth=${scenario.depth} settle=${scenario.settleKind} parentFirst=${scenario.parentFirst}`
}

function taskLabel(scenario: Scenario, task: FuzzTask): string {
  return `${formatScenario(scenario)} task=${task.id} state=${task.state}`
}
