import { type Either, either, isLeft, isRight } from '../src/index.ts'

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
  readonly exposed: 'no' | 'yes'
}

type QueueOrder = 'abort-first' | 'operation-first'

const workerCount = 4
const healthy = await runOwnershipScenario(false)
const poisoned = await runOwnershipScenario(true)
const teardown = healthy.events.filter((event) => event.startsWith('teardown'))
const releaseWasLast = healthy.events.at(-1) === 'release connection'
const poisonedWorkers = poisoned.defects.map(({ worker }) => worker)

console.log(`
NIGHTMARE II: THE CONNECTION HAS TENURE

OWNERSHIP MEMO
  result                 : ${tag(healthy.result)}
  children started       : ${healthy.started}
  children torn down     : ${teardown.length}
  connection released    : ${healthy.events.includes('release connection') ? 'yes' : 'no'}
  release happened last  : ${releaseWasLast ? 'yes' : 'NO'}
  used after release     : ${healthy.defects.length === 0 ? 'none' : JSON.stringify(healthy.defects)}

POISONED CONTROL
  poison before shutdown : yes
  result                 : ${tag(poisoned.result)}
  used after release     : ${poisonedWorkers.length === 0 ? 'NONE. THE ALARM IS DECORATIVE.' : `workers ${poisonedWorkers.join(', ')}`}
`)

const abortFirst = await runSweep('abort-first')
const operationFirst = await runSweep('operation-first')

console.log('ACQUISITION ABORT WINDOW')
printSweep('abort queued first (adversarial)', abortFirst)
printSweep('operation queued first', operationFirst)

if (
  !isLeft(healthy.result) ||
  tag(healthy.result) !== 'LiveDemoDetected' ||
  !isLeft(poisoned.result) ||
  tag(poisoned.result) !== 'Suppressed' ||
  poisonedWorkers.join(',') !== '1,2,3' ||
  teardown.length !== workerCount ||
  !releaseWasLast ||
  healthy.defects.length !== 0 ||
  abortFirst.some(
    (row) => row.opened !== 1 || row.released !== 1 || row.exposed !== 'no',
  ) ||
  operationFirst.some(
    (row, index) =>
      row.opened !== 1 ||
      row.released !== 1 ||
      row.exposed !== (index === operationFirst.length - 1 ? 'yes' : 'no'),
  )
) {
  console.log('\nINCIDENT MEMO')
  console.log(
    JSON.stringify({
      healthy: healthy.result,
      poisoned: poisoned.result,
      abortFirst,
      operationFirst,
    }),
  )
  throw new Error('Nightmare II found daylight')
}

console.log(
  '\nThe children came home before the connection was turned into a pumpkin.',
)

async function runOwnershipScenario(poisonBeforeClose: boolean): Promise<{
  readonly result: Either<unknown, unknown>
  readonly events: readonly string[]
  readonly defects: readonly UsedAfterRelease[]
  readonly started: number
}> {
  const allStarted = Promise.withResolvers<void>()
  const events: string[] = []
  const defects: UsedAfterRelease[] = []
  let started = 0

  const result = await either(async function* ({ raise, signal }) {
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
        await either(child, async function* ({ raise, signal: childScope }) {
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
            return raise({
              _tag: 'LiveDemoDetected' as const,
              action:
                'close the pool while everybody is still holding the cable',
            })
          }

          await aborted(childScope)
          return `stopped:${worker}` as const
        }),
    )

    const first = await completions.next()
    if (first.done) return raise({ _tag: 'NoCompletions' as const })
    if (poisonBeforeClose) connection.poisoned = true
    return yield* first.value.result
  })

  return { result, events, defects, started }
}

async function runSweep(order: QueueOrder): Promise<readonly SweepRow[]> {
  const rows: SweepRow[] = []
  for (const offset of [-1, 0, 1, 2]) {
    rows.push(await runAcquisitionSweep(offset, order))
  }
  return rows
}

function printSweep(label: string, rows: readonly SweepRow[]): void {
  console.log(`\n  ${label}`)
  console.log('  abort  opened  released  exposed')
  for (const row of rows) {
    console.log(
      `  ${row.abort.padEnd(5)}  ${String(row.opened).padEnd(6)}  ${String(row.released).padEnd(8)}  ${row.exposed}`,
    )
  }
}

async function runAcquisitionSweep(
  offset: number,
  order: QueueOrder,
): Promise<SweepRow> {
  const openTicks = 4
  const controller = new AbortController()
  let opened = 0
  let released = 0
  let exposed = false

  const startAbort = async () => {
    await microtasks(openTicks + offset)
    controller.abort({ _tag: 'SweepAbort', offset })
  }

  const startOperation = async () =>
    either(controller.signal, async function* ({ signal }) {
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

  const abort = order === 'abort-first' ? startAbort() : undefined
  const outcome = startOperation()
  const queuedAbort = abort ?? startAbort()

  const [settled] = await Promise.all([outcome, queuedAbort])
  if (order === 'abort-first' && !isLeft(settled)) {
    throw new Error(`abort ${formatOffset(offset)} lost the acquisition race`)
  }

  return {
    abort: formatOffset(offset),
    opened,
    released,
    exposed: exposed ? 'yes' : 'no',
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

function tag(outcome: Either<unknown, unknown>): string {
  if (isRight(outcome)) return 'Right'
  const error = outcome.error
  if (typeof error !== 'object' || error === null || !('_tag' in error)) {
    return String(error)
  }
  return String(error._tag)
}
