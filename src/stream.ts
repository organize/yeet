import { type Aborted, aborted } from './async.ts'
import { type Either, Left, Right, left, right } from './either.ts'

export type ByteSource =
  | Request
  | Response
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<unknown>
  | AsyncIterable<unknown>

export type StreamSource<T> = ReadableStream<T> | AsyncIterable<T>

export type StreamReadError = {
  readonly _tag: 'StreamReadError'
  readonly cause: unknown
}

export type StreamExternalError = {
  readonly _tag: 'StreamExternalError'
  readonly cause: unknown
}

export type StreamConsumerError = {
  readonly _tag: 'StreamConsumerError'
  readonly cause: unknown
}

export type StreamTooLarge = {
  readonly _tag: 'StreamTooLarge'
  readonly maxBytes: number
  readonly bytesRead: number
}

export type TextTooLarge = {
  readonly _tag: 'TextTooLarge'
  readonly maxChars: number
  readonly chars: number
}

export type LineTooLarge = {
  readonly _tag: 'LineTooLarge'
  readonly maxBytes: number
  readonly bytesRead: number
}

export type InvalidChunk = {
  readonly _tag: 'InvalidChunk'
  readonly chunk: unknown
}

export type DecodeError = {
  readonly _tag: 'DecodeError'
  readonly encoding: string
  readonly cause: unknown
}

export type ParseError = {
  readonly _tag: 'ParseError'
  readonly format: 'json' | 'ndjson' | 'sse'
  readonly cause: unknown
}

export type StreamError =
  | StreamReadError
  | StreamExternalError
  | StreamConsumerError
  | StreamTooLarge
  | TextTooLarge
  | LineTooLarge
  | InvalidChunk
  | DecodeError
  | ParseError

export type StreamOptions = {
  readonly signal?: AbortSignal | undefined
  readonly error?: PromiseLike<unknown> | undefined
}

export type ByteOptions = StreamOptions & {
  readonly maxBytes?: number | undefined
}

export type TextOptions = ByteOptions & {
  readonly fatal?: boolean | undefined
}

export type CollectTextOptions = StreamOptions & {
  readonly maxChars?: number | undefined
  readonly tee?: ((chunk: string) => void | Promise<void>) | undefined
}

export type ConsumeOptions<T, E> = StreamOptions & {
  readonly each: (chunk: T) => void | Left<E> | Promise<void | Left<E>>
}

export type LineOptions = ByteOptions & {
  readonly maxLineBytes?: number | undefined
  readonly fatal?: boolean | undefined
}

export type JsonOptions = TextOptions

export type SseEvent = {
  readonly event: string
  readonly data: string
  readonly id?: string
  readonly retry?: number
}

type StopResult = { readonly done: true; readonly error: Aborted | StreamError }
type ContinueResult<T> = { readonly done: false; readonly result: T }
type RaceResult<T> = StopResult | ContinueResult<T>
type StopState = {
  readonly promise: Promise<Aborted | StreamError> | undefined
  readonly initial: Aborted | StreamError | undefined
  readonly cleanup: () => void
}
type ReleasableAsyncIterator<T> = AsyncIterator<T> & { release(): void }

const EMPTY_BYTES = new Uint8Array(0)
const DEFAULT_EVENT = 'message'
const STREAM_DECODE_OPTIONS = { stream: true }

export async function bytes(
  source: ByteSource,
  options: ByteOptions = {},
): Promise<Either<Aborted | StreamError, Uint8Array>> {
  const stop = createStopState(options)
  if (stop.initial !== undefined) return left(stop.initial)

  const immediate = immediateBytes(source)
  if (immediate !== undefined) {
    if (
      options.maxBytes !== undefined &&
      immediate.byteLength > options.maxBytes
    ) {
      return left(streamTooLarge(options.maxBytes, immediate.byteLength))
    }
    return right(immediate)
  }

  const parts: Uint8Array[] = []
  let total = 0
  const iterator = byteIterator(source)
  if (iterator._tag === 'Left') return iterator

  let close: 'cancel' | 'release' = 'release'
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator.value, stop)
        if (next.done) {
          close = 'cancel'
          return left(next.error)
        }
        result = next.result
      } else {
        result = await iterator.value.next()
      }

      if (result.done === true) return right(concatBytes(parts, total))

      const chunk = asBytes(result.value)
      if (chunk === undefined) {
        close = 'cancel'
        return left(invalidChunk(result.value))
      }

      total += chunk.byteLength
      if (options.maxBytes !== undefined && total > options.maxBytes) {
        close = 'cancel'
        return left(streamTooLarge(options.maxBytes, total))
      }
      parts.push(chunk)
    }
  } catch (cause) {
    close = 'cancel'
    return left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator.value, close)
  }
}

