# yeet

> Dependency-free. Tree-shakeable. Side-effect free. About 5.7 kB gzipped for
> the core, with stream helpers on a separate 3.1 kB subpath.

`yeet` is what happens when `Either` stops being a ceremonial robe and starts
doing field work.

Write normal JavaScript. `yield*` a value to unwrap success. Hit a `Left`, and
the computation exits with typed failure data. Rejected promises become
`Left<Rejected>`. Aborts become `Left<Aborted>`. Forked child work belongs to
the current generator and gets cancelled with it. Streams, bytes, schemas, and
wire-friendly outcomes all speak the same small language.

No runtime dependencies. No method-chain cathedral. No pipe-operator
pilgrimage. Just ordinary control flow, with TypeScript quietly keeping score.

```ts
import { either } from '@big-time/yeet'
import { json } from '@big-time/yeet/stream'

const result = await either(async function* ({ raise, signal }) {
  const [user, settings] = yield* await signal.forkAll([
    (signal) => fetchUser(id, signal),
    (signal) => fetchSettings(id, signal),
  ] as const)

  if (!user.active) {
    return raise({ _tag: 'InactiveUser' as const, id: user.id })
  }

  const response = yield* await raise(
    fetch(`/api/profile/${user.id}`, { signal }),
  )
  const profile = yield* await json(response, { signal })

  return { user, settings, profile }
})

// inferred:
// Promise<
//   Either<
//     | Aborted
//     | Rejected
//     | FetchUserError
//     | FetchSettingsError
//     | StreamError
//     | { _tag: "InactiveUser"; id: string },
//     { user: User; settings: Settings; profile: unknown }
//   >
// >
```

That is the trick: errors are values, cancellation is a value, stream failures
are values, and scoped concurrency still comes back as an `Either`. Add the
optional unplugin and supported generator flows lower to plain branches at build
time, like the narrator quietly removing the scaffolding after the bridge is
built.

The runtime stays tiny. The source stays boring in the best way. The types do
the remembering.

## Contents

