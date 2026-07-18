[← README](../README.md) · [Documentation](./README.md)

# Build-Time Optimizer

Yeet ships an optional unplugin optimizer. Your source stays the same; the
plugin looks for inline generator calls to `either`, `validate`, `firstOf`, and
`collect` that it can prove, then lowers them into plain early-return or
accumulator JavaScript. It also fuses yeet's own constructors and guards when
they are consumed immediately, removing intermediate `Either` values as well
as the generator. `raise.capture(...)` is understood as a local outcome
boundary in lowered generators. If the plugin cannot prove the shape, it leaves
the original runtime call exactly where it found it.

No spooky action at a distance. Just a little stagehand moving furniture before
the curtain rises.

```ts
// vite.config.ts
import yeet from '@big-time/yeet/unplugin/vite'

export default {
  plugins: [yeet()],
}
```

Adapter subpaths are available for Vite, Rollup, Webpack, Rspack, esbuild, and
Bun:

| Tool    | Import                            |
| ------- | --------------------------------- |
| Vite    | `@big-time/yeet/unplugin/vite`    |
| Rollup  | `@big-time/yeet/unplugin/rollup`  |
| Webpack | `@big-time/yeet/unplugin/webpack` |
| Rspack  | `@big-time/yeet/unplugin/rspack`  |
| esbuild | `@big-time/yeet/unplugin/esbuild` |
| Bun     | `@big-time/yeet/unplugin/bun`     |

The optimizer is binding-scoped, so aliased imports work while shadowed locals
are politely ignored:

```ts
import { either as e, right } from '@big-time/yeet'

const result = e(function* () {
  return yield* right(42)
})

// inferred: Either<never, number>
```

The optimizer understands a few yeet primitives deeply enough to erase the
whole produce-then-consume boundary:

```ts
import { either, ensure, ensureNotNull, type Either } from '@big-time/yeet'

const result = either(function* ({ raise }) {
  const id = yield* ensureNotNull(input.id, () => 'MissingId' as const)
  yield* ensure(id.length > 0, () => 'EmptyId' as const)
  const cached = raise.capture(readCache(id))
  return { id, cached }
})
// inferred:
// Either<
//   "MissingId" | "EmptyId",
//   { id: string; cached: Either<CacheError, Cached> }
// >
```

Conceptually, that becomes:

```ts
import { left, right } from '@big-time/yeet'

const lowered = (() => {
  const id = input.id
  if (id == null) return left('MissingId' as const)
  if (!(id.length > 0)) return left('EmptyId' as const)
  const cached = readCache(id)
  return right({ id, cached })
})()
// inferred:
// Either<
//   "MissingId" | "EmptyId",
//   { id: string; cached: Either<CacheError, Cached> }
// >
```

The actual lowering preserves JavaScript evaluation order and lazy error
construction, including evaluating a guard's callback expression on success but
only calling it on failure. Tiny details, yes. Tiny details are where compilers
hide the knives.

It lowers these proven shapes:

- direct `yield* someEither()` steps in `either`
- immutable `const` aliases initialized from a proven Either-producing call
- direct `yield* right(...)`, `yield* left(...)`, `yield* ensure(...)`, and
  `yield* ensureNotNull(...)` steps, with unnecessary intermediate `Either`
  values fused away
- local `raise.capture(...)` outcome boundaries through either `raise` or
  `{ raise }` callback parameters
- direct `yield* await somePromiseReturningEither()` steps in async `either`,
  including bounded stream helpers like `json(body)` and `collectText(stream)`
- direct `yield* next` steps where `next` is a `const` binding from
  `for await (const next of ndjson(...) | sse(...) | lines(...) | chunks(...))`
- callable `raise` parameters written as either `raise` or `{ raise }`, including
  aliases such as `{ raise: fail }`, when no scoped signal is requested
- statically primitive final returns without a redundant structural `Left` check
- direct `yield* check(someEither())` steps in `validate`
- direct `yield someEither` attempts in `firstOf` and `collect`

On a local Node 26.2.0 `bun run bench:quick:node` run, the transform shook out
roughly like this. The exact numbers will drift with hardware, runtime, warmup,
and the JIT's morning mood, but the shape is the useful part:

| Shape                                           | Rough win   |
| ----------------------------------------------- | ----------- |
| `either`: single sync `yield*` success          | `~11x`      |
| `either`: two sync `yield*` successes           | `~19x`      |
| `either`: sync `Left` short-circuit             | `~19x`      |
| `either`: two async `yield* await` successes    | `~6.5x`     |
| `either`: async `Left` short-circuit            | `~9.7x`     |
| `validate`: two checks                          | `~9-10x`    |
| `firstOf`: three attempts                       | `~8-17x`    |
| Fused guards: success                           | `~19x`      |
| Fused guards: `Left`                            | `~5.8x`     |
| `raise.capture`: cached `Right`                 | `~34x`      |
| `raise.capture`: `Left` then fallback           | `~17x`      |
| Stream: `yield* await json(body)`               | `~2.4x`     |
| Stream: `yield* next` in `ndjson` / `sse` loops | `~1.3-1.4x` |
| `collect`: many yielded items                   | `~1.0-1.1x` |

Tiny flows win hardest because the generator driver is most of the work. Once
you are parsing JSON, walking many items, or calling real I/O, the plugin still
removes the do-notation overhead, but the river is wider than the boat.

The fusion rows compare the same guard and cache-fallback source through runtime
`either` and through the real unplugin on a quick Node 26 run. They include both
generator erasure and intrinsic fusion; they are end-to-end numbers, not an
attempt to make one compiler pass look taller in the mirror.

It bails on the abortable overload, escaped `raise` / `check`, `this`,
`arguments`, mutable or unproven indirect `yield*` values, scoped context
destructuring, non-`const` stream item bindings, stream helpers from other
modules, and expression positions where hoisting would change evaluation. The
runtime library remains the interpreter underneath, as dependable as a man in
a dark suit explaining how rain becomes a river.

---

[← Documentation](./README.md)