export async function text(
  source: ByteSource,
  options: TextOptions = {},
): Promise<Either<Aborted | StreamError, string>> {
  const body = await bytes(source, options)
  if (body._tag === 'Left') return body
  return decodeUtf8(body.value, options)
}

export async function json(
  source: ByteSource,
  options: JsonOptions = {},
): Promise<Either<Aborted | StreamError, unknown>> {
  const body = await text(source, options)
  if (body._tag === 'Left') return body
  return parseJson(body.value)
}

export async function* chunks(
  source: ByteSource,
  options: ByteOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, Uint8Array>, void, unknown> {
  const stop = createStopState(options)
  if (stop.initial !== undefined) {
    yield left(stop.initial)
    return
  }

  const immediate = immediateBytes(source)
  if (immediate !== undefined) {
    if (
      options.maxBytes !== undefined &&
      immediate.byteLength > options.maxBytes
    ) {
      yield left(streamTooLarge(options.maxBytes, immediate.byteLength))
      return
    }
    yield right(immediate)
    return
  }

  const iterator = byteIterator(source)
  if (iterator._tag === 'Left') {
    yield iterator
    return
  }

  let bytesRead = 0
  let close: 'cancel' | 'release' = 'release'
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator.value, stop)
        if (next.done) {
          close = 'cancel'
          yield left(next.error)
          return
        }
        result = next.result
      } else {
        result = await iterator.value.next()
      }

      if (result.done === true) return

      const chunk = asByteChunk(result.value)
      if (chunk._tag === 'Left') {
        close = 'cancel'
        yield chunk
        return
      }

      bytesRead += chunk.value.byteLength
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        close = 'cancel'
        yield left(streamTooLarge(options.maxBytes, bytesRead))
        return
      }

      yield chunk
    }
  } catch (cause) {
    close = 'cancel'
    yield left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator.value, close)
  }
}

export async function consume<T, E, E2 = never>(
  source: AsyncIterable<Either<E, T>>,
  options: ConsumeOptions<T, E2>,
): Promise<Either<Aborted | StreamError | E | E2, void>>
export async function consume<T, E>(
  source: StreamSource<T>,
  options: ConsumeOptions<T, E>,
): Promise<Either<Aborted | StreamError | E, void>>
export async function consume<T, E, E2 = never>(
  source: StreamSource<T> | AsyncIterable<Either<E, T>>,
  options: ConsumeOptions<T, E2>,
): Promise<Either<Aborted | StreamError | E | E2, void>>
export async function consume<T, E, E2 = never>(
  source: StreamSource<T> | AsyncIterable<Either<E, T>>,
  options: ConsumeOptions<T, E2>,
): Promise<Either<Aborted | StreamError | E | E2, void>> {
  const stop = createStopState(options)
  if (stop.initial !== undefined) return left(stop.initial)

  const iterator = streamIterator(source)
  let close: 'cancel' | 'release' = 'release'
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          return left(next.error)
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) return right(undefined)

      const item = result.value
      if (item instanceof Left) {
        close = 'cancel'
        return item as Left<E>
      }
      const value = item instanceof Right ? item.value : (item as T)

      let step: void | Left<E2> | undefined
      try {
        const result = options.each(value)
        step =
          result === undefined
            ? undefined
            : isPromiseLike(result)
              ? await result
              : result
      } catch (cause) {
        close = 'cancel'
        return left(streamConsumerError(cause))
      }

      if (isLeftValue(step)) {
        close = 'cancel'
        return step
      }
    }
  } catch (cause) {
    close = 'cancel'
    return left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator, close)
  }
}

export async function collectText<E = never>(
  source: StreamSource<string> | AsyncIterable<Either<E, string>>,
  options: CollectTextOptions = {},
): Promise<Either<Aborted | StreamError | E, string>> {
  const stop = createStopState(options)
  if (stop.initial !== undefined) return left(stop.initial)

  const iterator = streamIterator(source)
  const parts: string[] = []
  let chars = 0
  let close: 'cancel' | 'release' = 'release'
  const maxChars = options.maxChars
  const tee = options.tee
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          return left(next.error)
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) return right(parts.join(''))

      const item = result.value
      if (item instanceof Left) {
        close = 'cancel'
        return item as Left<E>
      }

      const chunk = item instanceof Right ? item.value : (item as string)
      chars += chunk.length
      if (maxChars !== undefined && chars > maxChars) {
        close = 'cancel'
        return left(textTooLarge(maxChars, chars))
      }

      if (tee !== undefined) {
        try {
          const result = tee(chunk)
          if (isPromiseLike(result)) await result
        } catch (cause) {
          close = 'cancel'
          return left(streamConsumerError(cause))
        }
      }

      parts.push(chunk)
    }
  } catch (cause) {
    close = 'cancel'
    return left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator, close)
  }
}

