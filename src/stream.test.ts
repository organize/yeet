import { describe, expect, it } from 'vitest'

import { either } from './combinators.ts'
import { type Either, left, right } from './either.ts'
import {
  bytes,
  chunks,
  collectText,
  consume,
  json,
  lines,
  ndjson,
  sse,
  text,
} from './stream.ts'

const encoder = new TextEncoder()

function encode(input: string): Uint8Array {
  return encoder.encode(input)
}

async function* byteChunks(
  parts: readonly string[],
): AsyncGenerator<Uint8Array, void, unknown> {
  for (const part of parts) yield encode(part)
}

async function* stringChunks(
  parts: readonly string[],
): AsyncGenerator<string, void, unknown> {
  for (const part of parts) yield part
}

async function collectEither<E, A>(
  source: AsyncIterable<Either<E, A>>,
): Promise<Either<E, A>[]> {
  const values: Either<E, A>[] = []
  for await (const value of source) values.push(value)
  return values
}

async function collectRights<E, A>(
  source: AsyncIterable<Either<E, A>>,
): Promise<A[]> {
  const values: A[] = []
  for await (const value of source) {
    if (value._tag === 'Left') {
      throw new Error(`Unexpected Left: ${String(value.error)}`)
    }
    values.push(value.value)
  }
  return values
}

function hasTag<T extends string>(
  value: unknown,
  tag: T,
): value is { readonly _tag: T } & Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { readonly _tag?: unknown })._tag === tag
  )
}

function expectRight<A>(result: Either<unknown, A>, value: A): void {
  expect(result._tag).toBe('Right')
  if (result._tag === 'Right') expect(result.value).toEqual(value)
}

function expectLeftTag(result: Either<unknown, unknown>, tag: string): void {
  expect(result._tag).toBe('Left')
  if (result._tag === 'Left') expect(hasTag(result.error, tag)).toBe(true)
}

function trackedByteStream(parts: readonly string[]): {
  readonly stream: ReadableStream<Uint8Array>
  readonly state: {
    pulls: number
    enqueued: number
    cancelled: boolean
    cancelReason: unknown
  }
} {
  const state = {
    pulls: 0,
    enqueued: 0,
    cancelled: false,
    cancelReason: undefined as unknown,
  }
  let index = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++
      const part = parts[index]
      index++
      if (part === undefined) {
        controller.close()
        return
      }

      controller.enqueue(encode(part))
      state.enqueued++
    },
    cancel(reason) {
      state.cancelled = true
      state.cancelReason = reason
    },
  })

  return { stream, state }
}

describe('bytes', () => {
  it('returns direct Uint8Array input without copying', async () => {
    const input = new Uint8Array([1, 2, 3])

    const result = await bytes(input)

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.value).toBe(input)
  })

  it('respects already-aborted signals before reading immediate bytes', async () => {
    const controller = new AbortController()
    controller.abort('stop')

    const result = await bytes(new Uint8Array([1, 2, 3]), {
      signal: controller.signal,
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.error).toEqual({ _tag: 'Aborted', reason: 'stop' })
    }
  })

  it('respects ArrayBufferView offsets', async () => {
    const input = new Uint8Array([0, 1, 2, 3]).subarray(1, 3)

    const result = await bytes(input)

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect([...result.value]).toEqual([1, 2])
  })

  it('concatenates async iterable byte chunks', async () => {
    const result = await bytes(byteChunks(['hel', 'lo']))

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') {
      expect(new TextDecoder().decode(result.value)).toBe('hello')
    }
  })

  it('enforces maxBytes and closes the source on overflow', async () => {
    let closed = false

    async function* source() {
      try {
        yield encode('hello')
        yield encode('world')
      } finally {
        closed = true
      }
    }

    const result = await bytes(source(), { maxBytes: 6 })

    expectLeftTag(result, 'StreamTooLarge')
    expect(closed).toBe(true)
    if (result._tag === 'Left' && result.error._tag === 'StreamTooLarge') {
      expect(result.error.bytesRead).toBe(10)
    }
  })

  it('returns empty bytes for a response with no body', async () => {
    const result = await bytes(new Response(null))

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') expect(result.value.byteLength).toBe(0)
  })

  it('reads request bodies', async () => {
    const result = await bytes(
      new Request('https://example.com/upload', {
        method: 'POST',
        body: 'hello',
      }),
    )

    expect(result._tag).toBe('Right')
    if (result._tag === 'Right') {
      expect(new TextDecoder().decode(result.value)).toBe('hello')
    }
  })
})

