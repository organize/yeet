[← README](../README.md) · [Documentation](./README.md)

# Nightmares

Most examples isolate one idea and arrange the furniture so nothing surprising
happens. Nightmares do the opposite. Each is a single executable scenario that
forces several parts of yeet to interact while timing, ownership, malformed
input, and cleanup all become inconvenient at once.

The jokes are scenery. The invariant under pressure is the reason the program
exists.

One rule predicts the failure memos in both programs:

**Losing domain outcomes are noise; cleanup defects are evidence.**

When one child decides the scope, an ordinary `Left` returned later by a stopped
sibling is a losing value, not another failure of the operation. It is
discarded. A teardown rejection is different: that defect happened while the
scope was trying to become safe. Yeet retains it beneath the primary outcome as
`Suppressed`.

| Case                                                    | System under stress                                                                                                           | What must remain true                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [I: Quarterly Synergy Reconciliation](./nightmare-i.md) | A malformed NDJSON expense feed fans into bounded AI and policy work while transactions, SSE streams, and cancellation unwind | One primary domain failure survives; cleanup defects remain attached; unread transport data stays unread; the final outcome survives the wire |
| [II: The Connection Has Tenure](./nightmare-ii.md)      | Four bounded workers share an outer connection while the scope closes and cancellation races resource acquisition             | Every child finishes teardown before the connection is released; resources opened after cancellation are released and never exposed           |

The Roman numerals are catalog numbers. The programs are not chapters, feature
timelines, or increasingly elaborate excuses for the previous program.

## Run Them

```sh
node examples/nightmare-i.mts
node examples/nightmare-ii.mts

bun examples/nightmare-i.mts
bun examples/nightmare-ii.mts
```

Both examples are type-checked with the repository and are intentionally absent
from the published package. The npm tarball has suffered enough.

---

[← Documentation](./README.md)