export function lines(
  source: ByteSource,
  options: LineOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, string>, void, unknown> {
  return mapLines(source, options, (line) => right(line))
}

export function ndjson(
  source: ByteSource,
  options: LineOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, unknown>, void, unknown> {
  return mapLines(source, options, (line) => {
    if (line.length === 0) return undefined

    try {
      return right(JSON.parse(line) as unknown)
    } catch (cause) {
      return left(parseError('ndjson', cause))
    }
  })
}

export function sse(
  source: ByteSource,
  options: LineOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, SseEvent>, void, unknown> {
  let event = DEFAULT_EVENT
  const data: string[] = []
  let id: string | undefined
  let retry: number | undefined

  const flush = function (): Either<never, SseEvent> | undefined {
    if (
      data.length === 0 &&
      event === DEFAULT_EVENT &&
      id === undefined &&
      retry === undefined
    ) {
      return undefined
    }

    const result: { event: string; data: string; id?: string; retry?: number } =
      {
        event,
        data: data.length === 1 ? (data[0] as string) : data.join('\n'),
      }
    if (id !== undefined) result.id = id
    if (retry !== undefined) result.retry = retry

    event = DEFAULT_EVENT
    data.length = 0
    retry = undefined
    return right(result)
  }

  return mapLines(
    source,
    options,
    (line) => {
      if (line.length === 0) {
        return flush()
      }

      if (line[0] === ':') return undefined

      const separator = line.indexOf(':')
      const fieldEnd = separator === -1 ? line.length : separator
      const value =
        separator === -1
          ? ''
          : line.slice(
              line.charCodeAt(separator + 1) === 32
                ? separator + 2
                : separator + 1,
            )

      switch (fieldEnd) {
        case 5:
          if (line.startsWith('event')) event = value
          else if (line.startsWith('retry')) {
            const parsed = Number(value)
            if (Number.isInteger(parsed) && parsed >= 0) retry = parsed
          }
          break
        case 4:
          if (line.startsWith('data')) data.push(value)
          break
        case 2:
          if (!line.startsWith('id') || value.includes('\0')) break
          id = value
          break
      }
      return undefined
    },
    flush,
  )
}

async function* mapLines<A>(
  source: ByteSource,
  options: LineOptions,
  map: (line: string) => Either<StreamError, A> | undefined,
  finish?: () => Either<StreamError, A> | undefined,
): AsyncGenerator<Either<Aborted | StreamError, A>, void, unknown> {
  const stop = createStopState(options)
  if (stop.initial !== undefined) {
    yield left(stop.initial)
    return
  }

  const immediate = immediateBytes(source)
  const iterator =
    immediate === undefined
      ? byteIterator(source)
      : right(singleChunkIterator(immediate))
  if (iterator._tag === 'Left') {
    yield iterator
    return
  }

  const decoder = createUtf8Decoder(options)
  let carry = ''
  let bytesRead = 0
  let lineBytes = 0
  let close: 'cancel' | 'release' = 'release'
  const canStop = stop.promise !== undefined
  const maxLineBytes = options.maxLineBytes

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator.value, stop)
        if (next.done) {
          close = 'cancel'
          yield left(next.error)
          return
        }
        result = next.result
      } else {
        result = await iterator.value.next()
      }

      if (result.done === true) break

      const chunk = asBytes(result.value)
      if (chunk === undefined) {
        close = 'cancel'
        yield left(invalidChunk(result.value))
        return
      }

      bytesRead += chunk.byteLength
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        close = 'cancel'
        yield left(streamTooLarge(options.maxBytes, bytesRead))
        return
      }

      if (maxLineBytes !== undefined) {
        let lineStart = 0
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] !== 10) continue

          lineBytes += index - lineStart
          if (lineBytes > maxLineBytes) {
            close = 'cancel'
            yield left(lineTooLarge(maxLineBytes, lineBytes))
            return
          }

          lineBytes = 0
          lineStart = index + 1
        }

        lineBytes += chunk.byteLength - lineStart
        if (lineBytes > maxLineBytes) {
          close = 'cancel'
          yield left(lineTooLarge(maxLineBytes, lineBytes))
          return
        }
      }

      const decoded = decodeUtf8Chunk(decoder, chunk)
      if (decoded._tag === 'Left') {
        close = 'cancel'
        yield decoded
        return
      }

      if (decoded.value.length === 0) continue

      carry += decoded.value
      let start = 0
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const mapped = map(stripTrailingCrString(carry.slice(start, newline)))
        if (mapped !== undefined) {
          if (mapped._tag === 'Left') close = 'cancel'
          yield mapped
          if (mapped._tag === 'Left') return
        }

        start = newline + 1
        newline = carry.indexOf('\n', start)
      }

      carry = start === 0 ? carry : carry.slice(start)
    }

    const tail = flushUtf8Decoder(decoder)
    if (tail._tag === 'Left') {
      close = 'cancel'
      yield tail
      return
    }
    if (tail.value.length > 0) carry += tail.value

    if (carry.length > 0) {
      const mapped = map(stripTrailingCrString(carry))
      if (mapped !== undefined) {
        if (mapped._tag === 'Left') close = 'cancel'
        yield mapped
        if (mapped._tag === 'Left') return
      }
    }

    const final = finish?.()
    if (final !== undefined) yield final
  } catch (cause) {
    close = 'cancel'
    yield left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator.value, close)
  }
}

