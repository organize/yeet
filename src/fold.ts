/**
 * The value returned by {@link Strategy.step} on each iteration.
 *
 * - `done: true`: short-circuit immediately with `result`.
 * - `done: false`: continue; `send` is passed back into the generator and
 *   `acc` replaces the current accumulator.
 *
 * @typeParam Acc - The accumulator type.
 * @typeParam R - The final result type.
 */
export type Step<Acc, R> =
  | { done: true; result: R }
  | { done: false; send: unknown; acc: Acc }

/**
 * Describes how {@link fold} / {@link foldAsync} should interpret each yielded
 * value and assemble the final result.
 *
 * @typeParam Eff - The type of values yielded by the generator.
 * @typeParam Ret - The return type of the generator.
 * @typeParam Acc - The accumulator type threaded through each step.
 * @typeParam R - The final result type produced by the fold.
 */
export type Strategy<Eff, Ret, Acc, R> = {
  /**
   * Factory called once per {@link fold} / {@link foldAsync} invocation to
   * produce a fresh accumulator. Using a factory (rather than a plain value)
   * allows strategy objects to be module-level singletons with no per-call
   * allocation.
   */
  init: () => Acc
  /**
   * Called for each yielded effect. Return `{ done: true }` to short-circuit,
   * or `{ done: false }` to continue with an updated accumulator and a value
   * to send back into the generator.
   */
  step: (eff: Eff, acc: Acc) => Step<Acc, R>
  /**
   * Called once the generator returns. Transforms the final return value and
   * accumulated state into the result type `R`.
   */
  finish: (ret: Ret, acc: Acc) => R
}

/**
 * Drives a synchronous generator to completion using the provided
 * {@link Strategy}, threading an accumulator through each yielded value.
 *
 * @param fn - Factory that produces the generator to fold over.
 * @param strategy - Describes how to handle each effect and assemble the result.
 * @returns The value produced by the strategy.
 */
export function fold<Eff, Ret, Acc, R>(
  fn: () => Generator<Eff, Ret, unknown>,
  strategy: Strategy<Eff, Ret, Acc, R>,
): R {
  const gen = fn()
  let acc = strategy.init()
  let next = gen.next()

  while (!next.done) {
    const result = strategy.step(next.value, acc)
    if (result.done) return result.result
    acc = result.acc
    next = gen.next(result.send)
  }

  return strategy.finish(next.value, acc)
}

/**
 * Async equivalent of {@link fold}. Drives an `AsyncGenerator` to completion
 * using the provided {@link Strategy}.
 *
 * @param gen - The async generator to fold over.
 * @param strategy - Describes how to handle each effect and assemble the result.
 * @returns A promise that resolves to the value produced by the strategy.
 */
export async function foldAsync<Eff, Ret, Acc, R>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  strategy: Strategy<Eff, Ret, Acc, R>,
): Promise<R> {
  let acc = strategy.init()
  let next = await gen.next()

  while (!next.done) {
    const result = strategy.step(next.value, acc)
    if (result.done) return result.result
    acc = result.acc
    next = await gen.next(result.send)
  }

  return strategy.finish(next.value, acc)
}
