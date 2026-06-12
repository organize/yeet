# yeet

> Dependency-free. Tree-shakeable. Side-effect free. About 2.6 kB gzipped.

`yeet` is a tiny `Either` library for TypeScript. It gives you typed
`Left` / `Right` values, generator-based do-notation, async support,
serialization helpers, Standard Schema integration, and an optional build-time
optimizer.

No runtime dependencies. No method-chain cathedral. No pipe-operator pilgrimage.

Just ordinary JavaScript control flow, with TypeScript quietly keeping score.

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Core Model](#core-model)
- [Synchronous Flows](#synchronous-flows)
- [Async Flows](#async-flows)
- [Cancellation](#cancellation)
- [Composition Helpers](#composition-helpers)
- [Serialization And Schemas](#serialization-and-schemas)
- [Build-Time Optimizer](#build-time-optimizer)
- [Low-Level Folding](#low-level-folding)
- [API Reference](#api-reference)
- [Benchmarks](#benchmarks)
- [License](#license)

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
const result = await either(signal, async function* (raise) {
  using conn = yield* openConn()

  const user = yield* await fetchUser(id, signal)
  const avatar = yield* await raise(fetch(user.avatarUrl, { signal }))

  return { user, avatar, conn }
})

// inferred:
// Either<
//   Aborted | OpenConnError | FetchUserError | Rejected,
//   { user: User; avatar: Response; conn: Conn }
// >
```

When the signal aborts, yeet returns `Left<Aborted>` and calls `gen.return()`,
so `finally`, `using`, and `await using` cleanup get their turn.

```ts
type Aborted = { readonly _tag: 'Aborted'; readonly reason: unknown }
```

That `reason` is honestly `unknown`. `controller.abort()` with no argument gives
you the platform's default `AbortError` `DOMException`; `controller.abort(x)`
gives you `x`. Yeet does not comb its hair into a library-shaped error for you.

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

## Composition Helpers

The helpers in this section are still just functions. No DSL hatch opens in the
ceiling. They cover the cases where plain short-circuiting is not quite the
story you want to tell.

| Helper               | What It Does                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| `capture(either)`    | Treat a `Left` as ordinary data inside `either`                               |
| `all(inputs)`        | Start independent sync/async inputs together and short-circuit by input order |
| `collectAll(inputs)` | Start independent inputs together and partition successes/failures            |
| `validate(fn)`       | Run every check and accumulate all errors                                     |
| `firstOf(fn)`        | Return the first successful yielded `Either`                                  |
| `collect(fn)`        | Partition every yielded `Either` into `{ values, errors }`                    |

### Capture Instead Of Short-Circuit

Most of the time, `yield* left(...)` should stop the computation. Sometimes you
want to catch that `Left` as data: retry, log, ignore, or decide whether to
re-raise it yourself.

```ts
import { capture, either } from '@big-time/yeet'

const result = either(function* (raise) {
  const cached = yield* capture(getUserFromCache(id))

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

`capture(either)` returns `Right<Either<E, A>>`, so the outer `either(...)`
unwraps the `Right` and hands you the original `Either` as an ordinary value. A
small trapdoor, tastefully installed.

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
all fail, it returns every error:

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
accumulator JavaScript. If it cannot prove the shape, it leaves the original
runtime call exactly where it found it.

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
import { either as e } from '@big-time/yeet'

const result = e(function* () {
  return yield* right(42)
})

// inferred: Either<never, number>
```

It lowers these proven shapes:

- direct `yield* someEither()` steps in `either`
- direct `yield* check(someEither())` steps in `validate`
- direct `yield someEither` attempts in `firstOf` and `collect`

It bails on the abortable overload, escaped `raise` / `check`, `this`,
`arguments`, indirect `yield*` values, and expression positions where hoisting
would change evaluation. The runtime library remains the interpreter underneath,
as dependable as a man in a dark suit explaining how rain becomes a river.

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

| API                       | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `either(fn)`              | Short-circuiting sync or async generator runner |
| `either(signal, asyncFn)` | Abort-aware async generator runner              |
| `capture(either)`         | Preserve a `Left` as data inside `either`       |
| `validate(fn)`            | Accumulate every yielded error                  |
| `firstOf(fn)`             | Return the first yielded `Right`                |
| `collect(fn)`             | Partition yielded values into errors and values |

### Concurrency

| API                  | Description                                                          |
| -------------------- | -------------------------------------------------------------------- |
| `all(inputs)`        | Run independent inputs concurrently and short-circuit by input order |
| `collectAll(inputs)` | Run independent inputs concurrently and partition all outcomes       |

### Guards And Async Helpers

| API                            | Description                                                        |
| ------------------------------ | ------------------------------------------------------------------ |
| `ensure(condition, onFail)`    | Return `Right<void>` or `Left(onFail())`                           |
| `ensureNotNull(value, onNull)` | Unwrap a non-nullish value or return `Left(onNull())`              |
| `raise(error)`                 | Create a typed early return value                                  |
| `raise(fn)`                    | Capture synchronous throw or promise rejection as `Left<Rejected>` |
| `raise(promiseLike)`           | Capture promise rejection as `Left<Rejected>`                      |
| `aborted(reason)`              | Create an `Aborted` error payload                                  |
| `rejected(cause)`              | Create a `Rejected` error payload                                  |

### Serialization And Schemas

| API                                | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| `fromJSON(value)`                  | Hydrate trusted serialized JSON into `Left` / `Right` |
| `isSerializedEither(value)`        | Detect yeet's strict JSON envelope                    |
| `serializedEitherSchema(options?)` | Standard Schema validator for serialized JSON         |
| `eitherSchema(options?)`           | Standard Schema validator that hydrates to `Either`   |

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
bun run bench:quick
bun run bench:memory
```

These benchmarks are intentionally tiny and can be sensitive to runtime noise,
JIT mood, and passing clouds. Treat them as directional, not holy scripture.

The current benchmark suite compares common `either` flows against
`better-result`, and includes sync, async, short-circuit, validation, first
success, collection, and plugin-transformed scenarios.

## License

MIT