function decodeUtf8(
  input: Uint8Array,
  options: { readonly fatal?: boolean | undefined } = {},
): Either<DecodeError, string> {
  return decodeUtf8With(createUtf8Decoder(options), input)
}

function createUtf8Decoder(options: {
  readonly fatal?: boolean | undefined
}): TextDecoder {
  const decoderOptions =
    options.fatal === undefined ? undefined : { fatal: options.fatal }
  return new TextDecoder('utf-8', decoderOptions)
}

function decodeUtf8With(
  decoder: TextDecoder,
  input: Uint8Array,
): Either<DecodeError, string> {
  try {
    return right(decoder.decode(input))
  } catch (cause) {
    return left(decodeError('utf-8', cause))
  }
}

function decodeUtf8Chunk(
  decoder: TextDecoder,
  input: Uint8Array,
): Either<DecodeError, string> {
  try {
    return right(decoder.decode(input, STREAM_DECODE_OPTIONS))
  } catch (cause) {
    return left(decodeError('utf-8', cause))
  }
}

function flushUtf8Decoder(decoder: TextDecoder): Either<DecodeError, string> {
  try {
    return right(decoder.decode())
  } catch (cause) {
    return left(decodeError('utf-8', cause))
  }
}

function parseJson(
  input: string,
  format: 'json' | 'ndjson' = 'json',
): Either<ParseError, unknown> {
  try {
    return right(JSON.parse(input) as unknown)
  } catch (cause) {
    return left(parseError(format, cause))
  }
}

function concatBytes(
  parts: readonly Uint8Array[],
  totalBytes?: number,
): Uint8Array {
  if (parts.length === 0) return EMPTY_BYTES
  if (parts.length === 1) return parts[0] as Uint8Array

  const total =
    totalBytes ?? parts.reduce((sum, part) => sum + part.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as Uint8Array
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function immediateBytes(source: ByteSource): Uint8Array | undefined {
  if (source instanceof Uint8Array) return source
  if (source instanceof ArrayBuffer) return new Uint8Array(source)
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  }
  return undefined
}

function byteIterator(
  source: ByteSource,
): Either<StreamError, AsyncIterator<unknown>> {
  if (isResponse(source)) {
    return source.body === null
      ? right(singleChunkIterator(EMPTY_BYTES))
      : right(readableIterator(source.body))
  }

  if (isRequest(source)) {
    return source.body === null
      ? right(singleChunkIterator(EMPTY_BYTES))
      : right(readableIterator(source.body))
  }

  if (isBlob(source)) return right(readableIterator(source.stream()))
  if (isReadableStream(source)) return right(readableIterator(source))
  if (isAsyncIterable(source)) return right(source[Symbol.asyncIterator]())

  return left(invalidChunk(source))
}

function streamIterator(
  source: ReadableStream<unknown> | AsyncIterable<unknown>,
): AsyncIterator<unknown> {
  return isReadableStream(source)
    ? readableIterator(source)
    : source[Symbol.asyncIterator]()
}

function readableIterator<T>(
  stream: ReadableStream<T>,
): ReleasableAsyncIterator<T> {
  const reader = stream.getReader()

  return {
    next: async () => reader.read(),
    return: async () => {
      await reader.cancel()
      reader.releaseLock()
      return { value: undefined, done: true }
    },
    release: () => reader.releaseLock(),
  }
}

async function* singleChunkIterator(
  chunk: Uint8Array,
): AsyncGenerator<Uint8Array, void, unknown> {
  yield chunk
}

function asByteChunk(chunk: unknown): Either<StreamError, Uint8Array> {
  const bytes = asBytes(chunk)
  return bytes === undefined ? left(invalidChunk(chunk)) : right(bytes)
}

function asBytes(value: unknown): Uint8Array | undefined {
  return immediateBytes(value as ByteSource)
}

function isLeftValue(value: unknown): value is Left<unknown> {
  return value instanceof Left
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  )
}

