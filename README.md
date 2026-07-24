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

- [Nightmares](#nightmares)
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

## Nightmares

A Nightmare is one executable, overcommitted scenario with a point to prove.
The inputs are absurd. The ownership, cancellation, backpressure, cleanup, and
error semantics are not.

| Case                                                       | The question                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [I: Quarterly Synergy Reconciliation](docs/nightmare-i.md) | Can bounded streams, concurrent policy work, recoverable parsing, failed rollback, cancellation, and wire serialization preserve one honest outcome? |
| [II: The Connection Has Tenure](docs/nightmare-ii.md)      | Can live child scopes finish touching an outer resource before it is released, even when cancellation lands inside acquisition?                      |

They are numbered for the shelf, not because one explains the other. Enter the
[Nightmare index](docs/nightmares.md) for source, captured output, and the
invariant each program is trying to break.

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

Benchmarks are weather reports, not scripture. Still, it helps to know whether
to pack an umbrella. The table below compares equivalent flows four ways and
normalizes each runtime's vanilla implementation to `1x`. Results are shown as
`Node / Bun`; higher is faster.

| Scenario                     | Vanilla | `better-result` | `yeet` runtime | `yeet` lowered |
| ---------------------------- | ------- | --------------- | -------------- | -------------- |
| Sync single success          | `1x`    | `.08 / .14x`    | `.08 / .11x`   | `.50 / .61x`   |
| Sync two successes           | `1x`    | `.09 / .19x`    | `.09 / .21x`   | `.48 / .76x`   |
| Sync failure / short-circuit | `1x`    | `2.53 / 1.85x`  | `2.61 / 2.34x` | `22.1 / 16.3x` |
| Async two successes          | `1x`    | `.11 / .14x`    | `.09 / .13x`   | `.65 / .72x`   |
| Complex checkout success     | `1x`    | `.08 / .15x`    | `.10 / .19x`   | `.39 / .76x`   |

Runtime yeet and `better-result` occupy roughly the same country. The optional
optimizer is the interesting border crossing: supported flows become ordinary
branches, running about `3.6-8.5x` faster than yeet's generator runtime in these
tests. On typed failure, lowered yeet is `16-22x` faster than throwing and
catching the same error.

See [Benchmarks](docs/benchmarks.md) for raw throughput, exact commands, stream
results, methodology, and enough caveats to keep everyone honest.

## License

MIT
