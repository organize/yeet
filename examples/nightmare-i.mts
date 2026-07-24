import {
  type Either,
  type ScopeSignal,
  either,
  exitSchema,
  isLeft,
  isRight,
  left,
  raise,
  right,
} from '../src/index.ts'
import { ndjson, sse } from '../src/stream.ts'

// Run with `bun examples/nightmare-i.mts` or `node examples/nightmare-i.mts`.
// This is one scenario. Every architectural decision was made under duress.

type Expense = {
  readonly id: string
  readonly employee: string
  readonly description: string
  readonly cents: number
  readonly mode: 'normal' | 'gpu' | 'demo' | 'late'
}
type AuditEvent = {
  readonly at: number
  readonly claim?: string
  readonly message: string
  readonly detail?: unknown
}
type SourceState = {
  pulls: number
  bytesServed: number
  totalBytes: number
  fullDrainPulls: number
  cancelled: boolean
  cancelReason: unknown
}

const PROCUREMENT_JITTER = [7, 3, 19, 2, 31] as const

const started = performance.now()
const audit: AuditEvent[] = []
const sourceState: SourceState = {
  pulls: 0,
  bytesServed: 0,
  totalBytes: 0,
  fullDrainPulls: 0,
  cancelled: false,
  cancelReason: undefined,
}

console.log(`
┌────────────────────────────────────────────────────────────────────┐
│  QUARTERLY SYNERGY RECONCILIATION ENGINE                           │
│  "AI-native expense approval for organizations that fear sleep"    │
└────────────────────────────────────────────────────────────────────┘
`)

const expenseFeed = [
  {
    id: 'lunch',
    employee: 'Mira',
    description: 'team lunch, no strategic mayonnaise',
    cents: 8_400,
    mode: 'normal',
  },
  {
    id: 'gpu',
    employee: 'Noah',
    description: 'eight GPUs filed as ergonomic stationery',
    cents: 4_200_000,
    mode: 'gpu',
  },
  '{ "id": "finance", "employee": "Lin", this is not JSON at all }',
  {
    id: 'demo',
    employee: 'CEO',
    description: 'live demo on production during the board meeting',
    cents: 0,
    mode: 'demo',
  },
  {
    id: 'late-1',
    employee: 'Iris',
    description: 'hotel minibar classified as distributed systems research',
    cents: 32_000,
    mode: 'late',
  },
  {
    id: 'late-2',
    employee: 'Omar',
    description: 'consulting invoice from a company incorporated yesterday',
    cents: 900_000,
    mode: 'late',
  },
  ...Array.from({ length: 40 }, (_, index) => ({
    id: `backlog-${index}`,
    employee: 'Procurement',
    description: `purchase order ${index} awaiting one final-final signature`,
    cents: 99_999,
    mode: 'late' as const,
  })),
]
  .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
  .join('\n')

const source = kafkaOverFax(expenseFeed, sourceState)
const recoverableFailures: unknown[] = []
const approved: unknown[] = []

const result = await either(async function* ({ signal }) {
  log('The quarterly batch begins. Nobody has checked the calendar.')

  await using completions = signal.forkEach(
    ndjson(source),
    { concurrency: 3 },
    async (row, child, index) => {
      if (isLeft(row)) {
        log('The fax emitted syntax. Finance calls this schema evolution.', {
          index,
          error: tag(row.error),
        })
        return row
      }
      const expense = row.value as Expense
      try {
        return await adjudicateExpense(expense, child)
      } catch (cause) {
        log('The task escaped by throwing furniture.', { cause }, expense.id)
        throw cause
      }
    },
  )

  for await (const completion of completions) {
    const outcome = completion.result
    if (isRight(outcome)) {
      approved.push(outcome.value)
      log('A claim escaped the machine with paperwork.', {
        index: completion.index,
        value: outcome.value,
      })
      continue
    }
    if (tag(outcome.error) === 'ParseError') {
      recoverableFailures.push(outcome.error)
      log('Malformed input was downgraded from incident to personality.', {
        index: completion.index,
      })
      continue
    }

    log('A non-recoverable business truth has entered the chat.', {
      index: completion.index,
      error: outcome.error,
    })
    yield* outcome
  }

  return {
    status: 'somehow approved everything',
    approved,
    recoverableFailures,
  } as const
})

log('The outer Either settled. Legal has requested the full stack trace.')

const anythingSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'quarterly-synergy-reconciliation',
    validate(value: unknown) {
      return value !== undefined
        ? { value }
        : { issues: [{ message: 'Even nonsense must exist' }] }
    },
  },
}
const wireSchema = exitSchema({
  error: anythingSchema,
  reason: anythingSchema,
  cause: anythingSchema,
  value: anythingSchema,
})
const wire = JSON.stringify(result)
const hydrated = await wireSchema['~standard'].validate(JSON.parse(wire))
const rollbackThrew = audit.some(
  ({ message, detail }) =>
    message === 'The task escaped by throwing furniture.' &&
    JSON.stringify(detail).includes('RollbackFailed'),
)
const rollbackReachedLegal = wire.includes('RollbackFailed')

console.log('\nAUDIT TRAIL')
console.table(
  audit.map(({ at, claim, message }) => ({
    ms: at,
    claim: claim ?? '-',
    event: message,
  })),
)
console.log('\nFINAL MEMO FROM LEGAL')
console.dir(result.toJSON(), { depth: 10, colors: true })
console.log('\nTRANSPORT ENVELOPE')
console.log(wire)
console.log('\nPOST-MORTEM')
console.log('  approved before impact :', approved.length)
console.log('  malformed but tolerated:', recoverableFailures.length)
console.log('  source pulls            :', sourceState.pulls)
console.log(
  '  source bytes served     :',
  `${sourceState.bytesServed} / ${sourceState.totalBytes}`,
)
console.log('  full-drain pulls        :', sourceState.fullDrainPulls)
console.log('  source cancelled        :', sourceState.cancelled)
console.log('  source cancel reason    :', tag(sourceState.cancelReason))
console.log(
  '  final result             :',
  isLeft(result) ? tag(result.error) : 'Right, somehow',
)
console.log(
  '  wire rehydrated          :',
  hydrated.issues === undefined ? 'yes' : 'no, even the wire resigned',
)
console.log('  GPU rollback threw      :', rollbackThrew ? 'yes' : 'no')
console.log(
  '  GPU rollback in memo    :',
  rollbackReachedLegal ? 'yes' : 'NO. LEGAL HAS MISPLACED A FAILURE.',
)
console.log(
  '\nAt no point was this architecture approved by finance. This is why it passed finance.',
)

async function adjudicateExpense(
  expense: Expense,
  signal: ScopeSignal,
): Promise<Either<unknown, unknown>> {
  log(
    'Opening a transaction, a model socket, and several questions.',
    undefined,
    expense.id,
  )
  await using transaction = transactionFor(expense, signal)
  await using _modelSocket = modelSocketFor(expense, signal)

  const cached = raise.capture(() => readDecisionCache(expense))
  log(
    isRight(cached)
      ? 'The cache remembered a decision. Nobody remembers writing it.'
      : 'The cache has chosen honesty.',
    isRight(cached) ? cached.value : cached.error,
    expense.id,
  )

  const combined = await signal.forkAll([
    async (child) => {
      const provider = await child.forkFirst([
        async () => {
          await microticks(expense.id === 'demo' ? 2 : 1)
          return left({
            _tag: 'OpenAIUnavailable' as const,
            explanation: 'capacity has become a philosophical concept',
          })
        },
        async () => {
          // The GPU claim deliberately lets local-model win this hedge.
          await microticks(expense.id === 'gpu' ? 3 : 1)
          return right({
            provider: 'Anthropic',
            category:
              expense.mode === 'gpu' ? 'office supplies' : 'probably lunch',
          })
        },
        async () => {
          await microticks(2)
          return right({
            provider: 'local-model',
            category: JSON.parse('"the intern said yes"') as string,
          })
        },
      ] as const)
      return provider
    },
    async (child) =>
      await child.forkRace([
        async () => {
          await microticks(1)
          return right({
            policy: 'v7-final-FINAL-use-this-one',
            allowed: expense.cents < 1_000_000,
          })
        },
        async (loser) =>
          await waitForAbort(loser, {
            _tag: 'PolicyCommitteeAdjourned' as const,
          }),
      ] as const),
    async () => {
      await microticks(1)
      return right({
        ledgerBalance: 14,
        confidence: 'rounded up from 0.02',
      })
    },
  ] as const)

  if (isLeft(combined)) return combined
  const [classification, policy, ledger] = combined.value
  log(
    'Three systems agree, using three definitions of agree.',
    { classification, policy, ledger },
    expense.id,
  )

  const rationale: string[] = []
  for await (const event of sse(
    aiRationaleStream(expense, classification.provider, signal),
    { signal },
  )) {
    if (isLeft(event)) return event
    rationale.push(event.value.data)
  }

  if (expense.mode === 'gpu' || expense.mode === 'late') {
    log(
      'This claim will remain pending until causality intervenes.',
      undefined,
      expense.id,
    )
    await waitUntilAborted(signal)
    return left({
      _tag: 'ClaimStopped' as const,
      claim: expense.id,
      reason: signal.reason,
    })
  }

  if (expense.mode === 'demo') {
    await microticks(2)
    log(
      'The phrase "live demo" reached the production database.',
      undefined,
      expense.id,
    )
    return left({
      _tag: 'LiveDemoDetected' as const,
      claim: expense.id,
      action: 'cancel everything including the meeting',
      rationale,
    })
  }

  transaction.commit()
  return right({
    claim: expense.id,
    approvedBy: classification.provider,
    policy: policy.policy,
    rationale: rationale.join(' '),
  })
}