describe('chunks', () => {
  it('yields a single Right for direct bytes', async () => {
    const result = await collectEither(chunks(encode('hello')))

    expect(result).toHaveLength(1)
    expect(result[0]?._tag).toBe('Right')
  })

  it('converts invalid chunks to Left<InvalidChunk>', async () => {
    async function* source() {
      yield 'not bytes'
    }

    const result = await collectEither(chunks(source()))

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left')
      expect(result[0].error._tag).toBe('InvalidChunk')
  })

  it('converts iterator throws to Left<StreamReadError>', async () => {
    const error = new Error('read failed')

    async function* source() {
      yield encode('ok')
      throw error
    }

    const result = await collectEither(chunks(source()))

    expect(result[0]?._tag).toBe('Right')
    expect(result[1]?._tag).toBe('Left')
    if (result[1]?._tag === 'Left') {
      expect(hasTag(result[1].error, 'StreamReadError')).toBe(true)
      if (hasTag(result[1].error, 'StreamReadError')) {
        expect(result[1].error.cause).toBe(error)
      }
    }
  })

  it('yields Left<Aborted> for an already-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort('stop')

    const result = await collectEither(
      chunks(byteChunks(['never']), { signal: controller.signal }),
    )

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left') {
      expect(result[0].error).toEqual({ _tag: 'Aborted', reason: 'stop' })
    }
  })

  it('cancels a pending ReadableStream read on abort', async () => {
    const controller = new AbortController()
    let canceled = false
    let cancelReason: unknown

    const stream = new ReadableStream<Uint8Array>({
      cancel(reason) {
        canceled = true
        cancelReason = reason
      },
    })

    const iterator = chunks(stream, { signal: controller.signal })[
      Symbol.asyncIterator
    ]()

    const pending = iterator.next()
    controller.abort('stop')

    const result = await pending
    await iterator.return?.()

    expect(result.done).toBe(false)
    if (!result.done) {
      expect(result.value._tag).toBe('Left')
      if (result.value._tag === 'Left') {
        expect(result.value.error).toEqual({ _tag: 'Aborted', reason: 'stop' })
      }
    }
    expect(canceled).toBe(true)
    expect(cancelReason).toBe('stop')
  })

  it('forwards an explicit return reason to a chunk source', async () => {
    const reason = { _tag: 'ConsumerStopped' as const }
    const { stream, state } = trackedByteStream(
      Array.from({ length: 20 }, (_, index) => String(index)),
    )
    const iterator = chunks(stream) as AsyncIterator<
      Either<unknown, unknown>,
      unknown,
      unknown
    >

    await iterator.next()
    await iterator.return?.(reason)

    expect(state.cancelReason).toBe(reason)
  })
})

describe('consume', () => {
  it('drains raw chunks without allocating Right per success', async () => {
    const seen: string[] = []

    const result = await consume(stringChunks(['a', 'b']), {
      each(chunk) {
        seen.push(chunk)
      },
    })

    expectRight(result, undefined)
    expect(seen).toEqual(['a', 'b'])
  })

  it('unwraps Either chunks and stops on the first Left', async () => {
    let closed = false

    async function* source() {
      try {
        yield right('ok')
        yield left('bad' as const)
        yield right('never')
      } finally {
        closed = true
      }
    }

    const seen: string[] = []
    const result = await consume(source(), {
      each(chunk) {
        seen.push(chunk)
      },
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.error).toBe('bad')
    expect(seen).toEqual(['ok'])
    expect(closed).toBe(true)
  })

  it('stops when the consumer returns a Left', async () => {
    let closed = false

    async function* source() {
      try {
        yield 'first'
        yield 'second'
      } finally {
        closed = true
      }
    }

    const result = await consume(source(), {
      each() {
        return left('Stop' as const)
      },
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.error).toBe('Stop')
    expect(closed).toBe(true)
  })

  it('converts consumer throws to Left<StreamConsumerError>', async () => {
    const error = new Error('boom')

    const result = await consume(stringChunks(['a']), {
      each() {
        throw error
      },
    })

    expectLeftTag(result, 'StreamConsumerError')
    if (result._tag === 'Left' && hasTag(result.error, 'StreamConsumerError')) {
      expect(result.error['cause']).toBe(error)
    }
  })

  it('can be stopped by an external error promise', async () => {
    let closed = false
    const iterator: AsyncIterator<string> = {
      next: async () => new Promise<IteratorResult<string>>(() => {}),
      return: async () => {
        closed = true
        return { done: true, value: undefined }
      },
    }
    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => iterator,
    }

    const result = await consume(source, {
      error: Promise.resolve('outside'),
      each() {},
    })

    expectLeftTag(result, 'StreamExternalError')
    expect(closed).toBe(true)
  })

  it('does not pull from the source when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort('stop')
    let pulled = false

    const source: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          pulled = true
          return { done: true, value: undefined }
        },
      }),
    }

    const result = await consume(source, {
      signal: controller.signal,
      each() {},
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.error).toEqual({ _tag: 'Aborted', reason: 'stop' })
    }
    expect(pulled).toBe(false)
  })
})

