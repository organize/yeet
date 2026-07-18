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
type CloseMode = 'cancel' | 'release'
type ReturnReason = { value: unknown }
type MapLinesBehavior = { readonly continueOnMappedLeft?: boolean }
type ReleasableAsyncIterator<T> = AsyncIterator<T> & {
  return(reason?: unknown): Promise<IteratorReturnResult<undefined>>
  release(): void
}

const EMPTY_BYTES = new Uint8Array(0)
const RIGHT_VOID = right(undefined) as Right<void>
const DEFAULT_EVENT = 'message'
const STREAM_DECODE_OPTIONS = { stream: true }
const NOOP = (): void => {}
const NO_STOP: StopState = {
  promise: undefined,
  initial: undefined,
  cleanup: NOOP,
}
const STOP_ON_MAPPED_LEFT: MapLinesBehavior = {}
const CONTINUE_ON_MAPPED_LEFT: MapLinesBehavior = {
  continueOnMappedLeft: true,
}

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
  if (iterator instanceof Left) return iterator

  let close: 'cancel' | 'release' = 'release'
  let closeReason: unknown
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          closeReason = cancelReasonFromError(next.error)
          return left(next.error)
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) return right(concatBytes(parts, total))

      const chunk = asBytes(result.value)
      if (chunk === undefined) {
        const error = invalidChunk(result.value)
        close = 'cancel'
        closeReason = error
        return left(error)
      }

      total += chunk.byteLength
      if (options.maxBytes !== undefined && total > options.maxBytes) {
        const error = streamTooLarge(options.maxBytes, total)
        close = 'cancel'
        closeReason = error
        return left(error)
      }
      parts.push(chunk)
    }
  } catch (cause) {
    const error = streamReadError(cause)
    close = 'cancel'
    closeReason = cause
    return left(error)
  } finally {
    stop.cleanup()
    await closeIterator(iterator, close, closeReason)
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

export function chunks(
  source: ByteSource,
  options: ByteOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, Uint8Array>, void, unknown> {
  const returnReason: ReturnReason = { value: undefined }
  return withReturnReason(
    chunksGenerator(source, options, returnReason),
    returnReason,
  )
}

async function* chunksGenerator(
  source: ByteSource,
  options: ByteOptions,
  returnReason: ReturnReason,
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
  if (iterator instanceof Left) {
    yield iterator
    return
  }

  let bytesRead = 0
  let close: CloseMode = 'release'
  let closeReason: unknown
  let completed = false
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          closeReason = cancelReasonFromError(next.error)
          yield left(next.error)
          return
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) {
        completed = true
        return
      }

      const chunk = asByteChunk(result.value)
      if (chunk._tag === 'Left') {
        close = 'cancel'
        closeReason = chunk.error
        yield chunk
        return
      }

      bytesRead += chunk.value.byteLength
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        const error = streamTooLarge(options.maxBytes, bytesRead)
        close = 'cancel'
        closeReason = error
        yield left(error)
        return
      }

      yield chunk
    }
  } catch (cause) {
    const error = streamReadError(cause)
    close = 'cancel'
    closeReason = cause
    yield left(error)
  } finally {
    stop.cleanup()
    if (close === 'release' && !completed) {
      close = 'cancel'
      closeReason = returnReason.value
    }
    await closeIterator(iterator, close, closeReason)
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
  let close: CloseMode = 'release'
  let closeReason: unknown
  const canStop = stop.promise !== undefined

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          closeReason = cancelReasonFromError(next.error)
          return left(next.error)
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) return RIGHT_VOID

      const item = result.value
      if (item instanceof Left) {
        close = 'cancel'
        closeReason = item.error
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
        closeReason = cause
        return left(streamConsumerError(cause))
      }

      if (isLeftValue(step)) {
        close = 'cancel'
        closeReason = step.error
        return step
      }
    }
  } catch (cause) {
    close = 'cancel'
    closeReason = cause
    return left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator, close, closeReason)
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
  let close: CloseMode = 'release'
  let closeReason: unknown
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
          closeReason = cancelReasonFromError(next.error)
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
        closeReason = item.error
        return item as Left<E>
      }

      const chunk = item instanceof Right ? item.value : (item as string)
      chars += chunk.length
      if (maxChars !== undefined && chars > maxChars) {
        const error = textTooLarge(maxChars, chars)
        close = 'cancel'
        closeReason = error
        return left(error)
      }

      if (tee !== undefined) {
        try {
          const result = tee(chunk)
          if (isPromiseLike(result)) await result
        } catch (cause) {
          close = 'cancel'
          closeReason = cause
          return left(streamConsumerError(cause))
        }
      }

      parts.push(chunk)
    }
  } catch (cause) {
    close = 'cancel'
    closeReason = cause
    return left(streamReadError(cause))
  } finally {
    stop.cleanup()
    await closeIterator(iterator, close, closeReason)
  }
}

