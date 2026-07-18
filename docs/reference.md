[← README](../README.md) · [Documentation](./README.md)

# API Reference

The public surface, gathered in one place for the moment when you know what you
want and would prefer that the documentation simply tell you its name.

## Core

| API              | Description         |
| ---------------- | ------------------- |
| `left(error)`    | Create a `Left<E>`  |
| `right(value)`   | Create a `Right<A>` |
| `isLeft(value)`  | Narrow to `Left`    |
| `isRight(value)` | Narrow to `Right`   |

## Generator Runners

| API                       | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `either(fn)`              | Short-circuiting sync or async generator runner                    |
| `either(signal, asyncFn)` | Abort-aware async runner; `asyncFn` receives a scoped `AbortRaise` |
| `validate(fn)`            | Accumulate every yielded error                                     |
| `firstOf(fn)`             | Return the first yielded `Right`                                   |
| `collect(fn)`             | Partition yielded values into errors and values                    |

## Concurrency

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

## Guards And Async Helpers

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

## Serialization And Schemas

| API                                | Description                                           |
| ---------------------------------- | ----------------------------------------------------- |
| `fromJSON(value)`                  | Hydrate trusted serialized JSON into `Left` / `Right` |
| `isSerializedEither(value)`        | Detect yeet's strict JSON envelope                    |
| `serializedEitherSchema(options?)` | Standard Schema validator for serialized JSON         |
| `eitherSchema(options?)`           | Standard Schema validator that hydrates to `Either`   |
| `exitErrorSchema(options?)`        | Standard Schema validator for scoped Exit errors      |
| `serializedExitSchema(options?)`   | Standard Schema validator for serialized `Exit` JSON  |
| `exitSchema(options?)`             | Standard Schema validator that hydrates to `Exit`     |

## Streams And Bytes

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

## Lower-Level Machinery

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

| API                              | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `fold(fn, strategy)`             | Drive a sync generator with a custom strategy   |
| `foldAsync(generator, strategy)` | Drive an async generator with a custom strategy |

`Left` and `Right` are small classes with `Symbol.iterator`, `toJSON`, and
`Symbol.toPrimitive` support. They work nicely with `yield*`, JSON
serialization, and straightforward tag checks.

---

[← Documentation](./README.md)
