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

## Ownership Memo

```text
OWNERSHIP MEMO
  result                 : LiveDemoDetected
  children started       : 4
  children torn down     : 4
  connection released    : yes
  release happened last  : yes
  used after release     : none

POISONED CONTROL
  poison before shutdown : yes
  result                 : Suppressed
  used after release     : workers 1, 2, 3
```

The second run deliberately poisons the connection before child shutdown. The
same worker checks that report `none` in the healthy run then identify workers
`1`, `2`, and `3`, and their teardown rejections appear beneath
`LiveDemoDetected`. The alarm has heard a fire drill.

## Acquisition Abort Window

The same program drives a signal-ignorant factory for `N` microtasks while
cancellation is queued at four points around completion. It runs the sweep
twice, changing only which countdown enters the microtask queue first:

```text
ACQUISITION ABORT WINDOW

  abort queued first (adversarial)
  abort  opened  released  exposed
  N-1    1       1         no
  N      1       1         no
  N+1    1       1         no
  N+2    1       1         no

  operation queued first
  abort  opened  released  exposed
  N-1    1       1         no
  N      1       1         no
  N+1    1       1         no
  N+2    1       1         yes
```

Cancellation is queued first, so a same-microtask tie is adversarial. Each
factory is already in flight and therefore opens one resource. Yeet registers
and releases every opened resource, but none reaches the generator body.

Queue the operation first and the boundary visibly moves: `N+2` is exposed
before cancellation arrives, then released normally. The paired tables separate
the ownership guarantee from one particular scheduling choice.

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
