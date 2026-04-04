type Either<E, A> = Left<E> | Right<A>

abstract class EitherBase<E, A> {
  abstract readonly _tag: "Left" | "Right"

  get [Symbol.toStringTag]() {
    return `Either.${this._tag}`
  }
}

class Left<E> extends EitherBase<E, never> {
  readonly _tag = "Left" as const
  constructor(readonly error: E) { super() }

  *[Symbol.iterator](): Generator<Left<E>, never, unknown> {
    yield this
    throw new Error("Unreachable: Left yielded but generator continued")
  }

  toJSON(): { _tag: "Left"; error: E } {
    return { _tag: "Left", error: this.error }
  }

  [Symbol.toPrimitive](hint: "string" | "number" | "default") {
    return hint === "string" ? String(this.error) : NaN
  }
}

class Right<A> extends EitherBase<never, A> {
  readonly _tag = "Right" as const
  constructor(readonly value: A) { super() }

  *[Symbol.iterator](): Generator<never, A, unknown> {
    return this.value
  }

  toJSON(): { _tag: "Right"; value: A } {
    return { _tag: "Right", value: this.value }
  }

  [Symbol.toPrimitive](hint: "string" | "number" | "default") {
    return hint === "string" ? String(this.value) : this.value
  }
}

function left<E>(e: E): Left<E> { return new Left(e) }
function right<A>(a: A): Right<A> { return new Right(a) }

type InferE<T> = T extends Left<infer E> ? E : never
type InferA<T> = T extends Right<infer A> ? A : never

function isLeft<E, A>(value: Either<E, A>): value is Left<E> {
  return value._tag === "Left"
}

function isRight<E, A>(value: Either<E, A>): value is Right<A> {
  return value._tag === "Right"
}

// Type guard for checking if a return value is a Left
// Uses Extract to properly narrow to the Left variant of the return type
function isLeftReturn<T>(value: T): value is Extract<T, Left<any>> {
  return value !== null &&
    typeof value === 'object' &&
    '_tag' in value &&
    value._tag === "Left"
}

// ============================================================================
// THE CORE ABSTRACTION: fold over a generator with a strategy
// ============================================================================

type Step<Acc, R> = 
  | { done: true; result: R }
  | { done: false; send: unknown; acc: Acc }

type Strategy<Eff, Ret, Acc, R> = {
  init: Acc
  step: (eff: Eff, acc: Acc) => Step<Acc, R>
  finish: (ret: Ret, acc: Acc) => R
}

function fold<Eff, Ret, Acc, R>(
  fn: () => Generator<Eff, Ret, unknown>,
  strategy: Strategy<Eff, Ret, Acc, R>
): R {
  const gen = fn()
  let acc = strategy.init
  let next = gen.next()

  while (!next.done) {
    const result = strategy.step(next.value, acc)
    if (result.done) return result.result
    acc = result.acc
    next = gen.next(result.send)
  }

  return strategy.finish(next.value, acc)
}

// ============================================================================
// ASYNC SUPPORT - No global pollution
// ============================================================================

type Rejected = { readonly _tag: "Rejected"; readonly cause: unknown }
const rejected = (cause: unknown): Rejected => ({ _tag: "Rejected", cause })

// Polymorphic raise:
// - raise(promise) → Promise<Either<Rejected, T>>  (for yield* await)
// - raise(error) → Left<E>  (for returning)
// ORDER MATTERS: Promise overload must come first!
function raise<T>(p: Promise<T>): Promise<Either<Rejected, T>>
function raise<const E>(e: E): Left<E>
function raise(x: unknown): Promise<Either<Rejected, unknown>> | Left<any> {
  if (x instanceof Promise) {
    return x.then(right, e => left(rejected(e)))
  }
  return left(x)
}

type Raise = typeof raise

async function foldAsync<Eff, Ret, Acc, R>(
  gen: AsyncGenerator<Eff, Ret, unknown>,
  strategy: Strategy<Eff, Ret, Acc, R>
): Promise<R> {
  let acc = strategy.init
  let next = await gen.next()

  while (!next.done) {
    const result = strategy.step(next.value, acc)
    if (result.done) return result.result
    acc = result.acc
    next = await gen.next(result.send)
  }

  return strategy.finish(next.value, acc)
}

// ============================================================================
// BUILT ON FOLD: either (short-circuit) — works for sync AND async
// ============================================================================