function transactionFor(expense: Expense, signal: ScopeSignal) {
  let committed = false
  log('BEGIN TRANSACTION', undefined, expense.id)
  return {
    commit() {
      committed = true
      log('COMMIT, allegedly.', undefined, expense.id)
    },
    async [Symbol.asyncDispose]() {
      await microticks(1)
      if (committed) return
      log('ROLLBACK requested.', { reason: signal.reason }, expense.id)
      if (expense.mode === 'gpu' && signal.aborted) {
        throw {
          _tag: 'RollbackFailed',
          claim: expense.id,
          detail: 'the transaction achieved tenure',
        }
      }
      log(
        'ROLLBACK completed with theatrical reluctance.',
        undefined,
        expense.id,
      )
    },
  }
}

function modelSocketFor(expense: Expense, signal: ScopeSignal) {
  log('Opening model socket.', undefined, expense.id)
  return {
    async [Symbol.asyncDispose]() {
      await microticks(1)
      log(
        'Closing model socket.',
        signal.aborted ? { because: signal.reason } : { because: 'work ended' },
        expense.id,
      )
    },
  }
}

function readDecisionCache(expense: Expense): Either<unknown, string> {
  if (expense.id === 'lunch') return right('approved in 2024 by a deleted user')
  if (expense.id === 'demo')
    throw {
      _tag: 'RedisHasLeftTheBuilding',
      host: 'cache-final-final-2.internal',
    }
  return left({ _tag: 'CacheMiss', key: expense.id })
}

function aiRationaleStream(
  expense: Expense,
  provider: string,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const lines = [
    'event: thought',
    `data: consulted ${provider}`,
    '',
    'event: thought',
    `data: converted ${expense.cents} cents into strategic confidence`,
    '',
  ].join('\n')
  const bytes = new TextEncoder().encode(lines)
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      await microticks(1)
      if (signal.aborted) return controller.error(signal.reason)
      if (offset >= bytes.length) return controller.close()
      const end = Math.min(offset + 11, bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
    cancel(reason) {
      log('AI rationale stream cancelled.', { reason }, expense.id)
    },
  })
}

function kafkaOverFax(
  body: string,
  state: SourceState,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body)
  let offset = 0
  state.totalBytes = bytes.byteLength
  state.fullDrainPulls = pullsToDrain(bytes.byteLength)
  return new ReadableStream({
    async pull(controller) {
      state.pulls++
      await microticks(1)
      if (offset >= bytes.length) return controller.close()
      const procurementJitter =
        PROCUREMENT_JITTER[state.pulls % PROCUREMENT_JITTER.length]!
      const end = Math.min(offset + procurementJitter, bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
      state.bytesServed = offset
    },
    cancel(reason) {
      state.cancelled = true
      state.cancelReason = reason
      log('Kafka-over-fax source cancelled.', { reason })
    },
  })
}

function pullsToDrain(bytes: number): number {
  let pulls = 0
  let served = 0
  while (served < bytes) {
    pulls++
    served += PROCUREMENT_JITTER[pulls % PROCUREMENT_JITTER.length]!
  }
  return pulls + 1
}

async function waitForAbort<E>(
  signal: AbortSignal,
  error: E,
): Promise<Either<E, never>> {
  if (signal.aborted) return left(error)
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(left(error)), { once: true })
  })
}

async function waitUntilAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

async function microticks(count: number): Promise<void> {
  for (let index = 0; index < count; index++) await Promise.resolve()
}

function tag(value: unknown): string {
  if (typeof value === 'object' && value !== null && '_tag' in value) {
    const found = Reflect.get(value, '_tag')
    if (typeof found === 'string') return found
  }
  if (value instanceof Error) return value.name
  return String(value)
}

function log(message: string, detail?: unknown, claim?: string): void {
  audit.push({
    at: Math.round((performance.now() - started) * 100) / 100,
    message,
    ...(claim === undefined ? {} : { claim }),
    ...(detail === undefined ? {} : { detail }),
  })
}
