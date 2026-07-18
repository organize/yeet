[← README](../README.md) · [Documentation](./README.md)

# Benchmarks

There are Vitest benchmarks in `src/*.bench.ts`, plus a memory benchmark script.

```sh
bun run bench
bun run bench --target node
bun run bench --target bun
bun run bench:quick
bun run bench:quick:node
bun run bench:quick:bun
bun run bench:memory
```

```sh
bun run bench --target node src/overhead.bench.ts
bun run bench --target bun --quick src/stream.bench.ts
```

These benchmarks are intentionally tiny and can be sensitive to runtime noise,
JIT mood, and passing clouds. Treat them as directional, not holy scripture.

The current benchmark suite compares common `either` flows against
`better-result`, includes sync, async, short-circuit, validation, sequential and
scoped concurrent first success, collection, plugin-transformed scenarios, and
stream helpers against vanilla async-iteration code.

Runtime-only `yeet` and `better-result` are close enough that the shape of the
work matters. Yeet currently has a small lead on multi-step synchronous flows
and short-circuits; `better-result` leads on the plain async success path. These
are rough throughput multipliers, with the faster implementation shown in each
row:

| Scenario                      | Result                            |
| ----------------------------- | --------------------------------- |
| Two sync successes            | `yeet` faster by `1.05x`          |
| Sync failure / short-circuit  | `yeet` faster by `1.14x`          |
| Complex checkout success      | `yeet` faster by `1.14x`          |
| Async failure / short-circuit | `yeet` faster by `1.15x`          |
| Async success                 | `better-result` faster by `1.24x` |

Stream helpers have a separate row because they do more than shuttle control
flow. This compares a tiny hand-written parser against yeet's NDJSON helper, and
then against the same yeet code after the build-time transform:

| Scenario              | Manual parser | `yeet` stream | `yeet` stream lowered |
| --------------------- | ------------- | ------------- | --------------------- |
| NDJSON stream success | `1x`          | `0.46x`       | `0.66x`               |

The stream helper still does real parsing, decoding, bounds, cleanup, and
error-shaping work. The transform removes generator consumption overhead; it
does not make a fully-featured stream parser vanish into a hand-rolled loop.

---

[← Documentation](./README.md)
