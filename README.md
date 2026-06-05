# yeet

`yeet` is a tiny (2.23 kB gzipped), dependency-free `Either` library for TypeScript. It gives you
typed `Left` / `Right` values, generator-based do-notation, async support, and a
few practical helpers for validation and fallback flows.

No runtime dependencies. No method-chain cathedral. No pipe operator pilgrimage.

Just ordinary JavaScript control flow, with TypeScript quietly keeping score.

```ts
import { either, left, right, type Either } from 'yeet'

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

// Either<"UserNotFound" | "Inactive" | "DbError", { user: User; orders: Order[] }>
```

## Install

```sh
npm install @big-time/yeet
pnpm add @big-time/yeet
yarn add @big-time/yeet
bun add @big-time/yeet
```

`yeet` is ESM, ships TypeScript declarations, and has zero runtime
dependencies.

## The Idea

An `Either<E, A>` is one of two things:

```ts
left(error) // Left<E>
right(value) // Right<A>
```

Inside `either(...)`, you can unwrap a `Right` with `yield*`. If the value is a
`Left`, the whole computation short-circuits and returns that `Left`.

```ts
const result = either(function* () {
  const value = yield* right(42) // value is 42
  yield* left('Nope') // stops here
  return value
}) // Either<'Nope', 42>
```

Returning `raise(error)` is the typed early-exit move:

```ts
const result = either(function* (raise) {
  const user = yield* getUser(id)
  if (!user.active) return raise('Inactive' as const)
  return user
}) // Either<'UserNotFound' | 'Inactive', User>
```

There are no annotations in that function body. The error union is inferred from
the things you yield and raise.

## Sync

```ts
const checkout = either(function* (raise) {
  const session = yield* getSession('session-1')
  if (!session.checkoutEnabled) return raise('CheckoutDisabled' as const)

  const user = yield* getUser(session.userId)
  const cart = yield* getCart(user.id)

  return { user, cart }
})
```

If `getSession`, `getUser`, or `getCart` returns a `Left`, execution stops at
that line. Otherwise the unwrapped success value continues downstream, like a
quiet river in a documentary about responsible software.

## Async

Async generators work the same way. Await the `Either`, then `yield*` it.

```ts
const result = await either(async function* (raise) {
  const user = yield* await fetchUser('1')
  const orders = yield* await fetchOrders(user.id)

  if (orders.length === 0) return raise('NoOrders' as const)

  return { user, orders }
})
```

Promises and thenables can go through `raise(promiseLike)`. Rejections become
`Left<Rejected>` instead of escaping as thrown exceptions.

```ts
import { either } from 'yeet'

const result = await either(async function* (raise) {
  const response = yield* await raise(fetch('/api/user'))

  if (!response.ok) {
    return raise({ _tag: 'HttpError' as const, status: response.status })
  }

  const data = yield* await raise(() => response.json() as Promise<unknown>)
  return data
})
```

If starting the operation can throw synchronously, pass a function instead.
`raise(fn)` uses `Promise.try`, so both synchronous throws and rejected promises
become `Left<Rejected>`.

```ts
const config = yield * (await raise(() => JSON.parse(readConfigFile())))
```

## Cancellation

Pass an `AbortSignal` as the first argument to make an async `either` flow
cooperatively cancellable. When the signal aborts, yeet returns
`Left<Aborted>` and calls `gen.return()`, so `finally`, `using`, and
`await using` cleanup get their turn.

```ts
const result = await either(signal, async function* (raise) {
  using conn = yield* openConn()

  const user = yield* await fetchUser(id, signal)
  const avatar = yield* await raise(fetch(user.avatarUrl, { signal }))

  return { user, avatar, conn }
})
```

`Aborted` is deliberately small:

```ts
type Aborted = { readonly _tag: 'Aborted'; readonly reason: unknown }
```

That `reason` is honestly `unknown`. `controller.abort()` with no argument gives
you the platform's default `AbortError` `DOMException`; `controller.abort(x)`
gives you `x`. Yeet does not comb its hair into a library-shaped error for you.

This is regular JavaScript cancellation, which means it is cooperative. The
driver can stop advancing the generator and unwind resources, but it cannot
interrupt synchronous CPU-bound work, and it cannot cancel an in-flight promise
unless that operation honors the same signal. Pass the signal to both layers:
yeet for the flow boundary, your I/O for the actual work. Closing over the same
`signal` keeps the call site honest without making the callback wear a second
hat.

If the current awaited operation ignores the signal, yeet requests
`gen.return()` immediately, but the returned promise cannot settle until the
generator reaches a point where JavaScript can unwind it. Responsiveness is
bounded by the longest in-flight step. If that step ignores the signal and never
settles, `either(signal, ...)` waits forever, patiently holding the lantern. The
fix is to thread the same signal into the operation doing the work; the driver
only guarantees "stop advancing and unwind."

