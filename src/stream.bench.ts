import { afterAll, bench, describe } from 'vitest'

import { BENCH_OPTS } from './bench-options.ts'
import { type Either } from './either.ts'
import { bytes, collectText, consume, ndjson, sse } from './stream.ts'

const BENCH_BATCH = readPositiveInt('BENCH_BATCH', 16)
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const benchSink = { value: undefined as unknown }

const TEXT_CHUNKS = Array.from({ length: 64 }, (_, index) => {
  return `delta-${index}: the rain falls softly on typed control flow\n`
})

const BYTE_CHUNKS = TEXT_CHUNKS.map((chunk) => encoder.encode(chunk))
const BYTE_TOTAL = BYTE_CHUNKS.reduce(
  (total, chunk) => total + chunk.byteLength,
  0,
)

const NDJSON_TEXT = `${Array.from({ length: 48 }, (_, index) => {
  return JSON.stringify({
    id: index,
    token: `tool-${index}`,
    ok: index % 3 !== 0,
  })
}).join('\n')}\n`

const NDJSON_CHUNKS = chunkText(NDJSON_TEXT, 53).map((chunk) =>
  encoder.encode(chunk),
)

const SSE_TEXT = Array.from({ length: 48 }, (_, index) => {
  return [
    `id: ${index}`,
    index % 5 === 0 ? 'event: tool-call' : 'event: text-delta',
    `data: ${JSON.stringify({ index, delta: `token-${index}` })}`,
    '',
  ].join('\n')
}).join('\n')

const SSE_CHUNKS = chunkText(SSE_TEXT, 47).map((chunk) => encoder.encode(chunk))

afterAll(() => {
  void benchSink.value
})

describe('streams: bytes', () => {
  bench(
    'vanilla concatenate byte chunks',
    async () => {
      await consumeBatch(vanillaBytes)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet bytes()',
    async () => {
      await consumeBatch(yeetBytes)
    },
    BENCH_OPTS,
  )
})

describe('streams: text deltas', () => {
  bench(
    'vanilla collect text',
    async () => {
      await consumeBatch(vanillaCollectText)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet collectText()',
    async () => {
      await consumeBatch(yeetCollectText)
    },
    BENCH_OPTS,
  )
})

describe('streams: ndjson', () => {
  bench(
    'vanilla parse ndjson',
    async () => {
      await consumeBatch(vanillaNdjson)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet ndjson() + consume()',
    async () => {
      await consumeBatch(yeetNdjson)
    },
    BENCH_OPTS,
  )
})

describe('streams: sse', () => {
  bench(
    'vanilla parse sse',
    async () => {
      await consumeBatch(vanillaSse)
    },
    BENCH_OPTS,
  )

  bench(
    'yeet sse() + consume()',
    async () => {
      await consumeBatch(yeetSse)
    },
    BENCH_OPTS,
  )
})

async function consumeBatch(fn: () => Promise<unknown>): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) value = await fn()
  benchSink.value = value
}

async function vanillaBytes(): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let total = 0

  for await (const chunk of asyncValues(BYTE_CHUNKS)) {
    total += chunk.byteLength
    parts.push(chunk)
  }

  const output = new Uint8Array(total)
  let offset = 0
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index] as Uint8Array
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

async function yeetBytes(): Promise<Uint8Array> {
  return unwrap(await bytes(asyncValues(BYTE_CHUNKS), { maxBytes: BYTE_TOTAL }))
}

async function vanillaCollectText(): Promise<string> {
  const parts: string[] = []
  for await (const chunk of asyncValues(TEXT_CHUNKS)) parts.push(chunk)
  return parts.join('')
}

async function yeetCollectText(): Promise<string> {
  return unwrap(await collectText(asyncValues(TEXT_CHUNKS)))
}

async function vanillaNdjson(): Promise<number> {
  let carry = ''
  let count = 0

  for await (const chunk of asyncValues(NDJSON_CHUNKS)) {
    carry += decoder.decode(chunk)
    let newline = carry.indexOf('\n')
    while (newline !== -1) {
      const line = stripTrailingCr(carry.slice(0, newline))
      carry = carry.slice(newline + 1)
      if (line.length > 0) {
        JSON.parse(line)
        count++
      }
      newline = carry.indexOf('\n')
    }
  }

  if (carry.length > 0) {
    JSON.parse(stripTrailingCr(carry))
    count++
  }

  return count
}

async function yeetNdjson(): Promise<number> {
  let count = 0
  const result = await consume(ndjson(asyncValues(NDJSON_CHUNKS)), {
    each() {
      count++
    },
  })
  unwrap(result)
  return count
}

async function vanillaSse(): Promise<number> {
  const events = await parseSseLines(await vanillaLines(SSE_CHUNKS))
  return events
}

async function yeetSse(): Promise<number> {
  let count = 0
  const result = await consume(sse(asyncValues(SSE_CHUNKS)), {
    each() {
      count++
    },
  })
  unwrap(result)
  return count
}

async function vanillaLines(chunks: readonly Uint8Array[]): Promise<string[]> {
  let carry = ''
  const lines: string[] = []

  for await (const chunk of asyncValues(chunks)) {
    carry += decoder.decode(chunk)
    let newline = carry.indexOf('\n')
    while (newline !== -1) {
      lines.push(stripTrailingCr(carry.slice(0, newline)))
      carry = carry.slice(newline + 1)
      newline = carry.indexOf('\n')
    }
  }

  if (carry.length > 0) lines.push(stripTrailingCr(carry))
  return lines
}

async function parseSseLines(lines: readonly string[]): Promise<number> {
  let event = 'message'
  let data: string[] = []
  let count = 0

  for (const line of lines) {
    if (line.length === 0) {
      if (data.length > 0 || event !== 'message') count++
      event = 'message'
      data = []
      continue
    }

    if (line[0] === ':') continue

    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const rawValue = separator === -1 ? '' : line.slice(separator + 1)
    const value = rawValue[0] === ' ' ? rawValue.slice(1) : rawValue

    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }

  if (data.length > 0 || event !== 'message') count++
  return count
}

async function* asyncValues<T>(
  values: readonly T[],
): AsyncGenerator<T, void, unknown> {
  for (let index = 0; index < values.length; index++) {
    yield values[index] as T
  }
}

function unwrap<E, A>(result: Either<E, A>): A {
  if (result._tag === 'Right') return result.value
  throw new Error(`Unexpected Left: ${String(result.error)}`)
}

function stripTrailingCr(input: string): string {
  return input.endsWith('\r') ? input.slice(0, -1) : input
}

function chunkText(input: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size))
  }
  return chunks
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
