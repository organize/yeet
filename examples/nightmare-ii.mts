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

const workerCount = 4
const allStarted = Promise.withResolvers<void>()
const events: string[] = []
const useAfterRelease: UsedAfterRelease[] = []
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
            useAfterRelease.push(defect)
            throw defect
          },
        )

        started++
        if (started === workerCount) allStarted.resolve()
        await allStarted.promise

        if (worker === 0) {
          return raise({
            _tag: 'LiveDemoDetected' as const,
            action: 'close the pool while everybody is still holding the cable',
          })
        }

        await aborted(childScope)
        return `stopped:${worker}` as const
      }),
  )

  const first = await completions.next()
  if (first.done) return raise({ _tag: 'NoCompletions' as const })
  return yield* first.value.result
})

const teardown = events.filter((event) => event.startsWith('teardown'))
const releaseWasLast = events.at(-1) === 'release connection'

console.log(`
NIGHTMARE II: THE CONNECTION HAS TENURE

OWNERSHIP MEMO
  result                 : ${tag(result)}
  children started       : ${started}
  children torn down     : ${teardown.length}
  connection released    : ${events.includes('release connection') ? 'yes' : 'no'}
  release happened last  : ${releaseWasLast ? 'yes' : 'NO'}
  used after release     : ${useAfterRelease.length === 0 ? 'none' : JSON.stringify(useAfterRelease)}
`)

const rows: SweepRow[] = []
for (const offset of [-1, 0, 1, 2]) {
  rows.push(await runAcquisitionSweep(offset))
}

console.log('ACQUISITION ABORT WINDOW')
console.log('  abort  opened  released  exposed')
for (const row of rows) {
  console.log(
    `  ${row.abort.padEnd(5)}  ${String(row.opened).padEnd(6)}  ${String(row.released).padEnd(8)}  ${row.exposed}`,
  )
}

if (
  !isLeft(result) ||
  tag(result) !== 'LiveDemoDetected' ||
  teardown.length !== workerCount ||
  !releaseWasLast ||
  useAfterRelease.length !== 0 ||
  rows.some(
    (row) => row.opened !== 1 || row.released !== 1 || row.exposed !== 'no',
  )
) {
  console.log('\nINCIDENT MEMO')
  console.log(JSON.stringify(result))
  throw new Error('Nightmare II found daylight')
}

console.log(
  '\nThe children came home before the connection was turned into a pumpkin.',
)

async function runAcquisitionSweep(offset: number): Promise<SweepRow> {
  const openTicks = 4
  const controller = new AbortController()
  let opened = 0
  let released = 0
  let exposed = false

  // Cancellation gets the first seat in equal-microtask ties.
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

  const [settled] = await Promise.all([outcome, abort])
  if (!isLeft(settled)) {
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