// NOTE: Either<any, any> constraint is intentional. Using Either<unknown, unknown>
// causes eff.error/eff.value to be `unknown` inside strategy bodies. The `any`
// acts as a wildcard that allows proper type inference to flow through.
const eitherStrategy = <Eff extends Either<any, any>, Ret>(): Strategy<
  Eff,
  Ret,
  null,
  Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>
> => ({
  init: null,
  step: (eff, acc) => 
    eff._tag === "Left" 
      ? { done: true, result: eff } 
      : { done: false, send: eff.value, acc },
  finish: (ret, _acc) => 
    isLeftReturn(ret) 
      ? ret 
      : right(ret as Exclude<Ret, Left<any>>)
})

// Type guards for generator detection
function isAsyncGenerator<Y, R>(
  gen: Generator<Y, R, unknown> | AsyncGenerator<Y, R, unknown>
): gen is AsyncGenerator<Y, R, unknown> {
  return Symbol.asyncIterator in gen
}

// Overloads for proper type inference
function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: Raise) => Generator<Eff, Ret>
): Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>

function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: Raise) => AsyncGenerator<Eff, Ret>
): Promise<Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>>

function either<Eff extends Either<any, any>, Ret>(
  fn: (raise: Raise) => Generator<Eff, Ret, unknown> | AsyncGenerator<Eff, Ret, unknown>
): Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>> | 
   Promise<Either<InferE<Eff> | InferE<Extract<Ret, Left<any>>>, Exclude<Ret, Left<any>>>> {
  const gen = fn(raise)
  
  if (isAsyncGenerator(gen)) {
    return foldAsync(gen, eitherStrategy())
  }
  
  return fold(() => gen, eitherStrategy())
}

// ============================================================================
// BUILT ON FOLD: validate (accumulate errors)
// ============================================================================

function* check<E, A>(e: Either<E, A>): Generator<Either<E, A>, A | undefined, undefined> {
  yield e
  return e._tag === "Right" ? e.value : undefined
}

type Check = typeof check

const validateStrategy = <Eff extends Either<any, any>, Ret>(): Strategy<
  Eff,
  Ret,
  InferE<Eff>[],
  Either<InferE<Eff>[], Exclude<Ret, Left<any>>>
> => ({
  init: [],
  step: (eff, acc) => {
    if (eff._tag === "Left") acc.push(eff.error)
    return { done: false, send: undefined, acc }
  },
  finish: (ret, acc) => {
    if (isLeftReturn(ret)) acc.push(ret.error)
    return acc.length > 0 
      ? left(acc) 
      : right(ret as Exclude<Ret, Left<any>>)
  }
})

function validate<Eff extends Either<any, any>, Ret>(
  fn: (check: Check) => Generator<Eff, Ret>
): Either<InferE<Eff>[], Exclude<Ret, Left<any>>> {
  return fold(() => fn(check), validateStrategy())
}

// ============================================================================
// BUILT ON FOLD: firstOf (try multiple, return first success)
// ============================================================================

const firstOfStrategy = <Eff extends Either<any, any>, Ret>(): Strategy<
  Eff,
  Ret,
  InferE<Eff>[],
  Either<InferE<Eff>[], InferA<Eff> | Exclude<Ret, Left<any>>>
> => ({
  init: [],
  step: (eff, acc) => {
    if (eff._tag === "Right") {
      return { done: true, result: right(eff.value) }
    }
    acc.push(eff.error)
    return { done: false, send: undefined, acc }
  },
  finish: (ret, acc) => {
    if (!isLeftReturn(ret)) return right(ret as Exclude<Ret, Left<any>>)
    acc.push(ret.error)
    return left(acc)
  }
})

function firstOf<Eff extends Either<any, any>, Ret>(
  fn: () => Generator<Eff, Ret>
): Either<InferE<Eff>[], InferA<Eff> | Exclude<Ret, Left<any>>> {
  return fold(fn, firstOfStrategy())
}

// ============================================================================
// BUILT ON FOLD: collect (run all, gather successes and errors separately)
// ============================================================================

type Collected<E, A> = { errors: E[]; values: A[] }

const collectStrategy = <Eff extends Either<any, any>>(): Strategy<
  Eff,
  void,
  Collected<InferE<Eff>, InferA<Eff>>,
  Collected<InferE<Eff>, InferA<Eff>>
> => ({
  init: { errors: [], values: [] },
  step: (eff, acc) => {
    if (eff._tag === "Left") acc.errors.push(eff.error)
    else acc.values.push(eff.value)
    return { done: false, send: undefined, acc }
  },
  finish: (_ret, acc) => acc
})

function collect<Eff extends Either<any, any>>(
  fn: () => Generator<Eff, void>
): Collected<InferE<Eff>, InferA<Eff>> {
  return fold(fn, collectStrategy())
}