If cleanup itself throws during abort unwind, that thrown error wins. Multiple
throwing `using` / `await using` disposers follow JavaScript's `SuppressedError`
rules, so the earlier cleanup failure is still chained instead of vanishing
under the floorboards.

## Concurrent All

Normal `yield* await` code is sequential. That is usually what you want, but
sometimes two independent things should begin their little journeys at the same
time.

`all` accepts `Either`, `Promise<Either>`, or thunks that return either of
those. Async inputs are observed concurrently. Promise rejections and synchronous
throws from thunks become `Left<Rejected>`.

```ts
import { all, collectAll, either } from 'yeet'

const result = await either(async function* () {
  const [user, settings] = yield* await all([fetchUser(id), fetchSettings(id)])

  return { user, settings }
})
```

The result is tuple-shaped, so each success keeps its own type:

```ts
const result = await all([
  right(1),
  Promise.resolve(right('two')),
  () => right(true),
])

// Either<Rejected, [number, string, boolean]>
```

For async failures, `all` waits for the inputs to settle, then returns the first
`Left` by input order. No race-condition fortune telling.

```ts
const result = await all([
  fetchSlowThing(), // eventually Left("SlowFailed")
  fetchFastThing(), // eventually Left("FastFailed")
])

// Left("SlowFailed")
```

If the work itself can throw while starting, use thunks:

```ts
const result = await all([() => parseConfigFile(), () => fetchSettings()])
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
```

`collectAll` is the sibling that does not short-circuit. It runs the same inputs
and partitions everything:

```ts
const { values, errors } = await collectAll(
  ids.map((id) => () => fetchUser(id)),
)
```

## Capture Instead Of Short-Circuit

Most of the time, `yield* left(...)` should stop the computation. Sometimes you
want to catch that `Left` as data: retry, log, ignore, or decide whether to
re-raise it yourself. That is what `capture` is for.

```ts
import { capture, either } from 'yeet'

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
```

`capture(either)` returns `Right<Either<E, A>>`, which means the outer
`either(...)` unwraps the `Right` and hands you the original `Either` as an
ordinary value. A small trapdoor, tastefully installed.

## Serialization

`Left` and `Right` serialize to small tagged JSON objects. Nothing clever is
hiding under the floorboards.

```ts
JSON.stringify(left('Nope'))
// {"_tag":"Left","error":"Nope"}

JSON.stringify(right({ id: 'user-1' }))
// {"_tag":"Right","value":{"id":"user-1"}}
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
```

For trusted values that already have the serialized shape, `fromJSON` hydrates
them back into `Left` / `Right` instances:

```ts
import { fromJSON, isSerializedEither, type SerializedEither } from 'yeet'

type User = { id: string }

const parsed = JSON.parse(json) as SerializedEither<string, User>
const result = fromJSON(parsed)
```

`isSerializedEither(value)` is available when you only need to detect yeet's
strict outer envelope. It does not validate nested payloads; that is what the
schemas below are for.

When the JSON came from outside the room, use a schema. `yeet` accepts
Standard Schema-compatible validators for the `error` and `value` payloads, so
you can bring Zod, Valibot, ArkType, TypeBox adapters, or whatever your project
already uses. `yeet` does not import any of them. It merely checks for
`~standard` and lets the grown-ups speak for themselves.

With Zod, pass schemas directly when you want validation or hydration:

```ts
import * as z from 'zod'
import { eitherSchema, serializedEitherSchema } from 'yeet'

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

const hydratedUserResult = eitherSchema({
  error: ApiError,
  value: User,
})

const parsed = await SerializedUserResult['~standard'].validate(
  JSON.parse(json),
)
const hydrated = await hydratedUserResult['~standard'].validate(
  JSON.parse(json),
)
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

For JSON Schema export, be explicit. Zod's documented API is
`z.toJSONSchema(schema)`, with `{ io: 'input' }` when you need the input side of
a transforming schema. Recent Zod versions may expose Standard JSON Schema
directly, but a tiny adapter keeps the README honest and lets you use Zod's
conversion options.

```ts
import * as z from 'zod'
import {
  serializedEitherSchema,
  type StandardJSONSchemaOptions,
  type StandardJSONSchemaV1,
  type StandardSchemaV1,
} from 'yeet'

const withZodJsonSchema = <Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaV1<z.input<Schema>, z.output<Schema>> &
  StandardJSONSchemaV1<z.input<Schema>, z.output<Schema>> => ({
  '~standard': {
    ...schema['~standard'],
    jsonSchema: {
      input: (options: StandardJSONSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target, io: 'input' }),
      output: (options: StandardJSONSchemaOptions) =>
        z.toJSONSchema(schema, { target: options.target }),
    },
  },
})

