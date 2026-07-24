import { afterAll, bench, describe } from 'vitest'

import { type Either } from '../src/either.ts'
import { bytes, collectText, consume, ndjson, sse } from '../src/stream.ts'
import yeet from '../src/unplugin.ts'
import { cleanupBenchFixtures, importBenchFixture } from './bench-fixture.ts'
import { BENCH_OPTS } from './bench-options.ts'

const BENCH_BATCH = readPositiveInt('BENCH_BATCH', 16)
const YEET_SOURCE = new URL('../src/index.ts', import.meta.url).href
const STREAM_SOURCE = new URL('../src/stream.ts', import.meta.url).href
const FIXTURE_ID = 'bench/stream.bench.fixture.js'
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

type PluginBenchModule = {
  jsonDocument: (index: number) => Promise<unknown>
  ndjsonLoop: (index: number) => Promise<unknown>
  sseLoop: (index: number) => Promise<unknown>
}

type RawPlugin = {
  readonly transform?: {
    readonly handler?: (
      code: string,
      id: string,
    ) =>
      | string
      | { readonly code: string }
      | null
      | Promise<
          | string
          | {
              readonly code: string
            }
          | null
        >
  }
}

const PLUGIN_BENCH_SOURCE = `
  import { either } from ${JSON.stringify(YEET_SOURCE)}
  import { json, ndjson, sse } from ${JSON.stringify(STREAM_SOURCE)}

  const encoder = new TextEncoder()
  const JSON_DOCS = [
    encoder.encode(JSON.stringify({ id: 1, title: "one", ok: true })),
    encoder.encode(JSON.stringify({ id: 2, title: "two", ok: true })),
  ]

  const NDJSON_A = chunkText(
    Array.from({ length: 48 }, (_, index) =>
      JSON.stringify({ id: index, token: "tool-" + index })
    ).join("\\n") + "\\n",
    53,
  ).map((chunk) => encoder.encode(chunk))

  const NDJSON_B = chunkText(
    Array.from({ length: 48 }, (_, index) =>
      JSON.stringify({ id: index + 48, token: "tool-" + index })
    ).join("\\n") + "\\n",
    53,
  ).map((chunk) => encoder.encode(chunk))

  const SSE_A = chunkText(sseText(0), 47).map((chunk) => encoder.encode(chunk))
  const SSE_B = chunkText(sseText(48), 47).map((chunk) => encoder.encode(chunk))

  function bit(index) {
    return index & 1
  }

  export async function jsonDocument(index) {
    return either(async function* () {
      const doc = yield* await json(JSON_DOCS[bit(index)])
      return doc.id
    })
  }

  export async function ndjsonLoop(index) {
    const chunks = bit(index) === 0 ? NDJSON_A : NDJSON_B

    return either(async function* () {
      let count = 0
      let sum = 0
      for await (const next of ndjson(asyncValues(chunks))) {
        const event = yield* next
        count++
        sum += event.id
      }
      return { count, sum }
    })
  }

  export async function sseLoop(index) {
    const chunks = bit(index) === 0 ? SSE_A : SSE_B

    return either(async function* () {
      let count = 0
      let chars = 0
      for await (const next of sse(asyncValues(chunks))) {
        const event = yield* next
        count++
        chars += event.data.length
      }
      return { count, chars }
    })
  }

  async function* asyncValues(values) {
    for (let index = 0; index < values.length; index++) yield values[index]
  }

  function sseText(offset) {
    return Array.from({ length: 48 }, (_, index) => {
      const id = index + offset
      return [
        "id: " + id,
        index % 5 === 0 ? "event: tool-call" : "event: text-delta",
        "data: " + JSON.stringify({ index: id, delta: "token-" + id }),
        "",
      ].join("\\n")
    }).join("\\n")
  }

  function chunkText(input, size) {
    const chunks = []
    for (let index = 0; index < input.length; index += size) {
      chunks.push(input.slice(index, index + size))
    }
    return chunks
  }
`

const pluginRuntime = await importPluginBenchModule(PLUGIN_BENCH_SOURCE)
const pluginOptimized = await importPluginBenchModule(
  await transformWithPlugin(PLUGIN_BENCH_SOURCE),
)

afterAll(async () => {
  void benchSink.value
  await cleanupBenchFixtures()
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

benchPluginPair('streams: unplugin', 'json() in either', 'jsonDocument')
benchPluginPair('streams: unplugin', 'ndjson() item loop', 'ndjsonLoop')
benchPluginPair('streams: unplugin', 'sse() item loop', 'sseLoop')

async function consumeBatch(fn: () => Promise<unknown>): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) value = await fn()
  benchSink.value = value
}

async function consumePluginBatch(
  module: PluginBenchModule,
  fn: keyof PluginBenchModule,
  next: () => number,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = await module[fn](next())
  }
  benchSink.value = value
}

function benchPluginPair(
  suite: string,
  name: string,
  fn: keyof PluginBenchModule,
): void {
  describe(suite, () => {
    const runtimeIndex = indexer()
    bench(
      name,
      async () => {
        await consumePluginBatch(pluginRuntime, fn, runtimeIndex)
      },
      BENCH_OPTS,
    )

    const optimizedIndex = indexer()
    bench(
      `${name} (unplugin transformed)`,
      async () => {
        await consumePluginBatch(pluginOptimized, fn, optimizedIndex)
      },
      BENCH_OPTS,
    )
  })
}

function indexer(): () => number {
  let index = 0
  return () => index++
}

async function importPluginBenchModule(
  code: string,
): Promise<PluginBenchModule> {
  return importBenchFixture<PluginBenchModule>(code, 'stream')
}

async function transformWithPlugin(code: string): Promise<string> {
  const plugin = yeet.raw({
    moduleNames: [YEET_SOURCE],
    streamModuleNames: [STREAM_SOURCE],
  }) as RawPlugin
  const handler = plugin.transform?.handler
  if (handler === undefined) {
    throw new TypeError('yeet.raw() did not expose a transform handler')
  }

  const result = await handler(code, FIXTURE_ID)
  if (result === null) {
    throw new Error('yeet unplugin did not transform the stream bench fixture')
  }

  return typeof result === 'string' ? result : result.code
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