- [What Do You Think This Program Prints?](#what-do-you-think-this-program-prints)
- [But I'm Scared](#but-im-scared)
- [Install](#install)
- [Quick Start](#quick-start)
- [Core Model](#core-model)
- [Synchronous Flows](#synchronous-flows)
- [Async Flows](#async-flows)
- [Cancellation](#cancellation)
- [Streams And Bytes](#streams-and-bytes)
- [Composition Helpers](#composition-helpers)
- [Serialization And Schemas](#serialization-and-schemas)
- [Build-Time Optimizer](#build-time-optimizer)
- [Low-Level Folding](#low-level-folding)
- [API Reference](#api-reference)
- [Benchmarks](#benchmarks)
- [License](#license)

## What Do You Think This Program Prints?

Suppose finance sends malformed NDJSON over a chunked Web Stream. Each valid
claim enters a bounded pool. Every worker opens a transaction, hedges three AI
providers, races two policy systems, checks the ledger concurrently, and parses
an SSE rationale. Then the CEO performs a live demo while a cancelled GPU
claim's rollback also fails.

This is not a hypothetical sentence we expected to write.

<details>
<summary><strong>Open <code>nightmare.mts</code>, the whole regrettable program</strong></summary>

```ts
import {
  type Either,
  type ScopeSignal,
  either,
  exitSchema,
  left,
  raise,
  right,
} from '@big-time/yeet'
import { ndjson, sse } from '@big-time/yeet/stream'

// Run with `bun nightmare.mts` or `node nightmare.mts`.
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
      if (row._tag === 'Left') {
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
    if (outcome._tag === 'Right') {
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
  result._tag === 'Left' ? tag(result.error) : 'Right, somehow',
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
    cached._tag === 'Right'
      ? 'The cache remembered a decision. Nobody remembers writing it.'
      : 'The cache has chosen honesty.',
    cached._tag === 'Right' ? cached.value : cached.error,
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

  if (combined._tag === 'Left') return combined
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
    if (event._tag === 'Left') return event
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
        PROCUREMENT_JITTER[state.pulls % PROCUREMENT_JITTER.length]
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
    served += PROCUREMENT_JITTER[pulls % PROCUREMENT_JITTER.length]
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
    claim,
    message,
    ...(detail === undefined ? {} : { detail }),
  })
}
```

</details>

So, what prints?

After an audit trail long enough to worry Legal, the entire incident is still
one ordinary, serializable value. This stable tail was captured verbatim from
an actual `bun nightmare.mts` run. Only the timestamped audit table and
colorized `console.dir` immediately before it are omitted. The same tail was
verified byte-for-byte on Node 26.2.0 and Bun 1.3.14.

```text
TRANSPORT ENVELOPE
{"_tag":"Left","error":{"_tag":"Suppressed","error":{"_tag":"LiveDemoDetected","claim":"demo","action":"cancel everything including the meeting","rationale":["consulted Anthropic","converted 0 cents into strategic confidence"]},"suppressed":[{"_tag":"Rejected","cause":{"_tag":"RollbackFailed","claim":"gpu","detail":"the transaction achieved tenure"}}]}}

POST-MORTEM
  approved before impact : 1
  malformed but tolerated: 1
  source pulls            : 58
  source bytes served     : 706 / 6345
  full-drain pulls        : 513
  source cancelled        : true
  source cancel reason    : ForkEachStopped
  final result             : Suppressed
  wire rehydrated          : yes
  GPU rollback threw      : yes
  GPU rollback in memo    : yes

At no point was this architecture approved by finance. This is why it passed finance.
```

The live demo remains the primary failure. `forkEach` cancels and awaits its
unfinished workers and closes the unread stream. The GPU rollback failure and a
concurrent stream-shutdown stay distinct: the rollback is a new teardown
failure and remains attached; an already-errored reader echoing its exact
cancellation reason is not counted twice. The result then survives JSON
serialization and Standard Schema rehydration.

The source served 706 of 6,345 bytes in 58 pulls. Draining the complete feed
with the same deliberately terrible chunk schedule would require 513 pulls.
That is backpressure reaching all the way through `forkEach`, `ndjson`, and the
Web Stream to the byte source: forty backlog rows remained in the fax machine
because no consumer asked for them.

**Where did Iris's minibar go?** `late-1` was active inside its SSE reader when
the demo failed. Its abort-driven stream `Left` is the outcome of a stopped
sibling, not another failure of the parent. The GPU task follows the same rule:
its `ClaimStopped` value is discarded, while its throwing rollback remains as
a `Suppressed` cleanup failure. `late-2` never started at all; bounded
`forkEach` closed the source before pulling it into the pool.

No bespoke executor. No global error channel. No abandoned work. One value,
with the whole unfortunate story still inside it.

## But I'm Scared

Good. A library named `yeet` should earn your trust before it starts carrying
your checkout flow across the river.

The core is plain tagged data:

```ts
left(error) // { _tag: "Left", error }
right(value) // { _tag: "Right", value }
```

`either(function* () { ... })` is just a small runner for those values. If a
`Left` appears, it stops and returns it. If everything is `Right`, it returns
the final value. There is no hidden global state, no ambient context store, no
runtime dependency quietly playing the violin in the walls.

The fancier parts are opt-in:

- the build-time optimizer is only an optimization; unsupported code is left
  alone and still runs through the normal runtime
- cancellation is cooperative and explicit; pass the `signal` to I/O that needs
  to stop
- scoped forks belong to the current async `either`; when the generator exits,
  live children are aborted and awaited
- stream helpers live on `@big-time/yeet/stream`, with size limits for the
  places where "just read it all" becomes a haunted sentence
- schemas accept Standard Schema-compatible validators like Zod, Valibot,
  ArkType, or TypeBox, but yeet imports none of them

You can start with only `left`, `right`, and `either`. The rest of the library
waits politely until you ask for it.

## Install

```sh
npm install @big-time/yeet
pnpm add @big-time/yeet
yarn add @big-time/yeet
bun add @big-time/yeet
```

`yeet` is ESM-only, ships TypeScript declarations, and has zero runtime
dependencies.

## Quick Start

```ts
import { either, left, right, type Either } from '@big-time/yeet'

type User = { id: string; active: boolean }
type Order = { id: string; userId: string }

const getUser = (id: string): Either<'UserNotFound', User> =>
  id === '1' ? right({ id, active: true }) : left('UserNotFound')

const getOrders = (userId: string): Either<'DbError', Order[]> =>
  right([{ id: 'order-1', userId }])

const result = either(function* (raise) {
  const user = yield* getUser('1')
  if (!user.active) return raise('Inactive' as const)

  const orders = yield* getOrders(user.id)
  return { user, orders }
})

// inferred:
// Either<
//   "UserNotFound" | "Inactive" | "DbError",
//   { user: User; orders: Order[] }
// >
```

If every yielded value is a `Right`, the computation returns `Right` with the
final value. If any yielded value is a `Left`, execution stops there and that
`Left` becomes the result. A door closes, gently but with conviction.

## Core Model

An `Either<E, A>` is one of two values:

```ts
left(error) // inferred: Left<E>
right(value) // inferred: Right<A>
```

You can inspect it with the `_tag` field or with helpers:

```ts
import { isLeft, isRight } from '@big-time/yeet'

if (isRight(result)) {
  result.value
  // inferred: result is Right<A>
}

if (isLeft(result)) {
  result.error
  // inferred: result is Left<E>
}
```

Inside `either(...)`, `yield*` unwraps a `Right` and short-circuits on a `Left`:

```ts
const result = either(function* () {
  const value = yield* right(42)
  yield* left('Nope')
  return value
})

// inferred: Either<'Nope', 42>
```

Returning `raise(error)` is the typed early-exit move. It also helps TypeScript
understand control flow:

```ts
const result = either(function* (raise) {
  const user = yield* getUser(id)
  if (!user.active) return raise('Inactive' as const)

  return user
})

// inferred: Either<'UserNotFound' | 'Inactive', User>
```

There are no annotations in that function body. The error union is inferred from
the things you yield and raise.

## Synchronous Flows

Use `either(function* () { ... })` when every step is synchronous:

```ts
const checkout = either(function* (raise) {
  const session = yield* getSession('session-1')
  if (!session.checkoutEnabled) return raise('CheckoutDisabled' as const)

  const user = yield* getUser(session.userId)
  const cart = yield* getCart(user.id)

  return { user, cart }
})

// inferred:
// Either<
//   SessionError | "CheckoutDisabled" | UserError | CartError,
//   { user: User; cart: Cart }
// >
```

If `getSession`, `getUser`, or `getCart` returns a `Left`, execution stops at
that line. Otherwise the unwrapped success value continues downstream, like a
quiet river in a documentary about responsible software.

### Guards

`ensure` and `ensureNotNull` cover common checks without making you write tiny
one-off `Either` factories:

```ts
import { either, ensure, ensureNotNull } from '@big-time/yeet'

const result = either(function* (raise) {
  const id = yield* ensureNotNull(input.userId, () => 'MissingUserId' as const)
  yield* ensure(id.length > 0, () => 'EmptyUserId' as const)

  const user = yield* getUser(id)
  if (!user.active) return raise('Inactive' as const)

  return user
})

// inferred:
// Either<
//   "MissingUserId" | "EmptyUserId" | "UserNotFound" | "Inactive",
//   User
// >
```

## Async Flows

Async generators work the same way. Await the `Either`, then `yield*` it:

```ts
const result = await either(async function* (raise) {
  const user = yield* await fetchUser('1')
  const orders = yield* await fetchOrders(user.id)

  if (orders.length === 0) return raise('NoOrders' as const)

  return { user, orders }
})

// inferred:
// Either<
//   FetchUserError | FetchOrdersError | "NoOrders",
//   { user: User; orders: Order[] }
// >
```

### Capturing Rejections

Promises and thenables can go through `raise(promiseLike)`. Rejections become
`Left<Rejected>` instead of escaping as thrown exceptions:

```ts
import { either } from '@big-time/yeet'

const result = await either(async function* (raise) {
  const response = yield* await raise(fetch('/api/user'))

  if (!response.ok) {
    return raise({ _tag: 'HttpError' as const, status: response.status })
  }

  const data = yield* await raise(() => response.json() as Promise<unknown>)
  return data
})

// inferred:
// Either<
//   Rejected | { _tag: "HttpError"; status: number },
//   unknown
// >
```

If starting the operation can throw synchronously, pass a function. `raise(fn)`
uses `Promise.try`, so both synchronous throws and rejected promises become
`Left<Rejected>`:

```ts
type Config = { port: number }

const config =
  yield * (await raise(() => JSON.parse(readConfigFile()) as Config))
// inferred: Config
```

Use the direct form when you already have a promise:

```ts
const response = yield * (await raise(fetch('/api/user')))
// inferred: Response
```

Use the function form when creating the promise may throw before a promise
exists:

```ts
type Payload = { id: string }

const parsed = yield * (await raise(() => JSON.parse(input) as Payload))
// inferred: Payload
```

## Cancellation

Pass an `AbortSignal` as the first argument to make an async `either` flow
cooperatively cancellable:

```ts
const result = await either(signal, async function* ({ raise, signal }) {
  using conn = yield* openConn()

  const user = yield* await fetchUser(id, signal)
  const avatar = yield* await raise(
    fetch(user.avatarUrl, {
      signal,
    }),
  )

  return { user, avatar, conn }
})

// inferred:
// Either<
//   Aborted | OpenConnError | FetchUserError | Rejected,
//   { user: User; avatar: Response; conn: Conn }
// >
```

The first callback parameter is a `RaiseContext`: still callable like `raise`,
but also destructurable when you want the signal without the awkward little
shadow puppet of `raise.signal` everywhere.

```ts
type ScopeTaskErrors<T extends readonly ScopeTask<any, any>[]> = {
  -readonly [K in keyof T]: ExitError<ScopeTaskError<T[K]>>
}

type ScopeSignal = AbortSignal & {
  acquire<E, A>(
    factory: (
      signal: ScopeSignal,
    ) => A | Either<E, A> | PromiseLike<A | Either<E, A>>,
    release: (resource: A) => void | PromiseLike<void>,
  ): AsyncIterableIterator<Left<ExitError<E>>, A>
  fork<E, A>(
    task: (signal: ScopeSignal) => Either<E, A> | PromiseLike<Either<E, A>>,
  ): Promise<Exit<E, A>>
  forkAll<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskError<T[number]>, ScopeTaskValues<T>>>
  forkFirst<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskErrors<T>, ScopeTaskValue<T[number]>>>
  forkRace<const T extends readonly ScopeTask<any, any>[]>(
    tasks: T,
  ): Promise<Exit<ScopeTaskError<T[number]>, ScopeTaskValue<T[number]>>>
  forkEach<Input, E, A>(
    items: Iterable<Input> | AsyncIterable<Input>,
    options: { readonly concurrency: number },
    task: (
      item: Input,
      signal: ScopeSignal,
      index: number,
    ) => Either<E, A> | PromiseLike<Either<E, A>>,
  ): AsyncIterableIterator<{
    readonly item: Input
    readonly index: number
    readonly result: Exit<E, A>
  }> &
    AsyncDisposable
}

type Exit<E, A> = Either<E | Rejected | Aborted | Suppressed, A>

type RaiseContext = Raise & {
  readonly raise: RaiseContext
  readonly signal: ScopeSignal
}

type AbortRaise = RaiseContext
```

Use `async function* ({ raise, signal })` when you need both. If you only need
the signal, destructure only that:

```ts
const result = await either(signal, async function* ({ signal }) {
  return yield* await fetchUser(id, signal)
})
```

If you prefer the old single-name style, `async function* (raise) { ... }` still
works and `raise.signal` is there. For compatibility, yeet also passes the same
enriched child signal as the callback's second argument:
`async function* (raise, signal) { ... }`. Prefer destructuring in new examples
so the source of the signal has one obvious home.

### Scoped Forks

The injected signal exists even when you do not pass a parent signal. Touching
`{ signal }` inside an async `either` lazily opens a tiny scope. From there,
`signal.fork(task)` starts child work under that scope and gives the task its own
child `ScopeSignal`.

```ts
const result = await either(async function* ({ signal }) {
  const user = signal.fork((signal) => fetchUser(id, signal))
  const settings = signal.fork((signal) => fetchSettings(id, signal))

  return {
    user: yield* await user,
    settings: yield* await settings,
  }
})

// inferred:
// Promise<
//   Either<
//     Aborted | Rejected | FetchUserError | FetchSettingsError,
//     { user: User; settings: Settings }
//   >
// >
```

If any fork returns a `Left` or rejects, yeet aborts the scope signal, sibling
tasks see `signal.aborted`, and the outer `either` returns that failure as data.
On normal return, short-circuit, throw, or parent abort, outstanding forks are
aborted and awaited before the result settles. The spell is small, but it is a
real step toward structured concurrency: children do not wander off after the
generator is done.

If cleanup fails while the scope is unwinding, yeet keeps the original cause and
attaches teardown failures as `Suppressed` data:

```ts
type Suppressed<E = unknown> = {
  readonly _tag: 'Suppressed'
  readonly error: E
  readonly suppressed: readonly Rejected[]
}
```

So a first `Left` still wins, but a sibling socket that throws while closing is
not tossed into the tall grass. If a `forkFirst` or `forkRace` winner was a
`Right` and a loser rejects during abort cleanup, the scoped operation returns
that cleanup failure as `Left<Rejected>`.

For the cleanest inferred error unions, `yield* await` the fork promises you
care about, as above. TypeScript cannot see the error type of a detached fork
that is started and never referenced again; JavaScript may be magical, but it is
not yet clairvoyant.

### Scoped Resources

A scope that knows when its children should come home can also remember who
borrowed the database connection. `signal.acquire` opens a resource only when
the generator reaches it, hands the factory the scoped signal, and gives you
the plain resource back through `yield*`. No ceremonial wrapper follows you
around afterward.

```ts
const result = await either(async function* ({ signal }) {
  const conn = yield* signal.acquire(
    (signal) => pool.connect({ signal }),
    (conn) => conn.release(),
  )

  const transaction = yield* signal.acquire(
    (signal) => beginTransaction(conn, signal),
    (transaction) => transaction.rollbackUnlessCommitted(),
  )

  return yield* await checkout(transaction)
})

// inferred:
// Promise<Either<Aborted | Rejected | ConnectError | TransactionError | CheckoutError, Receipt>>
```

The factory may return a raw value, an `Either`, a promise, or a promised
`Either`. It must be a factory, though. Handing yeet an operation that already
started is rather like asking the stationmaster to stop a train after it left
town. With a factory, an already-aborted scope starts nothing, synchronous
construction errors become data, and the right signal reaches the machinery.

If the resource already knows how to close itself through `Disposable` or
`AsyncDisposable`, no release callback is needed:

```ts
const writer = yield * signal.acquire((signal) => openWriter(path, signal))
```

This is particularly handy for streamed output. The writer stays open while
bounded child work is still bringing in events, then closes after the last
child has found its way home.

```ts
const result = await either(async function* ({ signal }) {
  const writer = yield* signal.acquire(
    (signal) => openEventWriter(response, signal),
    (writer) => writer.close(),
  )

  for await (const { result } of signal.forkEach(
    toolCalls,
    { concurrency: 4 },
    (call, signal) => runTool(call, signal),
  )) {
    writer.write(yield* result)
  }

  return 'complete' as const
})

// inferred: Promise<Either<Aborted | Rejected | WriterError | ToolError, 'complete'>>
```

The distinction is pleasantly small. Native `using` and `await using` own a
resource until the current block ends. `signal.acquire` owns it until the whole
scope ends. Pick the shortest honest lifetime. Yeet does not hand you a Proxy,
a public stack, or a little brass lever marked "release early."

When the scope closes, the children are cancelled and awaited first. Only then
are the parent resources released, in reverse order, so no child turns around
to discover that somebody removed its connection mid-sentence. If cleanup
fails after success, the result becomes `Left<Rejected>`. If several cleanups
fail, yeet keeps the whole story in `Suppressed`. A domain `Left` or `Aborted`
remains the headline; cleanup failures are attached underneath it instead of
rewriting what happened.

Cancellation remains cooperative. A factory that ignores its signal and never
settles can keep the scope waiting forever. And because this ownership work is
real runtime work, the optional unplugin leaves generators using `{ signal }`
alone. The optimizer knows when to leave the room.

The five concurrent methods answer five different questions:

| Method                               | Returns when                        | Failure behavior                                          |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------------- |
| `signal.fork(task)`                  | That child settles                  | A `Left` or rejection fails the owning scope              |
| `signal.forkAll(tasks)`              | Every child returns `Right`         | First failure cancels the remaining siblings              |
| `signal.forkFirst(tasks)`            | Any child returns `Right`           | Failures accumulate; exhaustion returns an ordered tuple  |
| `signal.forkRace(tasks)`             | Any child returns `Right` or `Left` | The first outcome wins and cancels the remaining siblings |
| `signal.forkEach(items, opts, task)` | The consumer asks for a completion  | Each outcome is data; stopping cancels unfinished work    |

When the work is naturally a batch, use `signal.forkAll`. It starts every task
with a child signal, returns values in input order, and cancels siblings on the
first `Left` or rejection.

```ts
const result = await either(async function* ({ signal }) {
  const [user, settings] = yield* await signal.forkAll([
    (signal) => fetchUser(id, signal),
    (signal) => fetchSettings(id, signal),
  ] as const)

  return { user, settings }
})

// inferred:
// Promise<Either<Aborted | Rejected | FetchUserError | FetchSettingsError, { user: User; settings: Settings }>>
```

Use `signal.forkFirst` when every candidate starts now but only the first
`Right` wins. A `Left` or rejection is recorded while viable siblings keep
running. Once a `Right` arrives, unfinished candidates are aborted with
`siblingSettled()` and awaited. If everything fails, the result is a
position-preserving error tuple in input order.

```ts
const result = await either(async function* ({ signal }) {
  const answer = yield* await signal.forkFirst([
    (signal) => askOpenAI(prompt, signal),
    (signal) => askAnthropic(prompt, signal),
    (signal) => askLocalModel(prompt, signal),
  ] as const)

  return answer
})

// inferred:
// Promise<
//   Exit<
//     [
//       ExitError<OpenAIError>,
//       ExitError<AnthropicError>,
//       ExitError<LocalModelError>
//     ],
//     Completion
//   >
// >
```

That same shape covers replica reads without making the fastest outage defeat a
slightly slower healthy node:

```ts
const result = await either(async function* ({ signal }) {
  const user = yield* await signal.forkFirst([
    (signal) => readReplica('eu-west', id, signal),
    (signal) => readReplica('eu-north', id, signal),
    (signal) => readPrimary(id, signal),
  ] as const)

  return user
})
// inferred success: User
// all-failed result preserves each replica error by position
```

`signal.forkFirst([])` returns `Left([])`: there was no candidate that could
possibly succeed, and no exceptional ceremony is required to say so.

Use `signal.forkEach` when the input may be large, the fan-out must be bounded,
and results should arrive as work finishes rather than in input order. The
source is lazy, only one source pull is in flight, and `active tasks + buffered
completions` never exceeds `concurrency`.

```ts
const result = await either(async function* ({ signal }) {
  for await (const { item, result } of signal.forkEach(
    documents,
    { concurrency: 8 },
    (document, signal, index) => embed(document, signal, index),
  )) {
    const embedding = yield* result
    yield* await saveEmbedding(item.id, embedding)
  }

  return 'indexed' as const
})

// inferred:
// Either<Aborted | Rejected | EmbedError | SaveError, 'indexed'>
```

Each completion is `{ item, index, result }`, so out-of-order work never loses
its identity. `result` is an `Exit`: `yield* result` for fail-fast behavior, or
inspect it and keep going when one bad item should not dismiss the whole class.

```ts
const result = await either(async function* ({ signal }) {
  const failures: { replica: Replica; error: ExitError<ReplicaError> }[] = []

  for await (const { item: replica, result } of signal.forkEach(
    replicas,
    { concurrency: 4 },
    (replica, signal) => refreshReplica(replica, signal),
  )) {
    if (result._tag === 'Left') {
      failures.push({ replica, error: result.error })
      continue
    }
    publishFreshReplica(replica, result.value)
  }

  return failures
})

// inferred:
// Either<Aborted | Rejected, { replica: Replica; error: ExitError<ReplicaError> }[]>
```

Breaking the loop, calling `.return()`, or disposing the iterator with
`await using` closes the input and aborts unfinished children with
`forkEachStopped()` (`{ _tag: 'ForkEachStopped' }`). Yeet waits for both source
and child teardown before settling. As ever, cancellation is cooperative: a
source pull or mapper that ignores its signal and never settles can delay that
close forever.

Use `signal.forkRace` when the first typed outcome wins. A winning `Right`
aborts the losers with `siblingSettled()` (`{ _tag: 'SiblingSettled' }`) without
poisoning the enclosing `either`; a winning `Left` aborts the losers with that
failure and short-circuits as usual.

```ts
const result = await either(async function* ({ signal }) {
  const profile = yield* await signal.forkRace([
    (signal) => fetchFromEdgeCache(id, signal),
    (signal) => fetchFromOrigin(id, signal),
  ] as const)

  return profile
})

// inferred:
// Promise<Either<Aborted | Rejected | EdgeError | OriginError, Profile>>
```

When the signal aborts, yeet returns `Left<Aborted>` and calls `gen.return()`,
so `finally`, `using`, and `await using` cleanup get their turn.

```ts
type Aborted = { readonly _tag: 'Aborted'; readonly reason: unknown }
```

That `reason` is honestly `unknown`. `controller.abort()` with no argument gives
you the platform's default `AbortError` `DOMException`; `controller.abort(x)`
gives you `x`. Yeet does not comb its hair into a library-shaped error for you.

Inside scoped child tasks, avoid returning a domain-flavored
`Left<{ _tag: 'Cancelled' }>` solely because `signal.aborted`. It widens the
task's error union, and losing forked tasks are discarded anyway. Let the
operation honor the signal, reserve `Left` for failures the parent should see,
and let yeet's `Aborted` / `SiblingSettled` values explain the cancellation.

Cancellation is cooperative, because JavaScript is cooperative. The driver can
stop advancing the generator and unwind resources, but it cannot interrupt
synchronous CPU-bound work, and it cannot cancel an in-flight promise unless
that operation honors the same signal. Pass the signal to both layers: yeet for
the flow boundary, your I/O for the actual work.

If the current awaited operation ignores the signal, yeet requests
`gen.return()` immediately, but the returned promise cannot settle until the
generator reaches a point where JavaScript can unwind it. Responsiveness is
bounded by the longest in-flight step. If that step ignores the signal and never
settles, `either(signal, ...)` waits forever, patiently holding the lantern.

If cleanup itself throws during abort unwind, that thrown error wins. Multiple
throwing `using` / `await using` disposers follow JavaScript's `SuppressedError`
rules, so the earlier cleanup failure is still chained instead of vanishing
under the floorboards.

## Streams And Bytes

Stream helpers live on a separate subpath so the core stays tiny:

```ts
import { bytes, collectText, consume, ndjson, sse } from '@big-time/yeet/stream'
```

They are dependency-free and built for the sort of code that reads request
bodies, AI SDK deltas, NDJSON tool streams, and server-sent events. The rule is
simple: helpers that return one final value return `Promise<Either<...>>`;
helpers that produce many values are async iterables of `Either`, so each item
can be handled with the same old `yield*`.

Stream helpers also compose with the build-time optimizer in non-abortable
flows. Bounded steps like `yield* await json(body)` and structured item steps
like `for await (const next of ndjson(body)) { const item = yield* next }`
lower to plain `await`s, loops, and `Left` checks. The stream does its real
work; the do-notation furniture disappears before the guests arrive.

### Bounded Bodies

Use `bytes`, `text`, and `json` when you want one bounded result:

```ts
import { either } from '@big-time/yeet'
import { bytes } from '@big-time/yeet/stream'

const result = await either(signal, async function* ({ signal }) {
  const file = yield* await bytes(request, {
    maxBytes: 25_000_000,
    signal,
  })

  const doc = yield* await extractText(file)
  return yield* await indexDocument(doc)
})

// inferred:
// Promise<
//   Either<
//     Aborted | StreamError | ExtractTextError | IndexDocumentError,
//     IndexedDocument
//   >
// >
```

`bytes` accepts `Request` / `Response` bodies, `Blob`, `ReadableStream`,
`AsyncIterable`, `ArrayBuffer`, and `Uint8Array`-ish views. Direct byte inputs
are returned without copying; multiple chunks are copied once at the end.

### AI Text Deltas

For token or text streams, `collectText` avoids allocating a `Right` for every
successful chunk. It drains the stream, optionally tees each delta, and joins
once:

```ts
import { either } from '@big-time/yeet'
import { collectText } from '@big-time/yeet/stream'

const result = await either(signal, async function* ({ signal }) {
  const text = yield* await collectText(generation.textStream, {
    tee: (delta) => writer.write(delta),
    maxChars: 200_000,
    signal,
    error: providerError.promise,
  })

  return text
})

// inferred: Promise<Either<Aborted | StreamError, string>>
```

If you do not want a final string, use `consume(source, { each, signal })`.
`each` may return a `Left` to stop early, and throws/rejections become
`Left<StreamConsumerError>`.

```ts
const result = await consume(generation.textStream, {
  signal,
  each(delta) {
    writer.write(delta)
    meter.add(delta.length)
  },
})

// inferred: Promise<Either<Aborted | StreamError, void>>
```

### Structured Streams

For protocols where each item can fail independently, use the async iterable
helpers. They allocate an `Either` per parsed item because that is what makes
`yield* next` work. In exchange, the loop stays ordinary JavaScript:

```ts
import { either } from '@big-time/yeet'
import { sse } from '@big-time/yeet/stream'

const result = await either(signal, async function* ({ raise, signal }) {
  const res = yield* await raise(fetch(url, { signal }))

  for await (const next of sse(res.body, { signal })) {
    const event = yield* next

    if (event.event === 'error') {
      return raise({ _tag: 'ProviderError' as const, data: event.data })
    }

    yield* await handleProviderEvent(event)
  }

  return 'done' as const
})

// inferred:
// Promise<
//   Either<
//     Aborted | Rejected | StreamError | ProviderError | HandleProviderEventError,
//     "done"
//   >
// >
```

NDJSON reads the same way:

```ts
import { either } from '@big-time/yeet'
import { ndjson } from '@big-time/yeet/stream'

const result = await either(signal, async function* ({ signal }) {
  for await (const next of ndjson(toolResultStream, {
    maxBytes: 1_000_000,
    signal,
  })) {
    const event = yield* next
    const valid = yield* validateToolEvent(event)
    yield* await saveEvent(valid)
  }

  return 'ok' as const
})

// inferred:
// Promise<
//   Either<
//     Aborted | StreamError | ValidateToolEventError | SaveEventError,
//     "ok"
//   >
// >
```

Malformed NDJSON is an item-level failure: a bad line yields
`Left<ParseError>`, and if your loop handles it and continues, yeet keeps
reading the next line. Byte limits, line limits, invalid chunks, and decode
failures are stream-fatal because the underlying byte flow is no longer a place
to improvise.

Cancellation follows the same cooperative rule as `either(signal, ...)`: pass
the signal to the driver and to the stream helper. If the source ignores the
signal and never settles, yeet cannot summon a settlement from the deep. It can
only stop advancing once JavaScript hands control back.

Consumer-driven exits tear down the source too. If you `break` a
`for await (const next of ndjson(...) | sse(...) | lines(...) | chunks(...))`
loop, or `consume()` stops because `each` returns a `Left`, yeet cancels the
underlying `ReadableStream` instead of merely releasing the reader lock. When
there is a concrete reason, yeet passes it through to `cancel(reason)`:
`signal.reason` for aborts, the external error cause for `options.error`, and
the typed stream error for fatal stream failures. A plain consumer `break` has
no deeper reason to hand down; sometimes the answer is simply "we are done
here."

## Composition Helpers

The helpers in this section are still just functions. No DSL hatch opens in the
ceiling. They cover the cases where plain short-circuiting is not quite the
story you want to tell.

| Helper                | What It Does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `raise.capture(work)` | Capture an outcome as data without short-circuiting                           |
| `all(inputs)`         | Start independent sync/async inputs together and short-circuit by input order |
| `collectAll(inputs)`  | Start independent inputs together and partition successes/failures            |
| `validate(fn)`        | Run every check and accumulate all errors                                     |
| `firstOf(fn)`         | Return the first successful yielded `Either`                                  |
| `collect(fn)`         | Partition every yielded `Either` into `{ values, errors }`                    |

### Capture Instead Of Short-Circuit

Most of the time, `yield* left(...)` should stop the computation. Sometimes you
want to catch that `Left` as data: retry, log, ignore, or decide whether to
re-raise it yourself.

```ts
import { either } from '@big-time/yeet'

const result = either(function* ({ raise }) {
  const cached = raise.capture(getUserFromCache(id))
  // inferred: Either<CacheError, User>

  if (cached._tag === 'Right') {
    return cached.value
  }

  if (cached.error !== 'CacheMiss') {
    return raise(cached.error)
  }

  return yield* getUserFromDatabase(id)
})

// inferred: Either<CacheError | DatabaseError, User>
```

An existing `Either` passes through by identity, with no wrapper allocation.
For work that can throw or reject, give `raise.capture` a thunk or promise:

```ts
const result = await either(async function* ({ raise, signal }) {
  const attempt = await raise.capture(() => askPrimary(prompt, signal))
  // inferred: Either<ProviderError | Rejected, Completion>

  if (attempt._tag === 'Right') return attempt.value

  logProviderFailure(attempt.error)
  return yield* await askFallback(prompt, signal)
})
// inferred: Promise<Either<FallbackError, Completion>>
```

Raw successes become `Right`, returned `Either`s are flattened, and synchronous
throws or promise rejections become `Left<Rejected>`. Nothing short-circuits
until you explicitly `yield*` or return the captured outcome. Thus an observed
provider failure does not haunt the outer error union merely because you looked
at it.

### Concurrent Inputs With `all`

Normal `yield* await` code is sequential. That is usually what you want, but
independent work can start together:

```ts
import { all, either } from '@big-time/yeet'

const result = await either(async function* () {
  const [user, settings] = yield* await all([fetchUser(id), fetchSettings(id)])

  return { user, settings }
})

// inferred:
// Either<
//   Rejected | FetchUserError | FetchSettingsError,
//   { user: User; settings: Settings }
// >
```

`all` accepts `Either`, `Promise<Either>`, or thunks that return either of
those. Async inputs are observed concurrently. Promise rejections and
synchronous throws from thunks become `Left<Rejected>`.

The result is tuple-shaped, so each success keeps its own type:

```ts
const result = await all([
  right(1),
  Promise.resolve(right('two')),
  () => right(true),
])

// inferred: Either<Rejected, [number, string, boolean]>
```

For async failures, `all` waits for the inputs to settle, then returns the first
`Left` by input order. No race-condition fortune telling.

```ts
const result = await all([
  fetchSlowThing(), // eventually Left("SlowFailed")
  fetchFastThing(), // eventually Left("FastFailed")
])

// inferred: Either<Rejected | "SlowFailed" | "FastFailed", [SlowThing, FastThing]>
// resolves to Left("SlowFailed")
```

If the work itself can throw while starting, use thunks:

```ts
const result = await all([() => parseConfigFile(), () => fetchSettings()])
// inferred: Either<Rejected | ConfigError | SettingsError, [Config, Settings]>
```

`all` expects each input to produce an `Either`. For raw promises, wrap them with
`raise` so rejection still becomes data:

```ts
const result = await either(async function* (raise) {
  const [user, settings] = yield* await all([
    raise(fetch('/api/user')),
    raise(fetch('/api/settings')),
  ])

  return { user, settings }
})

// inferred: Either<Rejected, { user: Response; settings: Response }>
```

### Partition Concurrent Inputs With `collectAll`

`collectAll` is the sibling that does not short-circuit. It runs the same input
shapes as `all`, then partitions everything:

```ts
import { collectAll } from '@big-time/yeet'

const { values, errors } = await collectAll(
  ids.map((id) => () => fetchUser(id)),
)

// inferred:
// values: User[]
// errors: (Rejected | FetchUserError)[]
```

### Accumulate Errors With `validate`

Sometimes the first error is not enough. `validate` runs every check and returns
all failures as `Left<E[]>`.

```ts
import { left, right, validate, type Either } from '@big-time/yeet'

const validateAge = (n: number): Either<'TooYoung' | 'TooOld', number> =>
  n < 0 ? left('TooYoung') : n > 150 ? left('TooOld') : right(n)

const validateName = (s: string): Either<'Empty' | 'TooLong', string> =>
  s.length === 0 ? left('Empty') : s.length > 100 ? left('TooLong') : right(s)

const result = validate(function* (check) {
  const age = yield* check(validateAge(input.age))
  const name = yield* check(validateName(input.name))

  return { age, name }
})

// inferred:
// Either<
//   ("TooYoung" | "TooOld" | "Empty" | "TooLong")[],
//   { age: number | undefined; name: string | undefined }
// >
```

When a check fails, `check(...)` returns `undefined` inside the generator so the
rest of the validation can continue. The final result tells you whether the day
was won.

### Try The First Success With `firstOf`

`firstOf` tries yielded `Either`s in order and returns the first `Right`. If they
all fail, it returns every error. For concurrent, cancellation-aware attempts
inside async `either`, use `signal.forkFirst` instead.

```ts
import { firstOf } from '@big-time/yeet'

const user = firstOf(function* () {
  yield getUserFromCache(id)
  yield getUserFromReplica(id)
  yield getUserFromPrimary(id)
})

// inferred: Either<Error[], User>
```

### Collect Results With `collect`

`collect` partitions every yielded value into successes and failures:

```ts
import { collect } from '@big-time/yeet'

const { values, errors } = collect(function* () {
  for (const item of items) {
    yield processItem(item)
  }
})

// inferred:
// values: ProcessedItem[]
// errors: ProcessItemError[]
```

No short-circuiting. No judgment. Just two arrays, standing there in the light.

## Serialization And Schemas

`Left` and `Right` serialize to small tagged JSON objects. Nothing clever is
hiding under the floorboards.

```ts
JSON.stringify(left('Nope'))
// {"_tag":"Left","error":"Nope"}
// inferred: string

JSON.stringify(right({ id: 'user-1' }))
// {"_tag":"Right","value":{"id":"user-1"}}
// inferred: string
```

`toJSON()` eagerly converts nested values that provide their own `toJSON`.
Native `Error` objects become plain `{ name, message, ...fields }` objects. This
keeps the returned transport object boring even in frameworks that inspect
prototypes before JSON encoding, as some server-function and RPC layers do.

```ts
class NotFound extends Error {
  readonly _tag = 'NotFound'

  toJSON() {
    return { _tag: this._tag, message: this.message }
  }
}

left(new NotFound('User not found')).toJSON()
// { _tag: 'Left', error: { _tag: 'NotFound', message: 'User not found' } }
// inferred: SerializedLeft<{ _tag: "NotFound"; message: string }>
```

### Hydrating Trusted JSON

For trusted values that already have the serialized shape, `fromJSON` hydrates
them back into `Left` / `Right` instances:

```ts
import {
  fromJSON,
  isSerializedEither,
  type SerializedEither,
} from '@big-time/yeet'

type User = { id: string }

const parsed = JSON.parse(json) as SerializedEither<string, User>
// inferred: SerializedEither<string, User>

if (isSerializedEither(parsed)) {
  const result = fromJSON(parsed)
  // inferred: Either<string, User>
}
```

`isSerializedEither(value)` detects yeet's strict outer envelope. It does not
validate nested payloads; that is what schemas are for.

### Validating Untrusted JSON

When the JSON came from outside the room, use a schema. `yeet` accepts Standard
Schema-compatible validators for the `error` and `value` payloads, so you can
bring Zod, Valibot, ArkType, TypeBox adapters, or whatever your project already
uses. `yeet` does not import any of them. It merely checks for `~standard` and
lets the grown-ups speak for themselves.

With Zod, pass schemas directly when you want validation or hydration:

```ts
import * as z from 'zod'
import { eitherSchema, serializedEitherSchema } from '@big-time/yeet'

const ApiError = z.object({
  code: z.string(),
  message: z.string(),
})

const User = z.object({
  id: z.string(),
  email: z.email(),
})

type ApiError = z.infer<typeof ApiError>
type User = z.infer<typeof User>

const SerializedUserResult = serializedEitherSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedEitherSchema<ApiError, User>

const HydratedUserResult = eitherSchema({
  error: ApiError,
  value: User,
})
// inferred: EitherSchema<ApiError, User>

const parsed = await SerializedUserResult['~standard'].validate(
  JSON.parse(json),
)
// inferred: Standard Schema result containing SerializedEither<ApiError, User>

const hydrated = await HydratedUserResult['~standard'].validate(
  JSON.parse(json),
)
// inferred: Standard Schema result containing Either<ApiError, User>
```

`serializedEitherSchema` returns the plain transport shape:

```ts
// { value: { _tag: 'Left', error: { code, message } } }
// { value: { _tag: 'Right', value: { id, email } } }
```

`eitherSchema` validates the same JSON, then hydrates the output into real
`Left` / `Right` instances:

```ts
if (hydrated.issues === undefined) {
  // hydrated.value is Left<ApiError> | Right<User>
}
```

Nested schemas are optional. Without them, `yeet` validates the outer
`{ _tag, error | value }` envelope and leaves the payload as `unknown`.

Scoped async work has a small extra vocabulary: domain errors, `Aborted`,
`Rejected`, and `Suppressed`. Use `exitErrorSchema`, `serializedExitSchema`, and
`exitSchema` when you want that whole outcome to be a portable value.

```ts
import { exitSchema, serializedExitSchema } from '@big-time/yeet'

const SerializedUserExit = serializedExitSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedExitSchema<ApiError, User>

const HydratedUserExit = exitSchema({
  error: ApiError,
  value: User,
})
// inferred: ExitSchema<ApiError, User>
// validates Left<ApiError | Aborted | Rejected | Suppressed> | Right<User>
```

If no domain `error` schema is provided, the Exit schemas accept only yeet's
built-in `Aborted`, `Rejected`, and `Suppressed` error payloads. Add `reason` or
`cause` schemas when those payloads need tighter validation too.

### Exporting JSON Schema

Standard Schema and Standard JSON Schema are separate interfaces. If a nested
schema only implements validation, validation still works; its JSON Schema slot
is emitted as `{}` because `yeet` refuses to invent facts in a nice hat.

For JSON Schema export with Zod, be explicit. Zod's documented API is
`z.toJSONSchema(schema)`, with `{ io: 'input' }` when you need the input side of
a transforming schema. Recent Zod versions may expose Standard JSON Schema
directly, but a tiny adapter keeps the README honest and lets you use Zod's
conversion options.

```ts
import * as z from 'zod'
import { serializedEitherSchema } from '@big-time/yeet'

type JsonSchema = Record<string, unknown>
type JsonSchemaOptions = {
  readonly target: 'draft-2020-12' | 'draft-07' | 'openapi-3.0'
}

const withZodJsonSchema = <Schema extends z.ZodType>(
  schema: Schema,
): typeof schema & {
  readonly '~standard': (typeof schema)['~standard'] & {
    readonly jsonSchema: {
      readonly input: (options: JsonSchemaOptions) => JsonSchema
      readonly output: (options: JsonSchemaOptions) => JsonSchema
    }
  }
} => ({
  ...schema,
  '~standard': {
    ...schema['~standard'],
    jsonSchema: {
      input: (options: JsonSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target, io: 'input' }),
      output: (options: JsonSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target }),
    },
  },
})

const SerializedUserResult = serializedEitherSchema({
  error: withZodJsonSchema(ApiError),
  value: withZodJsonSchema(User),
})
// inferred: SerializedEitherSchema<ApiError, User>

const jsonSchema = SerializedUserResult['~standard'].jsonSchema.output({
  target: 'draft-2020-12',
})
// inferred: JsonSchema
```

TypeBox and TypeMap fit the same hole. Compile or adapt TypeBox schemas into
validators that expose `~standard`, then pass them in:

```ts
import { Type } from '@sinclair/typebox'
import { Compile } from '@sinclair/typemap'
import { serializedEitherSchema } from '@big-time/yeet'

const ApiError = Compile(
  Type.Object({
    code: Type.String(),
    message: Type.String(),
  }),
)

const User = Compile(
  Type.Object({
    id: Type.String(),
    email: Type.String({ format: 'email' }),
  }),
)

const SerializedUserResult = serializedEitherSchema({
  error: ApiError,
  value: User,
})
// inferred: SerializedEitherSchema<ApiError, User>
```

When the nested schemas implement Standard JSON Schema, `yeet` includes their
JSON Schema inside the exported `Either` envelope. That gives you a portable
shape for API docs, structured outputs, form builders, or any other bit of
software that enjoys receiving small rectangles of truth.

## Build-Time Optimizer

Yeet ships an optional unplugin optimizer. Your source stays the same; the
plugin looks for inline generator calls to `either`, `validate`, `firstOf`, and
`collect` that it can prove, then lowers them into plain early-return or
accumulator JavaScript. It also fuses yeet's own constructors and guards when
they are consumed immediately, removing intermediate `Either` values as well
as the generator. `raise.capture(...)` is understood as a local outcome
boundary in lowered generators. If the plugin cannot prove the shape, it leaves
the original runtime call exactly where it found it.

No spooky action at a distance. Just a little stagehand moving furniture before
the curtain rises.

```ts
// vite.config.ts
import yeet from '@big-time/yeet/unplugin/vite'

export default {
  plugins: [yeet()],
}
```

Adapter subpaths are available for Vite, Rollup, Webpack, Rspack, esbuild, and
Bun:

| Tool    | Import                            |
| ------- | --------------------------------- |
| Vite    | `@big-time/yeet/unplugin/vite`    |
| Rollup  | `@big-time/yeet/unplugin/rollup`  |
| Webpack | `@big-time/yeet/unplugin/webpack` |
| Rspack  | `@big-time/yeet/unplugin/rspack`  |
| esbuild | `@big-time/yeet/unplugin/esbuild` |
| Bun     | `@big-time/yeet/unplugin/bun`     |

The optimizer is binding-scoped, so aliased imports work while shadowed locals
are politely ignored:

```ts
import { either as e, right } from '@big-time/yeet'

const result = e(function* () {
  return yield* right(42)
})

// inferred: Either<never, number>
```

The optimizer understands a few yeet primitives deeply enough to erase the
whole produce-then-consume boundary:

```ts
import { either, ensure, ensureNotNull, type Either } from '@big-time/yeet'

const result = either(function* ({ raise }) {
  const id = yield* ensureNotNull(input.id, () => 'MissingId' as const)
  yield* ensure(id.length > 0, () => 'EmptyId' as const)
  const cached = raise.capture(readCache(id))
  return { id, cached }
})
// inferred:
// Either<
//   "MissingId" | "EmptyId",
//   { id: string; cached: Either<CacheError, Cached> }
// >
```

Conceptually, that becomes:

```ts
import { left, right } from '@big-time/yeet'

const lowered = (() => {
  const id = input.id
  if (id == null) return left('MissingId' as const)
  if (!(id.length > 0)) return left('EmptyId' as const)
  const cached = readCache(id)
  return right({ id, cached })
})()
// inferred:
// Either<
//   "MissingId" | "EmptyId",
//   { id: string; cached: Either<CacheError, Cached> }
// >
```

The actual lowering preserves JavaScript evaluation order and lazy error
construction, including evaluating a guard's callback expression on success but
only calling it on failure. Tiny details, yes. Tiny details are where compilers
hide the knives.

It lowers these proven shapes:

- direct `yield* someEither()` steps in `either`
- immutable `const` aliases initialized from a proven Either-producing call
- direct `yield* right(...)`, `yield* left(...)`, `yield* ensure(...)`, and
  `yield* ensureNotNull(...)` steps, with unnecessary intermediate `Either`
  values fused away
- local `raise.capture(...)` outcome boundaries through either `raise` or
  `{ raise }` callback parameters
- direct `yield* await somePromiseReturningEither()` steps in async `either`,
  including bounded stream helpers like `json(body)` and `collectText(stream)`
- direct `yield* next` steps where `next` is a `const` binding from
  `for await (const next of ndjson(...) | sse(...) | lines(...) | chunks(...))`
- callable `raise` parameters written as either `raise` or `{ raise }`, including
  aliases such as `{ raise: fail }`, when no scoped signal is requested
- statically primitive final returns without a redundant structural `Left` check
- direct `yield* check(someEither())` steps in `validate`
- direct `yield someEither` attempts in `firstOf` and `collect`

On a local `bun run bench:quick:node`-style run, the transform shook out roughly
like this. The exact numbers will drift with hardware, runtime, warmup, and the
JIT's morning mood, but the shape is the useful part:

| Shape                                           | Rough win |
| ----------------------------------------------- | --------- |
| `either`: single sync `yield*` success          | `~31x`    |
| `either`: two sync `yield*` successes           | `~8.5x`   |
| `either`: sync `Left` short-circuit             | `~13x`    |
| `either`: two async `yield* await` successes    | `~5.9x`   |
| `either`: async `Left` short-circuit            | `~7.3x`   |
| `validate`: two checks                          | `~10x`    |
| `firstOf`: three attempts                       | `~10-11x` |
| Fused guards: success                           | `~15x`    |
| Fused guards: `Left`                            | `~28x`    |
| `raise.capture`: cached `Right`                 | `~20x`    |
| `raise.capture`: `Left` then fallback           | `~19x`    |
| Stream: `yield* await json(body)`               | `~2.6x`   |
| Stream: `yield* next` in `ndjson` / `sse` loops | `~1.2x`   |
| `collect`: many yielded items                   | `~1x`     |

Tiny flows win hardest because the generator driver is most of the work. Once
you are parsing JSON, walking many items, or calling real I/O, the plugin still
removes the do-notation overhead, but the river is wider than the boat.

The fusion rows compare the same guard and cache-fallback source through runtime
`either` and through the real unplugin on a quick Node 26 run. They include both
generator erasure and intrinsic fusion; they are end-to-end numbers, not an
attempt to make one compiler pass look taller in the mirror.

It bails on the abortable overload, escaped `raise` / `check`, `this`,
`arguments`, mutable or unproven indirect `yield*` values, scoped context
destructuring, non-`const` stream item bindings, stream helpers from other
modules, and expression positions where hoisting would change evaluation. The
runtime library remains the interpreter underneath, as dependable as a man in
a dark suit explaining how rain becomes a river.

## Low-Level Folding

If you want to drive a generator yourself, `fold` and `foldAsync` accept a
`Strategy`:

```ts
type Strategy<Eff, Ret, Acc, R> = {
  init: () => Acc
  step: (eff: Eff, acc: Acc) => Step<Acc, R>
  finish: (ret: Ret, acc: Acc) => R
}
```

Everything higher-level in `yeet` is built from the same idea: initialize an
accumulator, handle each yielded value, and finish when the generator returns.

Most people will never need this. But it is there, because sometimes you want
the keys to the old truck.

## API Reference

### Core

| API              | Description         |
| ---------------- | ------------------- |
| `left(error)`    | Create a `Left<E>`  |
| `right(value)`   | Create a `Right<A>` |
| `isLeft(value)`  | Narrow to `Left`    |
| `isRight(value)` | Narrow to `Right`   |

### Generator Runners

| API                       | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `either(fn)`              | Short-circuiting sync or async generator runner                    |
| `either(signal, asyncFn)` | Abort-aware async runner; `asyncFn` receives a scoped `AbortRaise` |
| `validate(fn)`            | Accumulate every yielded error                                     |
| `firstOf(fn)`             | Return the first yielded `Right`                                   |
| `collect(fn)`             | Partition yielded values into errors and values                    |

### Concurrency

| API                       | Description                                                          |
| ------------------------- | -------------------------------------------------------------------- |
| `all(inputs)`             | Run independent inputs concurrently and short-circuit by input order |
| `collectAll(inputs)`      | Run independent inputs concurrently and partition all outcomes       |
| `signal.fork(task)`       | Start child work inside the current async `either` scope             |
| `signal.forkAll(tasks)`   | Run signal-aware child tasks and cancel siblings on first failure    |
| `signal.forkFirst(tasks)` | Return the first child `Right`, or every error in input order        |
| `signal.forkRace(tasks)`  | Return the first child outcome and abort losing tasks                |
| `signal.forkEach(...)`    | Lazily map bounded child work and yield outcomes in settlement order |
| `signal.acquire(...)`     | Acquire a raw resource owned by the current async scope              |

### Guards And Async Helpers

| API                            | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `ensure(condition, onFail)`    | Return `Right<void>` or `Left(onFail())`                           |
| `ensureNotNull(value, onNull)` | Unwrap a non-nullish value or return `Left(onNull())`              |
| `raise(error)`                 | Create a typed early return value                                  |
| `raise(fn)`                    | Capture synchronous throw or promise rejection as `Left<Rejected>` |
| `raise(promiseLike)`           | Capture promise rejection as `Left<Rejected>`                      |
| `raise.capture(work)`          | Capture and flatten an outcome without short-circuiting            |
| `aborted(reason)`              | Create an `Aborted` error payload                                  |
| `rejected(cause)`              | Create a `Rejected` error payload                                  |
| `siblingSettled()`             | Get the race-loser cancellation reason singleton                   |
| `forkEachStopped()`            | Get the stopped-completion-stream reason singleton                 |
| `suppressed(error, failures)`  | Create a `Suppressed` cleanup-failure payload                      |

### Serialization And Schemas

| API                                | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| `fromJSON(value)`                  | Hydrate trusted serialized JSON into `Left` / `Right` |
| `isSerializedEither(value)`        | Detect yeet's strict JSON envelope                    |
| `serializedEitherSchema(options?)` | Standard Schema validator for serialized JSON         |
| `eitherSchema(options?)`           | Standard Schema validator that hydrates to `Either`   |
| `exitErrorSchema(options?)`        | Standard Schema validator for scoped Exit errors      |
| `serializedExitSchema(options?)`   | Standard Schema validator for serialized `Exit` JSON  |
| `exitSchema(options?)`             | Standard Schema validator that hydrates to `Exit`     |

### Streams And Bytes

Import these from `@big-time/yeet/stream`.

| API                             | Description                                               |
| ------------------------------- | --------------------------------------------------------- |
| `bytes(source, options?)`       | Read a bounded byte source into `Uint8Array`              |
| `text(source, options?)`        | Read and UTF-8 decode a byte source                       |
| `json(source, options?)`        | Read, decode, and `JSON.parse` a byte source              |
| `chunks(source, options?)`      | Yield byte chunks as `Either` values                      |
| `consume(source, options)`      | Drain raw or `Either` streams without success allocations |
| `collectText(source, options?)` | Drain text deltas and join once                           |
| `lines(source, options?)`       | Yield UTF-8 lines as `Either` values                      |
| `ndjson(source, options?)`      | Yield parsed NDJSON records as `Either` values            |
| `sse(source, options?)`         | Yield server-sent events as `Either` values               |

### Lower-Level Machinery

| API                              | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `fold(fn, strategy)`             | Drive a sync generator with a custom strategy   |
| `foldAsync(generator, strategy)` | Drive an async generator with a custom strategy |

`Left` and `Right` are small classes with `Symbol.iterator`, `toJSON`, and
`Symbol.toPrimitive` support. They work nicely with `yield*`, JSON
serialization, and straightforward tag checks.

## Why This Exists

A lot of Result libraries ask you to learn a second little programming language:
`map`, `flatMap`, `andThen`, `pipe`, `tap`, `mapErr`, `orElse`, and friends.
Good tools, many of them. But sometimes you already have the best control-flow
syntax available:

```ts
if (!user.active) return raise('Inactive' as const)
for (const item of items) yield processItem(item)
tryAnotherThing()
```

`yeet` leans on generators to make that style type-safe. The errors flow through
the type system, the happy path reads top-to-bottom, and the runtime stays very
small.

Some things in life should be boring in precisely the right way.

## Benchmarks

There are Vitest benchmarks in `src/*.bench.ts`, plus a memory benchmark script.

```sh
bun run bench
bun run bench --target node
bun run bench --target bun
bun run bench:quick
bun run bench:quick:node
bun run bench:quick:bun
bun run bench:memory
```

```sh
bun run bench --target node src/overhead.bench.ts
bun run bench --target bun --quick src/stream.bench.ts
```

These benchmarks are intentionally tiny and can be sensitive to runtime noise,
JIT mood, and passing clouds. Treat them as directional, not holy scripture.

The current benchmark suite compares common `either` flows against
`better-result`, includes sync, async, short-circuit, validation, sequential and
scoped concurrent first success, collection, plugin-transformed scenarios, and
stream helpers against vanilla async-iteration code.

For a rough overhead map, `src/overhead.bench.ts` compares the same core flows
four ways. These numbers are from a local quick run and are normalized per row
to vanilla `try` / `throw` / `catch` as `1x`. Higher is faster:

| Scenario                     | Vanilla exceptions | `better-result` | `yeet`  | `yeet` lowered |
| ---------------------------- | ------------------ | --------------- | ------- | -------------- |
| Sync two successes           | `1x`               | `0.08x`         | `0.09x` | `0.48x`        |
| Sync failure / short-circuit | `1x`               | `2.4x`          | `2.6x`  | `19x`          |
| Async two successes          | `1x`               | `0.10x`         | `0.13x` | `0.60x`        |
| Complex checkout success     | `1x`               | `0.08x`         | `0.09x` | `0.59x`        |

That is the honest bargain. On tiny success paths, plain JavaScript with
exceptions is the low-overhead baseline. On failure paths, exceptions pay for
their dramatic exit, while `Either` is just data walking through a door. Turn on
the unplugin and yeet gets much closer to the baseline on happy paths while
keeping the data-shaped exit on sad ones.

Stream helpers have a separate row because they do more than shuttle control
flow. This compares a tiny hand-written parser against yeet's NDJSON helper, and
then against the same yeet code after the build-time transform:

| Scenario              | Manual parser | `yeet` stream | `yeet` stream lowered |
| --------------------- | ------------- | ------------- | --------------------- |
| NDJSON stream success | `1x`          | `0.49x`       | `0.69x`               |

The stream helper still does real parsing, decoding, bounds, cleanup, and
error-shaping work. The transform removes generator consumption overhead; it
does not make a fully-featured stream parser vanish into a hand-rolled loop.

## License

MIT