describe('collectText', () => {
  it('collects text chunks and tees each delta', async () => {
    const deltas: string[] = []

    const result = await collectText(stringChunks(['hel', 'lo']), {
      tee(delta) {
        deltas.push(delta)
      },
    })

    expectRight(result, 'hello')
    expect(deltas).toEqual(['hel', 'lo'])
  })

  it('enforces maxChars', async () => {
    const result = await collectText(stringChunks(['hello', 'world']), {
      maxChars: 6,
    })

    expectLeftTag(result, 'TextTooLarge')
    if (result._tag === 'Left' && result.error._tag === 'TextTooLarge') {
      expect(result.error.chars).toBe(10)
    }
  })
})

describe('decoding and parsing', () => {
  it('decodes byte streams as text', async () => {
    const result = await text(byteChunks(['hel', 'lo']))

    expectRight(result, 'hello')
  })

  it('returns Left<DecodeError> for fatal utf-8 errors', async () => {
    const result = text(new Uint8Array([0xff]), { fatal: true })

    await expect(result).resolves.toMatchObject({
      _tag: 'Left',
      error: { _tag: 'DecodeError' },
    })
  })

  it('parses json from bytes', async () => {
    const result = await json(encode('{"ok":true}'))

    expectRight(result, { ok: true })
  })

  it('returns Left<ParseError> for invalid json', async () => {
    const result = json(encode('{nope'))

    await expect(result).resolves.toMatchObject({
      _tag: 'Left',
      error: { _tag: 'ParseError' },
    })
  })
})

