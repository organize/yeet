[← Nightmares](./nightmares.md) · [Documentation](./README.md)

# Nightmare I: Quarterly Synergy Reconciliation

Finance delivers a chunked NDJSON feed containing valid expenses, malformed
JSON, a live production demo, forty unread backlog rows, and eight GPUs
classified as ergonomic stationery.

Each decoded row enters a bounded `forkEach` pool. A worker opens a transaction
and model socket, captures a cache lookup, hedges AI providers with `forkFirst`,
races policy systems with `forkRace`, checks a ledger through `forkAll`, and
parses an SSE rationale. One business failure stops the batch while another
worker's rollback throws during cancellation.

The scenario asks whether all of that can still settle as one truthful value.

[Read the executable source.](../examples/nightmare-i.mts)

## What Must Hold

- malformed NDJSON is recoverable per item and does not kill the feed;
- `forkEach` never pulls the forty backlog rows once the batch stops;
- the live-demo domain failure remains primary;
- the GPU rollback defect is retained beneath it as `Suppressed`;
- stopped siblings do not pollute the memo with ordinary losing `Left` values;
- the underlying Web Stream receives `ForkEachStopped`;
- the complete `Exit` survives JSON serialization and Standard Schema
  rehydration.

## Stable Tail

The timestamped audit table is intentionally noisy. The stable tail is the
proof:

```text
TRANSPORT ENVELOPE
{"_tag":"Left","error":{"_tag":"Suppressed","error":{"_tag":"LiveDemoDetected","claim":"demo","action":"cancel everything including the meeting","rationale":["consulted Anthropic","converted 0 cents into strategic confidence"]},"suppressed":[{"_tag":"Rejected","cause":{"_tag":"RollbackFailed","claim":"gpu","detail":"the transaction achieved tenure"}}]}}

POST-MORTEM
  approved before impact : 1
  malformed but tolerated: 1
  source pulls            : 58
  source bytes served     : 706 / 6345
  full-drain pulls        : 513
  source cancelled        : true
  source cancel reason    : ForkEachStopped
  final result             : Suppressed
  wire rehydrated          : yes
  GPU rollback threw      : yes
  GPU rollback in memo    : yes

At no point was this architecture approved by finance. This is why it passed finance.
```

The feed serves 706 of 6,345 bytes in 58 pulls. A full drain would require 513
pulls. That difference is bounded demand reaching through `forkEach`, `ndjson`,
and the Web Stream to the byte source.

`LiveDemoDetected` remains the headline. `RollbackFailed` is new information
produced during teardown, so it remains attached. The stopped GPU and late
workers also return domain `Left`s, but those are losing child outcomes rather
than additional failures of the batch and are discarded.

## Run It

```sh
node examples/nightmare-i.mts
bun examples/nightmare-i.mts
```

The stable tail is identical on Node 26.2.0 and Bun 1.3.14. The audit timestamps
are permitted to experience time.

---

[← Nightmares](./nightmares.md)
