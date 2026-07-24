[← Nightmares](./nightmares.md) · [Documentation](./README.md)

# Nightmare II: The Connection Has Tenure

A batch processor acquires one connection for its entire scope and lends it to
four bounded workers. One worker detects a live-demo incident while the other
three are still active. Closing the scope must cancel those workers, await
their nested cleanup, and only then release the shared connection.

The release callback poisons the connection. Every worker touches it during
teardown. A worker that sees poison throws this tagged cleanup defect:

```ts
type UsedAfterRelease = {
  readonly _tag: 'UsedAfterRelease'
  readonly worker: number
  readonly phase: 'teardown'
}
```

That turns an ownership-ordering regression into incident data. The primary
`LiveDemoDetected` becomes `Suppressed`, with
`Rejected<UsedAfterRelease>` entries identifying the workers that touched dead
infrastructure.

[Read the executable source.](../examples/nightmare-ii.mts)

## What Must Hold

- all four workers start before the first outcome closes the scope;
- every worker completes nested teardown;
- the shared connection is released exactly once and strictly last;
- correct ordering leaves `LiveDemoDetected` unsuppressed;
- a poisoned control produces ordered `UsedAfterRelease` cleanup defects.

A stopped worker's ordinary domain `Left` is discarded like any other losing
child outcome. Use-after-release is different: it occurs during infrastructure
cleanup, so it is represented as a cleanup rejection and retained beneath the
primary result.

## Ownership Memo

```text
OWNERSHIP MEMO
  result                 : LiveDemoDetected
  children started       : 4
  children torn down     : 4
  connection released    : yes
  release happened last  : yes
  used after release     : none
```

## Acquisition Abort Window

The same program drives a signal-ignorant factory for `N` microtasks while
cancellation is queued at four points around completion:

```text
ACQUISITION ABORT WINDOW
  abort  opened  released  exposed
  N-1    1       1         no
  N      1       1         no
  N+1    1       1         no
  N+2    1       1         no
```

Cancellation is queued first, so a same-microtask tie is adversarial. Each
factory is already in flight and therefore opens one resource. Yeet registers
and releases every opened resource, but none reaches the generator body.

If the operation is queued first, `N+2` can legitimately become the first
exposed row: the generator has won that microtask before cancellation arrives.
Fixing the queue order makes the edge reproducible instead of pretending both
orders mean the same thing.

The same contracts are locked by
[src/resource-order.test.ts](../src/resource-order.test.ts), including a
deliberately poisoned control proving that `UsedAfterRelease` reaches the memo.

## Run It

```sh
node examples/nightmare-ii.mts
bun examples/nightmare-ii.mts
```

Node 26.2.0 and Bun 1.3.14 print the same stable output.

---

[← Nightmares](./nightmares.md)