function createStopState(options: StreamOptions): StopState {
  if (options.signal === undefined && options.error === undefined) {
    return { promise: undefined, initial: undefined, cleanup: () => {} }
  }

  if (options.signal?.aborted) {
    const error = aborted(options.signal.reason)
    return {
      promise: Promise.resolve(error),
      initial: error,
      cleanup: () => {},
    }
  }

  const { promise, resolve } = Promise.withResolvers<Aborted | StreamError>()
  const signal = options.signal
  const onAbort = () => resolve(aborted(signal?.reason))

  signal?.addEventListener('abort', onAbort, { once: true })

  options.error?.then(
    (cause) => resolve(streamExternalError(cause)),
    (cause) => resolve(streamExternalError(cause)),
  )

  return {
    promise,
    initial: undefined,
    cleanup: () => signal?.removeEventListener('abort', onAbort),
  }
}

async function nextOrStop<T>(
  iterator: AsyncIterator<T>,
  stop: StopState,
): Promise<RaceResult<IteratorResult<T>>> {
  if (stop.initial !== undefined) return { done: true, error: stop.initial }

  const next = iterator.next()
  if (stop.promise === undefined) {
    return { done: false, result: await next }
  }

  next.catch?.(() => {})

  const result = await Promise.race([next, stop.promise])
  return isStopError(result)
    ? { done: true, error: result }
    : { done: false, result }
}

function isStopError(value: unknown): value is Aborted | StreamError {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly _tag?: unknown })._tag === 'string' &&
    ((value as { readonly _tag: string })._tag === 'Aborted' ||
      (value as { readonly _tag: string })._tag.startsWith('Stream') ||
      (value as { readonly _tag: string })._tag === 'TextTooLarge' ||
      (value as { readonly _tag: string })._tag === 'LineTooLarge' ||
      (value as { readonly _tag: string })._tag === 'InvalidChunk' ||
      (value as { readonly _tag: string })._tag === 'DecodeError' ||
      (value as { readonly _tag: string })._tag === 'ParseError')
  )
}

async function closeIterator<T>(
  iterator: AsyncIterator<T>,
  mode: 'cancel' | 'release',
): Promise<void> {
  if (mode === 'release' && isReadableIterator(iterator)) {
    iterator.release()
    return
  }
  await iterator.return?.()
}

function isReadableIterator<T>(
  iterator: AsyncIterator<T>,
): iterator is AsyncIterator<T> & { release(): void } {
  return (
    typeof (iterator as { readonly release?: unknown }).release === 'function'
  )
}

function stripTrailingCrString(input: string): string {
  return input.endsWith('\r') ? input.slice(0, -1) : input
}

function isResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response
}

function isRequest(value: unknown): value is Request {
  return typeof Request !== 'undefined' && value instanceof Request
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function isReadableStream(value: unknown): value is ReadableStream<unknown> {
  return (
    typeof ReadableStream !== 'undefined' && value instanceof ReadableStream
  )
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { readonly [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === 'function'
  )
}

function streamReadError(cause: unknown): StreamReadError {
  return { _tag: 'StreamReadError', cause }
}

function streamExternalError(cause: unknown): StreamExternalError {
  return { _tag: 'StreamExternalError', cause }
}

function streamConsumerError(cause: unknown): StreamConsumerError {
  return { _tag: 'StreamConsumerError', cause }
}

function streamTooLarge(maxBytes: number, bytesRead: number): StreamTooLarge {
  return { _tag: 'StreamTooLarge', maxBytes, bytesRead }
}

function textTooLarge(maxChars: number, chars: number): TextTooLarge {
  return { _tag: 'TextTooLarge', maxChars, chars }
}

function lineTooLarge(maxBytes: number, bytesRead: number): LineTooLarge {
  return { _tag: 'LineTooLarge', maxBytes, bytesRead }
}

function invalidChunk(chunk: unknown): InvalidChunk {
  return { _tag: 'InvalidChunk', chunk }
}

function decodeError(encoding: string, cause: unknown): DecodeError {
  return { _tag: 'DecodeError', encoding, cause }
}

function parseError(
  format: 'json' | 'ndjson' | 'sse',
  cause: unknown,
): ParseError {
  return { _tag: 'ParseError', format, cause }
}
