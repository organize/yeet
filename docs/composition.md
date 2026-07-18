[← README](../README.md) · [Documentation](./README.md)

# Composition Helpers

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

## Capture Instead Of Short-Circuit

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

## Concurrent Inputs With `all`

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

## Partition Concurrent Inputs With `collectAll`

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

## Accumulate Errors With `validate`

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

## Try The First Success With `firstOf`

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

## Collect Results With `collect`

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

---

[← Documentation](./README.md)