const SerializedUserResult = serializedEitherSchema({
  error: withZodJsonSchema(ApiError),
  value: withZodJsonSchema(User),
})

const jsonSchema = SerializedUserResult['~standard'].jsonSchema.output({
  target: 'draft-2020-12',
})
```

TypeBox and TypeMap fit the same hole. Compile or adapt the TypeBox schemas
into validators that expose `~standard`, then pass them in:

```ts
import { Type } from '@sinclair/typebox'
import { Compile } from '@sinclair/typemap'
import { serializedEitherSchema } from 'yeet'

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
```

When the nested schemas implement Standard JSON Schema, `yeet` includes their
JSON Schema inside the exported `Either` envelope. That gives you a portable
shape for API docs, structured outputs, form builders, or any other bit of
software that enjoys receiving small rectangles of truth.

Standard Schema and Standard JSON Schema are separate interfaces. If a nested
schema only implements validation, validation still works; its JSON Schema slot
is emitted as `{}` because `yeet` refuses to invent facts in a nice hat.

```ts
serializedEitherSchema({ error: ApiError, value: User })
// validates: unknown -> SerializedEither<ApiError, User>

eitherSchema({ error: ApiError, value: User })
// validates: unknown -> Either<ApiError, User>
```

Nested schemas are optional. Without them, `yeet` validates the outer
`{ _tag, error | value }` envelope and leaves the payload as `unknown`.

## Small Guards

`ensure` and `ensureNotNull` cover common checks without making you write tiny
one-off `Either` factories.

```ts
import { either, ensure, ensureNotNull } from 'yeet'

const result = either(function* (raise) {
  const id = yield* ensureNotNull(input.userId, () => 'MissingUserId' as const)
  yield* ensure(id.length > 0, () => 'EmptyUserId' as const)

  const user = yield* getUser(id)
  if (!user.active) return raise('Inactive' as const)

  return user
})
```

## Accumulate Errors

Sometimes the first error is not enough. `validate` runs every check and returns
all failures as `Left<E[]>`.

```ts
import { validate, left, right, type Either } from 'yeet'

const validateAge = (n: number): Either<'TooYoung' | 'TooOld', number> =>
  n < 0 ? left('TooYoung') : n > 150 ? left('TooOld') : right(n)

const validateName = (s: string): Either<'Empty' | 'TooLong', string> =>
  s.length === 0 ? left('Empty') : s.length > 100 ? left('TooLong') : right(s)

const result = validate(function* (check) {
  const age = yield* check(validateAge(input.age))
  const name = yield* check(validateName(input.name))

  return { age, name }
})

// Either<
//   ("TooYoung" | "TooOld" | "Empty" | "TooLong")[],
//   { age: number | undefined; name: string | undefined }
// >
```

When a check fails, `check(...)` returns `undefined` inside the generator so the
rest of the validation can continue. The final result tells you whether the day
was won.

## Try The First Success

`firstOf` tries yielded `Either`s in order and returns the first `Right`. If they
all fail, it returns every error.

```ts
import { firstOf } from 'yeet'

const user = firstOf(function* () {
  yield getUserFromCache(id)
  yield getUserFromReplica(id)
  yield getUserFromPrimary(id)
})

// Either<Error[], User>
```

## Collect Results

`collect` partitions every yielded value into successes and failures.

```ts
import { collect } from 'yeet'

const { values, errors } = collect(function* () {
  for (const item of items) {
    yield processItem(item)
  }
})
```

No short-circuiting. No judgment. Just two arrays, standing there in the light.

## Manual Folding

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

## API

```ts
// Core
left(error)
right(value)
isLeft(value)
isRight(value)

// Generator runners
either(fn)
either(signal, asyncFn)
capture(either)
validate(fn)
firstOf(fn)
collect(fn)
all(inputs)
collectAll(inputs)

// Serialization and schemas
fromJSON(value)
isSerializedEither(value)
serializedEitherSchema(options?)
eitherSchema(options?)

// Guards and async helpers
ensure(condition, onFail)
ensureNotNull(value, onNull)
raise(error)
raise(fn)
raise(promiseLike)
aborted(reason)
rejected(cause)

// Lower-level machinery
fold(fn, strategy)
foldAsync(generator, strategy)
```

`Left` and `Right` are small classes with `Symbol.iterator`, `toJSON`, and
`Symbol.toPrimitive` support. They work nicely with `yield*`, JSON
serialization, and straightforward tag checks.

## Why This Exists

A lot of Result libraries ask you to learn a second little programming language:
`map`, `flatMap`, `andThen`, `pipe`, `tap`, `mapErr`, `orElse`, and friends. Good
tools, many of them. But sometimes you already have the best control-flow syntax
available:

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
success, and collection scenarios.

## License

MIT
