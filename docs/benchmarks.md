[← README](../README.md) · [Documentation](./README.md)

# Benchmarks

The README carries the map. This page carries the weather station.

The overhead suite runs equivalent fixtures as plain JavaScript with
`try`/`throw`/`catch`, with the installed `better-result`, through yeet's normal
generator runtime, and through source transformed by yeet's unplugin. Stream
rows compare a small manual NDJSON parser with yeet's full stream helper before
and after lowering.

## Reproduce It

```sh
bun run bench --target node bench/overhead.bench.ts
bun run bench --target bun bench/overhead.bench.ts
```

For the rest of the suites:

```sh
bun run bench
bun run bench --target node
bun run bench --target bun
bun run bench:quick
bun run bench:memory
```

The benchmark runner writes raw Vitest output to `bench-results.<target>.json`
and a smaller table to `bench-results.<target>.csv`.

## Raw Throughput

These results were captured from the same checkout with Node 26.2.0 and Bun
1.3.14. Values are operations per second, rounded to keep the table readable.

### Node 26.2.0

| Scenario         | Vanilla | `better-result` | `yeet` runtime | `yeet` lowered |
| ---------------- | ------: | --------------: | -------------: | -------------: |
| Sync single      | 487,106 |          37,208 |         37,292 |        244,656 |
| Sync two         | 370,929 |          34,570 |         34,409 |        178,455 |
| Sync failure     |  12,071 |          30,529 |         31,486 |        266,238 |
| Async two        | 153,240 |          16,724 |         13,289 |         98,892 |
| Complex checkout | 187,997 |          15,541 |         18,013 |         72,564 |

### Bun 1.3.14

| Scenario         | Vanilla | `better-result` | `yeet` runtime | `yeet` lowered |
| ---------------- | ------: | --------------: | -------------: | -------------: |
| Sync single      | 465,889 |          65,739 |         53,347 |        285,042 |
| Sync two         | 283,709 |          55,031 |         60,712 |        216,631 |
| Sync failure     |  28,704 |          53,057 |         67,102 |        468,513 |
| Async two        | 109,974 |          14,871 |         14,466 |         79,186 |
| Complex checkout | 125,122 |          18,459 |         23,213 |         94,459 |

## What The Transform Buys

Across these flows, lowering is approximately:

| Shape               |                Node |                 Bun |
| ------------------- | ------------------: | ------------------: |
| Sync single success | `6.6x` runtime yeet | `5.3x` runtime yeet |
| Sync two successes  | `5.2x` runtime yeet | `3.6x` runtime yeet |
| Sync failure        | `8.5x` runtime yeet | `7.0x` runtime yeet |
| Async two successes | `7.4x` runtime yeet | `5.5x` runtime yeet |
| Complex checkout    | `4.0x` runtime yeet | `4.1x` runtime yeet |

Vanilla remains the ceiling on these tiny success fixtures. Lowered yeet reaches
roughly `39-65%` of vanilla throughput on Node and `61-76%` on Bun while keeping
typed, data-shaped failure. On the failure fixture, exceptions pay for stack
unwinding and lowered yeet runs `22x` faster on Node and `16x` faster on Bun.

## Streams

| Runtime     | Manual parser | `yeet` stream | `yeet` stream lowered |
| ----------- | ------------: | ------------: | --------------------: |
| Node 26.2.0 |         1,503 |           725 |                   966 |
| Bun 1.3.14  |         1,794 |           941 |                 1,205 |

The hand-written parser has a smaller job. Yeet's NDJSON helper also performs
UTF-8 decoding, bounds checks, typed error shaping, cancellation, backpressure,
and deterministic source cleanup. Lowering removes the generator-consumption
overhead; it does not make that work disappear.

## Read With Appropriate Suspicion

These are microbenchmarks. Runtime version, CPU state, warmup, garbage
collection, and an ill-timed scheduler pause can move them around. Compare
shapes and orders of magnitude, inspect RME in the JSON report, and rerun the
suite on the machine that matters to you.

The transform is always optional. Unsupported syntax bails out to the runtime,
so a missing optimization is a performance result, not a semantic change.

---

[← Documentation](./README.md)
