import { describe, expect, it } from 'vitest'

import { transformYeet } from './transform.ts'

const YEET_SOURCE = new URL('../index.ts', import.meta.url).href
const STREAM_SOURCE = new URL('../stream.ts', import.meta.url).href

type RunnableModule = {
  run: (...args: unknown[]) => unknown
}

function moduleUrl(code: string): string {
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

async function importCode(code: string): Promise<RunnableModule> {
  return (await import(moduleUrl(code))) as RunnableModule
}

async function runBoth(
  body: string,
  args: unknown[] = [],
): Promise<{
  runtime: unknown
  optimized: unknown
  code: string
}> {
  const source = `
    import {
      either,
      validate,
      collect,
      firstOf,
      left,
      right,
    } from ${JSON.stringify(YEET_SOURCE)}

    ${body}
  `
  const transformed = transformYeet(source, 'fixture.ts', {
    moduleNames: [YEET_SOURCE],
    streamModuleNames: [STREAM_SOURCE],
  })

  expect(transformed).not.toBeNull()
  if (transformed === null) throw new Error('Expected transform to optimize')

  const runtimeModule = await importCode(source)
  const optimizedModule = await importCode(transformed.code)

  return {
    runtime: await runtimeModule.run(...args),
    optimized: await optimizedModule.run(...args),
    code: transformed.code,
  }
}

function simplifyEither(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value

  if (Array.isArray(value)) return value.map(simplifyEither)

  if (!('_tag' in value)) return value
  const either = value as {
    readonly _tag: unknown
    readonly value?: unknown
    readonly error?: unknown
  }

  if (either._tag === 'Right') {
    return { _tag: 'Right', value: simplify(either.value) }
  }

  if (either._tag !== 'Left') return value
  const error = either.error
  if (
    error !== null &&
    typeof error === 'object' &&
    '_tag' in error &&
    error._tag === 'Rejected'
  ) {
    const cause = (error as { readonly cause?: unknown }).cause
    return {
      _tag: 'Left',
      error: {
        _tag: 'Rejected',
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }
  }

  return { _tag: 'Left', error: simplify(error) }
}

function simplify(value: unknown): unknown {
  const either = simplifyEither(value)
  if (either === null || typeof either !== 'object') return either
  if (Array.isArray(either)) return either.map(simplify)
  if ('_tag' in either) return either

  return Object.fromEntries(
    Object.entries(either).map(([key, item]) => [key, simplify(item)]),
  )
}

describe('yeet unplugin transform', () => {
  it('lowers an inline generator imported through the yeet binding', () => {
    const source = `
      import { either as e, right } from '@big-time/yeet'

      export const result = e(function* () {
        const value = yield* right(41)
        return value + 1
      })
    `

    const transformed = transformYeet(source, 'fixture.ts')

    expect(transformed?.optimized).toBe(1)
    expect(transformed?.code.replaceAll('@big-time/yeet', '<yeet>'))
      .toMatchInlineSnapshot(`
      "import { right as _yeetRight } from "<yeet>";
      import { either as e, right } from '<yeet>';
      export const result = (() => {
        const _yeet = right(41);
        if (_yeet._tag === "Left") return _yeet;
        const value = _yeet.value;
        const _yeetReturn = value + 1;
        return _yeetReturn !== null && typeof _yeetReturn === "object" && _yeetReturn._tag === "Left" ? _yeetReturn : _yeetRight(_yeetReturn);
        return _yeetRight(undefined);
      })();"
    `)
  })

  it('leaves unrelated or shadowed either calls alone', () => {
    expect(
      transformYeet(
        `
          import { either } from 'not-yeet'
          either(function* () {})
        `,
        'fixture.ts',
      ),
    ).toBeNull()

    expect(
      transformYeet(
        `
          import { either as yeetEither } from '@big-time/yeet'
          export function run(either) {
            return either(function* () {})
          }
        `,
        'fixture.ts',
      ),
    ).toBeNull()
  })

  it('bails on shapes that would make the optimization load-bearing', () => {
    const cases = [
      `
        import { either, right } from '@big-time/yeet'
        either(new AbortController().signal, async function* () {
          yield* await Promise.resolve(right(1))
        })
      `,
      `
        import { either } from '@big-time/yeet'
        either(function* (raise) {
          const escaped = raise
          return escaped
        })
      `,
      `
        import { either, right } from '@big-time/yeet'
        either(function* () {
          return true && (yield* right(1))
        })
      `,
      `
        import { either, right } from '@big-time/yeet'
        either(function* () {
          return f(before(), yield* right(1), after())
        })
      `,
      `
        import { either, right } from '@big-time/yeet'
        either(function* (raise, signal) {
          const value = yield* right(signal)
          return value
        })
      `,
      `
        import { either, right } from '@big-time/yeet'
        either(function* () {
          while (yield* right(false)) {}
        })
      `,
      `
        import { either, right } from '@big-time/yeet'
        const value = right(1)
        either(function* () {
          return yield* value
        })
      `,
      `
        import { either } from '@big-time/yeet'
        import { ndjson } from 'not-yeet-stream'
        either(async function* () {
          for await (const next of ndjson()) {
            const value = yield* next
            return value
          }
        })
      `,
      `
        import { validate, right } from '@big-time/yeet'
        validate(function* (check) {
          const escaped = check
          return escaped(right(1))
        })
      `,
    ]

    for (const source of cases) {
      expect(transformYeet(source, 'fixture.ts')).toBeNull()
    }
  })

  it('matches runtime behavior for sync success, Left, and return raise()', async () => {
    const body = `
      function getUser(id) {
        if (id === '1') return right({ id, active: true })
        if (id === 'inactive') return right({ id, active: false })
        return left('MissingUser')
      }

      function getOrders(id) {
        return right(['order-for-' + id])
      }

      export function run(id) {
        return either(function* (raise) {
          const user = yield* getUser(id)
          if (!user.active) return raise('Inactive')
          const orders = yield* getOrders(user.id)
          return { user, orders }
        })
      }
    `

    const success = await runBoth(body, ['1'])
    expect(simplify(success.optimized)).toEqual(simplify(success.runtime))

    const missing = await runBoth(body, ['nope'])
    expect(simplify(missing.optimized)).toEqual(simplify(missing.runtime))

    const raised = await runBoth(body, ['inactive'])
    expect(simplify(raised.optimized)).toEqual(simplify(raised.runtime))
  })

  it('matches runtime behavior when finally and using unwind on Left', async () => {
    const body = `
      function fail() {
        return left('Nope')
      }

      export function run() {
        const events = []
        const result = either(function* () {
          try {
            using _ = {
              [Symbol.dispose]() {
                events.push('dispose')
              },
            }

            const value = yield* fail()
            return value
          } finally {
            events.push('finally')
          }
        })

        return { result, events }
      }
    `

    const { runtime, optimized } = await runBoth(body)

    expect(simplify(optimized)).toEqual(simplify(runtime))
    expect(simplify(optimized)).toEqual({
      result: { _tag: 'Left', error: 'Nope' },
      events: ['dispose', 'finally'],
    })
  })

  it('matches runtime behavior for async yield* await and raise(fn)', async () => {
    const body = `
      async function getUser(id) {
        await Promise.resolve()
        return id === '1' ? right({ id }) : left('MissingUser')
      }

      export async function run(id) {
        return either(async function* (raise) {
          const user = yield* await getUser(id)
          const risky = yield* await raise(() => {
            if (id === 'boom') throw new Error('boom')
            return 'ok'
          })
          return { user, risky }
        })
      }
    `

    const success = await runBoth(body, ['1'])
    expect(simplifyEither(success.optimized)).toEqual(
      simplifyEither(success.runtime),
    )

    const missing = await runBoth(body, ['missing'])
    expect(simplifyEither(missing.optimized)).toEqual(
      simplifyEither(missing.runtime),
    )

    const thrown = await runBoth(body, ['boom'])
    expect(simplifyEither(thrown.optimized)).toEqual(
      simplifyEither(thrown.runtime),
    )
  })

  it('lowers async either bodies that consume bounded stream helpers', async () => {
    const body = `
      import { json } from ${JSON.stringify(STREAM_SOURCE)}

      export async function run() {
        return either(async function* () {
          const payload = yield* await json(
            new TextEncoder().encode('{"ok":true}')
          )
          return payload
        })
      }
    `

    const { runtime, optimized, code } = await runBoth(body)

    expect(simplifyEither(optimized)).toEqual(simplifyEither(runtime))
    expect(code).toContain('await json')
    expect(code).toContain('_tag === "Left"')
    expect(code).not.toContain('function*')
  })

  it('lowers structured stream item loops from yeet stream helpers', async () => {
    const body = `
      import { ndjson } from ${JSON.stringify(STREAM_SOURCE)}

      export async function run(bad) {
        const source = bad ? '{"id":' : '{"id":1}\\n{"id":2}\\n'

        return either(async function* () {
          const ids = []
          for await (const next of ndjson(new TextEncoder().encode(source))) {
            const event = yield* next
            ids.push(event.id)
          }
          return ids
        })
      }
    `

    const success = await runBoth(body, [false])
    expect(simplifyEither(success.optimized)).toEqual(
      simplifyEither(success.runtime),
    )
    expect(simplifyEither(success.optimized)).toEqual({
      _tag: 'Right',
      value: [1, 2],
    })
    expect(success.code).toContain('for await')
    expect(success.code).toContain('_tag === "Left"')
    expect(success.code).not.toContain('yield* next')
    expect(success.code).not.toContain('function*')

    const failure = await runBoth(body, [true])
    expect(simplifyEither(failure.runtime)).toMatchObject({
      _tag: 'Left',
      error: { _tag: 'ParseError', format: 'ndjson' },
    })
    expect(simplifyEither(failure.optimized)).toMatchObject({
      _tag: 'Left',
      error: { _tag: 'ParseError', format: 'ndjson' },
    })
  })

  it('matches runtime behavior for async promise rejection capture', async () => {
    const body = `
      export async function run() {
        return either(async function* (raise) {
          const value = yield* await raise(Promise.reject(new Error('rejected')))
          return value
        })
      }
    `

    const { runtime, optimized } = await runBoth(body)

    expect(simplifyEither(optimized)).toEqual(simplifyEither(runtime))
  })

  it('matches runtime behavior for validate accumulation', async () => {
    const body = `
      function validateName(name) {
        return name.length > 0 ? right(name) : left('EmptyName')
      }

      function validateAge(age) {
        return age >= 0 ? right(age) : left('TooYoung')
      }

      export function run(input) {
        const events = []
        const result = validate(function* (check) {
          const name = yield* check(validateName(input.name))
          const age = yield* check(validateAge(input.age))
          events.push('after:' + name + ':' + age)
          return { name, age }
        })

        return { result, events }
      }
    `

    const valid = await runBoth(body, [{ name: 'Axel', age: 42 }])
    expect(simplify(valid.optimized)).toEqual(simplify(valid.runtime))

    const invalid = await runBoth(body, [{ name: '', age: -1 }])
    expect(simplify(invalid.optimized)).toEqual(simplify(invalid.runtime))
    expect(simplify(invalid.optimized)).toEqual({
      result: { _tag: 'Left', error: ['EmptyName', 'TooYoung'] },
      events: ['after:undefined:undefined'],
    })
  })

  it('preserves validate return-expression effects when errors exist', async () => {
    const body = `
      export function run() {
        const events = []
        const result = validate(function* (check) {
          yield* check(left('Bad'))
          return events.push('return evaluated')
        })

        return { result, events }
      }
    `

    const { runtime, optimized } = await runBoth(body)

    expect(simplify(optimized)).toEqual(simplify(runtime))
    expect(simplify(optimized)).toEqual({
      result: { _tag: 'Left', error: ['Bad'] },
      events: ['return evaluated'],
    })
  })

  it('matches runtime behavior for raw Left returns from accumulator combinators', async () => {
    const body = `
      export function run() {
        const validation = validate(function* () {
          return left('ReturnedLeft')
        })

        const first = firstOf(function* () {
          return left('ReturnedLeft')
        })

        return { validation, first }
      }
    `

    const { runtime, optimized } = await runBoth(body)

    expect(simplify(optimized)).toEqual(simplify(runtime))
    expect(simplify(optimized)).toEqual({
      validation: {
        _tag: 'Right',
        value: { _tag: 'Left', error: 'ReturnedLeft' },
      },
      first: {
        _tag: 'Right',
        value: { _tag: 'Left', error: 'ReturnedLeft' },
      },
    })
  })

  it('matches runtime behavior for collect partitioning', async () => {
    const body = `
      function parseItem(item) {
        return item.ok ? right(item.value) : left(item.error)
      }

      export function run(items) {
        const events = []
        const result = collect(function* () {
          for (const item of items) {
            yield parseItem(item)
          }

          return events.push('return evaluated')
        })

        return { result, events }
      }
    `

    const { runtime, optimized } = await runBoth(body, [
      [
        { ok: true, value: 1 },
        { ok: false, error: 'Nope' },
        { ok: true, value: 2 },
      ],
    ])

    expect(simplify(optimized)).toEqual(simplify(runtime))
    expect(simplify(optimized)).toEqual({
      result: { errors: ['Nope'], values: [1, 2] },
      events: ['return evaluated'],
    })
  })

  it('matches runtime behavior for yielded variables in collect and firstOf', async () => {
    const body = `
      export function run() {
        const attempts = [left('cache'), left('db'), right('api')]
        const collected = collect(function* () {
          for (const attempt of attempts) {
            yield attempt
          }
        })

        const first = firstOf(function* () {
          for (const attempt of attempts) {
            yield attempt
          }
        })

        return { collected, first }
      }
    `

    const { runtime, optimized } = await runBoth(body)

    expect(simplify(optimized)).toEqual(simplify(runtime))
    expect(simplify(optimized)).toEqual({
      collected: { errors: ['cache', 'db'], values: ['api'] },
      first: { _tag: 'Right', value: 'api' },
    })
  })

  it('matches runtime behavior for firstOf success and all-failed paths', async () => {
    const body = `
      function attempt(label, ok, events) {
        events.push('attempt:' + label)
        return ok ? right(label) : left(label + ':failed')
      }

      export function run(dbWorks) {
        const events = []
        const result = firstOf(function* () {
          yield attempt('cache', false, events)

          try {
            yield attempt('db', dbWorks, events)
          } finally {
            events.push('finally')
          }

          return events.push('return evaluated')
        })

        return { result, events }
      }
    `

    const success = await runBoth(body, [true])
    expect(simplify(success.optimized)).toEqual(simplify(success.runtime))
    expect(simplify(success.optimized)).toEqual({
      result: { _tag: 'Right', value: 'db' },
      events: ['attempt:cache', 'attempt:db', 'finally'],
    })

    const failed = await runBoth(body, [false])
    expect(simplify(failed.optimized)).toEqual(simplify(failed.runtime))
    expect(simplify(failed.optimized)).toEqual({
      result: {
        _tag: 'Left',
        error: ['cache:failed', 'db:failed'],
      },
      events: ['attempt:cache', 'attempt:db', 'finally', 'return evaluated'],
    })
  })
})
