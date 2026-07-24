[← README](../README.md) · [Documentation](./README.md)

# Cancellation And Structured Concurrency

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

## Scoped Forks

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

## Scoped Resources

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

That ordering is exercised end-to-end by
[Nightmare II](./nightmare-ii.md): four bounded children share one outer
connection, touch it during abort teardown, and turn any early release into a
tagged defect in the final memo.

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

---

[← Documentation](./README.md)
