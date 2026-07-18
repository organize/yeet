[← README](../README.md) · [Documentation](./README.md)

# Streams And Bytes

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

## Bounded Bodies

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

## AI Text Deltas

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

## Structured Streams

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

---

[← Documentation](./README.md)
