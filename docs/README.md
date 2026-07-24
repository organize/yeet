# Documentation

[← README](../README.md)

The README gets yeet onto the road. These guides are what you reach for after
the road develops weather, traffic, several upstream providers, and a database
connection that would very much like to be closed.

| Guide                                                       | Here be                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Cancellation And Structured Concurrency](./concurrency.md) | Cooperative aborts, scoped tasks, first-success hedges, bounded completion streams, and resources |
| [Streams And Bytes](./streams.md)                           | Bounded bodies, text collection, NDJSON, SSE, backpressure, and cancellation                      |
| [Composition Helpers](./composition.md)                     | Capture, concurrent inputs, validation, first success, and result collection                      |
| [Serialization And Schemas](./serialization.md)             | JSON round trips, Standard Schema validation, Exit outcomes, and JSON Schema                      |
| [Build-Time Optimizer](./optimizer.md)                      | Unplugin setup, supported lowering, bailouts, and the disappearing-generator trick                |
| [Nightmares](./nightmares.md)                               | Complex executable scenarios for streams, concurrency, cleanup, ownership, and cancellation       |
| [API Reference](./reference.md)                             | The exported surface, grouped by purpose                                                          |
| [Benchmarks](./benchmarks.md)                               | Commands, methodology, runtime comparisons, and the usual warnings about passing clouds           |

## A Sensible Route

1. Start with the [README quick start](../README.md#quick-start).
2. Read [Cancellation And Structured Concurrency](./concurrency.md) before
   opening resources or spawning sibling work.
3. Add [Streams And Bytes](./streams.md) when bytes begin arriving over the
   horizon.
4. Turn on the [Build-Time Optimizer](./optimizer.md) when the source is settled
   and you would like the generators to quietly leave the runtime.
5. Keep the [API Reference](./reference.md) nearby for names, not philosophy.

Everything here describes the same dependency-free runtime. The docs are larger
than the library. This is considered healthy.