// ============================================================================
// STANDARD HELPERS
// ============================================================================

function ensure<const E>(cond: boolean, onFail: () => E): Either<E, void> {
  return cond ? right(undefined) : left(onFail())
}

function ensureNotNull<A, const E>(value: A | null | undefined, onNull: () => E): Either<E, A> {
  return value != null ? right(value) : left(onNull())
}

// ============================================================================
// DEMO
// ============================================================================

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }

const getUser = (id: string) => either(function* (raise) {
  if (id !== "1") return raise("UserNotFound")
  return { id, name: "Axel", active: true }
})

const getOrders = (userId: string): Either<"DbError", Order[]> =>
  right([{ id: "order-1", userId }])

const program = either(function* (raise) {
  const user = yield* getUser("1")
  if (!user.active) return raise("UserInactive")
  const orders = yield* getOrders(user.id)
  if (!orders[0]) return raise("NoOrders")
  return { user, first: orders[0] }
})

console.log("=== Basic ===")
console.log(program)
console.log("JSON:", JSON.stringify(program))

console.log("\n=== Symbol.toPrimitive ===")
const num = right(42)
const str = left("oops")
console.log("right(42) + 1 =", +num + 1)
console.log("String(left('oops')) =", String(str))

console.log("\n=== Validation (accumulate errors) ===")
const validateAge = (n: number): Either<"TooYoung" | "TooOld", number> =>
  n < 0 ? left("TooYoung") : n > 150 ? left("TooOld") : right(n)

const validateName = (s: string): Either<"Empty" | "TooLong", string> =>
  s.length === 0 ? left("Empty") : s.length > 100 ? left("TooLong") : right(s)

const validated = validate(function* (check) {
  const age = yield* check(validateAge(-5))
  const name = yield* check(validateName(""))
  return { age, name }
})
console.log("Accumulated errors:", validated)

console.log("\n=== firstOf (return first success) ===")
const fetchFromCache = (): Either<"CacheMiss", string> => left("CacheMiss")
const fetchFromDb = (): Either<"DbError", string> => left("DbError")
const fetchFromApi = (): Either<"ApiError", string> => right("got it from API!")

const fetched = firstOf(function* () {
  yield fetchFromCache()  // Left → continues
  yield fetchFromDb()     // Left → continues
  yield fetchFromApi()    // Right → stops, returns this
})
console.log("First success:", fetched)

console.log("\n=== collect (partition results) ===")
const results = [
  right(1),
  left("err1" as const),
  right(2),
  left("err2" as const),
  right(3)
]
const collected = collect(function* () {
  for (const r of results) {
    yield r  // just yield, no gather needed
  }
})
console.log("Collected:", collected)

console.log("\n=== Async (same `either`, just async function*) ===")

const fetchUser = async (id: string): Promise<Either<"NotFound", { id: string; name: string }>> => {
  await new Promise(r => setTimeout(r, 10))
  return id === "1" ? right({ id, name: "Axel" }) : left("NotFound")
}

const fetchOrders = async (userId: string): Promise<Either<"DbError", string[]>> => {
  await new Promise(r => setTimeout(r, 10))
  return right(["order-1", "order-2"])
}

// Simulate a raw fetch that might reject
const rawFetch = (url: string): Promise<{ data: string }> => {
  if (url === "/bad") return Promise.reject(new Error("Network error"))
  return Promise.resolve({ data: "hello" })
}

// Promise<Either> — yield* await as usual
const safeProgram = either(async function* (raise) {
  const user = yield* await fetchUser("1")
  const orders = yield* await fetchOrders(user.id)
  if (orders.length === 0) return raise("NoOrders")
  return { user, orders }
})

// Raw Promise — use raise() to catch rejections!
const rawSuccessProgram = either(async function* (raise) {
  const data = yield* await raise(rawFetch("/good"))
  return data
})

// Raw Promise that rejects — raise() turns it into Left<Rejected>
const rawRejectProgram = either(async function* (raise) {
  const data = yield* await raise(rawFetch("/bad"))
  return data
})

safeProgram.then(r => console.log("Safe:", r))
rawSuccessProgram.then(r => console.log("Raw success:", r))
rawRejectProgram.then(r => console.log("Raw rejection:", r))

export { 
  Either, Left, Right, left, right,
  isLeft, isRight,
  either, raise, ensure, ensureNotNull,
  validate,
  firstOf,
  collect,
  fold, foldAsync, Strategy, Step,
  Rejected, rejected
}