export function lines(
  source: ByteSource,
  options: LineOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, string>, void, unknown> {
  return mapLines(source, options, rightLine)
}

export function ndjson(
  source: ByteSource,
  options: LineOptions = {},
): AsyncGenerator<Either<Aborted | StreamError, unknown>, void, unknown> {
  return mapLines(
    source,
    options,
    parseNdjsonLine,
    undefined,
    CONTINUE_ON_MAPPED_LEFT,
  )
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

function mapLines<A>(
  source: ByteSource,
  options: LineOptions,
  map: (line: string) => Either<StreamError, A> | undefined,
  finish?: () => Either<StreamError, A> | undefined,
  behavior: MapLinesBehavior = STOP_ON_MAPPED_LEFT,
): AsyncGenerator<Either<Aborted | StreamError, A>, void, unknown> {
  const returnReason: ReturnReason = { value: undefined }
  return withReturnReason(
    mapLinesGenerator(source, options, map, finish, behavior, returnReason),
    returnReason,
  )
}

async function* mapLinesGenerator<A>(
  source: ByteSource,
  options: LineOptions,
  map: (line: string) => Either<StreamError, A> | undefined,
  finish: (() => Either<StreamError, A> | undefined) | undefined,
  behavior: MapLinesBehavior,
  returnReason: ReturnReason,
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
      : singleChunkIterator(immediate)
  if (iterator instanceof Left) {
    yield iterator
    return
  }

  const decoder = createUtf8Decoder(options)
  let carry = ''
  let bytesRead = 0
  let lineBytes = 0
  let close: CloseMode = 'release'
  let closeReason: unknown
  let completed = false
  let yieldedError: unknown
  const canStop = stop.promise !== undefined
  const maxLineBytes = options.maxLineBytes

  try {
    while (true) {
      let result: IteratorResult<unknown>
      if (canStop) {
        const next = await nextOrStop(iterator, stop)
        if (next.done) {
          close = 'cancel'
          closeReason = cancelReasonFromError(next.error)
          yield left(next.error)
          return
        }
        result = next.result
      } else {
        result = await iterator.next()
      }

      if (result.done === true) break

      const chunk = asBytes(result.value)
      if (chunk === undefined) {
        const error = invalidChunk(result.value)
        close = 'cancel'
        closeReason = error
        yield left(error)
        return
      }

      bytesRead += chunk.byteLength
      if (options.maxBytes !== undefined && bytesRead > options.maxBytes) {
        const error = streamTooLarge(options.maxBytes, bytesRead)
        close = 'cancel'
        closeReason = error
        yield left(error)
        return
      }

      if (maxLineBytes !== undefined) {
        let lineStart = 0
        for (let index = 0; index < chunk.byteLength; index++) {
          if (chunk[index] !== 10) continue

          lineBytes += index - lineStart
          if (lineBytes > maxLineBytes) {
            const error = lineTooLarge(maxLineBytes, lineBytes)
            close = 'cancel'
            closeReason = error
            yield left(error)
            return
          }

          lineBytes = 0
          lineStart = index + 1
        }

        lineBytes += chunk.byteLength - lineStart
        if (lineBytes > maxLineBytes) {
          const error = lineTooLarge(maxLineBytes, lineBytes)
          close = 'cancel'
          closeReason = error
          yield left(error)
          return
        }
      }

      const decoded = decodeUtf8Chunk(decoder, chunk)
      if (decoded instanceof Left) {
        close = 'cancel'
        closeReason = decoded.error
        yield decoded
        return
      }

      if (decoded.length === 0) continue

      carry += decoded
      let start = 0
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        const mapped = map(stripTrailingCrString(carry.slice(start, newline)))
        if (mapped !== undefined) {
          if (mapped._tag === 'Left') {
            yieldedError = mapped.error
            if (!behavior.continueOnMappedLeft) {
              close = 'cancel'
              closeReason = mapped.error
            }
          }
          yield mapped
          yieldedError = undefined
          if (mapped._tag === 'Left' && !behavior.continueOnMappedLeft) return
        }

        start = newline + 1
        newline = carry.indexOf('\n', start)
      }

      carry = start === 0 ? carry : carry.slice(start)
    }

    const tail = flushUtf8Decoder(decoder)
    if (tail instanceof Left) {
      close = 'cancel'
      closeReason = tail.error
      yield tail
      return
    }
    if (tail.length > 0) carry += tail

    if (carry.length > 0) {
      const mapped = map(stripTrailingCrString(carry))
      if (mapped !== undefined) {
        if (mapped._tag === 'Left') {
          yieldedError = mapped.error
          if (!behavior.continueOnMappedLeft) {
            close = 'cancel'
            closeReason = mapped.error
          }
        }
        yield mapped
        yieldedError = undefined
        if (mapped._tag === 'Left' && !behavior.continueOnMappedLeft) return
      }
    }

    const final = finish?.()
    if (final !== undefined) {
      if (final._tag === 'Left') {
        yieldedError = final.error
        if (!behavior.continueOnMappedLeft) {
          close = 'cancel'
          closeReason = final.error
        }
      }
      yield final
      yieldedError = undefined
      if (final._tag === 'Left' && !behavior.continueOnMappedLeft) return
    }
    completed = true
  } catch (cause) {
    const error = streamReadError(cause)
    close = 'cancel'
    closeReason = cause
    yield left(error)
  } finally {
    stop.cleanup()
    if (close === 'release' && !completed) {
      close = 'cancel'
      closeReason = yieldedError ?? returnReason.value
    }
    await closeIterator(iterator, close, closeReason)
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
): string | Left<DecodeError> {
  try {
    return decoder.decode(input, STREAM_DECODE_OPTIONS)
  } catch (cause) {
    return left(decodeError('utf-8', cause))
  }
}

function flushUtf8Decoder(decoder: TextDecoder): string | Left<DecodeError> {
  try {
    return decoder.decode()
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

function rightLine(line: string): Right<string> {
  return right(line)
}

function parseNdjsonLine(
  line: string,
): Either<ParseError, unknown> | undefined {
  if (line.length === 0) return undefined

  try {
    return right(JSON.parse(line) as unknown)
  } catch (cause) {
    return left(parseError('ndjson', cause))
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
): Left<StreamError> | AsyncIterator<unknown> {
  if (isResponse(source)) {
    return source.body === null
      ? singleChunkIterator(EMPTY_BYTES)
      : readableIterator(source.body)
  }

  if (isRequest(source)) {
    return source.body === null
      ? singleChunkIterator(EMPTY_BYTES)
      : readableIterator(source.body)
  }

  if (isBlob(source)) return readableIterator(source.stream())
  if (isReadableStream(source)) return readableIterator(source)
  if (isAsyncIterable(source)) return source[Symbol.asyncIterator]()

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
    return: async (reason?: unknown) => {
      try {
        await reader.cancel(reason)
      } catch (cause) {
        let streamError: unknown
        try {
          await reader.closed
        } catch (closedCause) {
          streamError = closedCause
        }

        // An errored stream makes cancel() reject with its stored error. That
        // is the original failure reaching teardown, not a second failure.
        if (cause !== streamError) throw cause
      } finally {
        reader.releaseLock()
      }
      return { value: undefined, done: true }
    },
    release: () => reader.releaseLock(),
  }
}

function withReturnReason<Yield, Return, Next>(
  generator: AsyncGenerator<Yield, Return, Next>,
  returnReason: ReturnReason,
): AsyncGenerator<Yield, Return, Next> {
  // oxlint-disable-next-line typescript/unbound-method
  const originalReturn = generator.return

  generator.return = async (value) => {
    returnReason.value = value
    return await originalReturn.call(generator, value)
  }

  return generator
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
    return NO_STOP
  }

  if (options.signal?.aborted) {
    const error = aborted(options.signal.reason)
    return {
      promise: Promise.resolve(error),
      initial: error,
      cleanup: NOOP,
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

function isStopError<T>(
  value: IteratorResult<T> | Aborted | StreamError,
): value is Aborted | StreamError {
  return !('done' in value)
}

async function closeIterator<T>(
  iterator: AsyncIterator<T>,
  mode: CloseMode,
  reason?: unknown,
): Promise<void> {
  if (mode === 'release' && isReadableIterator(iterator)) {
    iterator.release()
    return
  }
  await iterator.return?.(reason)
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

function cancelReasonFromError(error: Aborted | StreamError): unknown {
  if (error._tag === 'Aborted') return error.reason
  if (error._tag === 'StreamExternalError') return error.cause
  return error
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