describe('lines and structured streams', () => {
  it('splits utf-8 lines across chunks and strips CRLF', async () => {
    const result = await collectRights(
      lines(byteChunks(['hello\r\nwo', 'rld\nlast'])),
    )

    expect(result).toEqual(['hello', 'world', 'last'])
  })

  it('keeps decoder state for split multibyte characters', async () => {
    const input = encode('a€\nb')

    async function* source() {
      yield input.subarray(0, 2)
      yield input.subarray(2)
    }

    const result = await collectRights(lines(source()))

    expect(result).toEqual(['a€', 'b'])
  })

  it('returns Left<DecodeError> for fatal line decoding errors', async () => {
    const result = await collectEither(
      lines(new Uint8Array([0xff]), { fatal: true }),
    )

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left')
      expect(result[0].error._tag).toBe('DecodeError')
  })

  it('enforces maxLineBytes', async () => {
    const result = await collectEither(
      lines(byteChunks(['abcd']), {
        maxLineBytes: 3,
      }),
    )

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left')
      expect(result[0].error._tag).toBe('LineTooLarge')
  })

  it('parses ndjson and skips empty lines', async () => {
    const result = await collectRights(
      ndjson(byteChunks(['{"a":1}\n\n{"b":2}\n'])),
    )

    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('returns Left<ParseError> for invalid ndjson', async () => {
    const result = await collectEither(ndjson(byteChunks(['{"a":\n'])))

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left')
      expect(result[0].error._tag).toBe('ParseError')
  })

  it('continues after malformed ndjson lines when the consumer keeps going', async () => {
    const { stream, state } = trackedByteStream([
      '{"a":1}\n',
      '{ nope\n',
      '{"b":2}\n',
    ])

    const result = await collectEither(ndjson(stream))

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual(right({ a: 1 }))
    expect(result[1]?._tag).toBe('Left')
    if (result[1]?._tag === 'Left')
      expect(result[1].error._tag).toBe('ParseError')
    expect(result[2]).toEqual(right({ b: 2 }))
    expect(state.cancelled).toBe(false)
  })

  it('cancels the source when a consumer breaks an ndjson loop early', async () => {
    const { stream, state } = trackedByteStream([
      '{"seq":0}\n',
      '{"seq":1}\n',
      '{"seq":2}\n',
      '{"seq":3}\n',
    ])
    let seen = 0

    for await (const item of ndjson(stream)) {
      expect(item._tag).toBe('Right')
      seen++
      if (seen === 2) break
    }

    expect(seen).toBe(2)
    expect(state.cancelled).toBe(true)
  })

  it('forwards an explicit ndjson return reason to the byte source', async () => {
    const reason = { _tag: 'ForkEachStopped' as const }
    const { stream, state } = trackedByteStream(
      Array.from({ length: 20 }, (_, index) => `{"seq":${index}}\n`),
    )
    const iterator = ndjson(stream) as AsyncIterator<
      Either<unknown, unknown>,
      unknown,
      unknown
    >

    const first = await iterator.next()
    expect(first.done).toBe(false)
    await iterator.return?.(reason)

    expect(state.cancelled).toBe(true)
    expect(state.cancelReason).toBe(reason)
  })

  it('does not echo an existing stream error as a teardown rejection', async () => {
    const reason = { _tag: 'ForkEachStopped' as const }
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(reason)
      },
    })
    const iterator = sse(stream) as AsyncIterator<
      Either<unknown, unknown>,
      unknown,
      unknown
    >

    const first = await iterator.next()
    expect(first.done).toBe(false)
    if (first.done === false) {
      expect(first.value._tag).toBe('Left')
      if (first.value._tag === 'Left') {
        expect(first.value.error).toEqual({
          _tag: 'StreamReadError',
          cause: reason,
        })
      }
    }

    await expect(iterator.return?.(reason)).resolves.toEqual({
      done: true,
      value: reason,
    })
  })

  it('cancels the source with a fatal line-size reason', async () => {
    const { stream, state } = trackedByteStream([
      '{"seq":0}\n',
      `${JSON.stringify({ blob: 'x'.repeat(64) })}\n`,
      '{"seq":1}\n',
    ])

    const result = await collectEither(ndjson(stream, { maxLineBytes: 16 }))

    expect(result[0]).toEqual(right({ seq: 0 }))
    expect(result[1]?._tag).toBe('Left')
    if (result[1]?._tag === 'Left')
      expect(result[1].error._tag).toBe('LineTooLarge')
    expect(state.cancelled).toBe(true)
    expect(hasTag(state.cancelReason, 'LineTooLarge')).toBe(true)
  })

  it('cancels the source with the external error reason', async () => {
    const external = { _tag: 'ClientGone' as const }
    const state = {
      cancelled: false,
      cancelReason: undefined as unknown,
    }
    const stream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel(reason) {
        state.cancelled = true
        state.cancelReason = reason
      },
    })

    const result = await collectEither(
      ndjson(stream, { error: Promise.resolve(external) }),
    )

    expect(result[0]?._tag).toBe('Left')
    if (result[0]?._tag === 'Left')
      expect(result[0].error).toEqual({
        _tag: 'StreamExternalError',
        cause: external,
      })
    expect(state.cancelled).toBe(true)
    expect(state.cancelReason).toBe(external)
  })

  it('cancels the source when consume short-circuits an ndjson stream', async () => {
    const { stream, state } = trackedByteStream([
      '{"seq":0,"t":"tick"}\n',
      '{"seq":1,"t":"POISON"}\n',
      '{"seq":2,"t":"tick"}\n',
    ])
    let processed = 0

    const result = await consume(ndjson(stream), {
      each(frame) {
        if (
          frame !== null &&
          typeof frame === 'object' &&
          (frame as { readonly t?: unknown }).t === 'POISON'
        ) {
          return left({ _tag: 'PoisonFrame' as const, at: processed })
        }
        processed++
        return undefined
      },
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left')
      expect(result.error).toEqual({ _tag: 'PoisonFrame', at: 1 })
    expect(processed).toBe(1)
    expect(state.cancelled).toBe(true)
  })

  it('parses server-sent events', async () => {
    const result = await collectRights(
      sse(
        byteChunks([
          ': comment\n',
          'id: 42\n',
          'event: update\n',
          'retry: 1000\n',
          'data: hello\n',
          'data: world\n\n',
          'data: final\n',
        ]),
      ),
    )

    expect(result).toEqual([
      { event: 'update', data: 'hello\nworld', id: '42', retry: 1000 },
      { event: 'message', data: 'final', id: '42' },
    ])
  })
})

