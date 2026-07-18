# yeet

> Dependency-free. Tree-shakeable. Side-effect free. About 5.9 kB gzipped for
> the core, with stream helpers on a separate 3.0 kB subpath.

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
- [Guides](#guides)
- [API At A Glance](#api-at-a-glance)
- [Why This Exists](#why-this-exists)
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

## Guides

By this point, you know the whole central trick: yield a success, return a
failure, let the type system carry the receipts. The rest of yeet is that same
idea applied to situations with more moving parts.

| When the plot thickens                    | Take this path                                                 |
| ----------------------------------------- | -------------------------------------------------------------- |
| Work must stop together                   | [Cancellation And Structured Concurrency](docs/concurrency.md) |
| Bytes arrive in pieces                    | [Streams And Bytes](docs/streams.md)                           |
| Several outcomes need combining           | [Composition Helpers](docs/composition.md)                     |
| Results must cross a wire                 | [Serialization And Schemas](docs/serialization.md)             |
| Generators should disappear at build time | [Build-Time Optimizer](docs/optimizer.md)                      |
| You need every exported name              | [API Reference](docs/reference.md)                             |
| You brought a stopwatch                   | [Benchmarks](docs/benchmarks.md)                               |

The [documentation index](docs/README.md) puts those guides in a sensible reading
order. It is shorter than a pilgrimage and considerably easier on the knees.

## API At A Glance

| Job                                  | Reach for                                                     |
| ------------------------------------ | ------------------------------------------------------------- |
| Construct or inspect a result        | `left`, `right`, `isLeft`, `isRight`                          |
| Write a typed flow                   | `either`, `yield*`, `raise`                                   |
| Guard a value                        | `ensure`, `ensureNotNull`                                     |
| Keep a local failure local           | `raise.capture`                                               |
| Run independent inputs               | `all`, `collectAll`                                           |
| Own concurrent child work            | `signal.fork`, `forkAll`, `forkFirst`, `forkRace`, `forkEach` |
| Own a resource for the scope         | `signal.acquire`                                              |
| Read bytes or structured streams     | `@big-time/yeet/stream`                                       |
| Validate or serialize outcomes       | `eitherSchema`, `exitSchema`, `toJSON`, `fromJSON`            |
| Remove supported generator machinery | `@big-time/yeet/unplugin`                                     |

The complete signatures live in the [API reference](docs/reference.md). The
table above is merely the coat rack.

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

Benchmarks are weather reports, not scripture. The repository includes runtime,
stream, structured-concurrency, optimizer, memory, and head-to-head suites for
both Node and Bun.

Runtime-only `yeet` and `better-result` are close enough that workload shape
matters. Yeet has a small lead on multi-step synchronous flows and
short-circuits; `better-result` leads on the plain async success path:

| Scenario                      | Result                            |
| ----------------------------- | --------------------------------- |
| Two sync successes            | `yeet` faster by `1.05x`          |
| Sync failure / short-circuit  | `yeet` faster by `1.14x`          |
| Complex checkout success      | `yeet` faster by `1.14x`          |
| Async failure / short-circuit | `yeet` faster by `1.15x`          |
| Async success                 | `better-result` faster by `1.24x` |

The optional optimizer changes the shape more dramatically by lowering supported
generator flows to ordinary branches. See [Benchmarks](docs/benchmarks.md) for
commands, stream numbers, methodology, and the JIT's current emotional state.

## License

MIT