describe('yeet-style stream flows', () => {
  it('does not suppress an echoed stream cancellation beneath forkEach failure', async () => {
    const primary = Promise.withResolvers<Either<'LiveDemoDetected', never>>()
    const streamStarted = Promise.withResolvers<void>()

    const resultPromise = either(async function* ({ signal }) {
      for await (const { result } of signal.forkEach<
        number,
        unknown,
        'unreachable'
      >([0, 1], { concurrency: 2 }, async (item, child) => {
        if (item === 0) return await primary.promise

        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            streamStarted.resolve()
            const stop = () => controller.error(child.reason)
            if (child.aborted) stop()
            else child.addEventListener('abort', stop, { once: true })
          },
        })
        for await (const event of sse(stream)) {
          if (event._tag === 'Left') return event
        }
        return right('unreachable' as const)
      })) {
        yield* result
      }
      return 'unreachable' as const
    })

    await streamStarted.promise
    primary.resolve(left('LiveDemoDetected'))

    const result = await resultPromise
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.error).toBe('LiveDemoDetected')
  })

  it('uses bytes inside an async either flow', async () => {
    const result = await either(async function* () {
      const body = yield* await text(byteChunks(['doc', ' body']), {
        maxBytes: 25_000_000,
      })
      return body
    })

    expectRight(result, 'doc body')
  })

  it('uses sse with yield* next and a typed provider error', async () => {
    const result = await either(async function* (raise) {
      const handled: string[] = []

      for await (const next of sse(
        byteChunks([
          'event: message\n',
          'data: hello\n\n',
          'event: error\n',
          'data: provider down\n\n',
        ]),
      )) {
        const event = yield* next
        if (event.event === 'error') {
          return raise({
            _tag: 'ProviderError' as const,
            data: event.data,
          })
        }
        handled.push(event.data)
      }

      return handled
    })

    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.error).toEqual({
        _tag: 'ProviderError',
        data: 'provider down',
      })
    }
  })

  it('uses ndjson with validation and async persistence', async () => {
    type ToolEvent = { readonly id: number }
    const saved: ToolEvent[] = []

    const validateToolEvent = (
      value: unknown,
    ): Either<'InvalidToolEvent', ToolEvent> => {
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { readonly id?: unknown }).id === 'number'
      ) {
        return right(value as ToolEvent)
      }
      return left('InvalidToolEvent')
    }

    const saveEvent = async (
      event: ToolEvent,
    ): Promise<Either<'SaveError', void>> => {
      saved.push(event)
      return right(undefined)
    }

    const result = await either(async function* () {
      for await (const next of ndjson(byteChunks(['{"id":1}\n{"id":2}\n']))) {
        const event = yield* next
        const valid = yield* validateToolEvent(event)
        yield* await saveEvent(valid)
      }

      return 'ok' as const
    })

    expectRight(result, 'ok')
    expect(saved).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('passes the abort signal into abortable either generators', async () => {
    const controller = new AbortController()
    let injected: AbortSignal | undefined
    let secondArg: AbortSignal | undefined

    const result = await either(
      controller.signal,
      // oxlint-disable-next-line require-yield
      async function* ({ signal }, second) {
        injected = signal
        secondArg = second
        return 'ok' as const
      },
    )

    expectRight(result, 'ok')
    expect(injected).toBe(secondArg)
    expect(injected).not.toBe(controller.signal)
    expect(typeof (injected as { fork?: unknown } | undefined)?.fork).toBe(
      'function',
    )
  })
})
