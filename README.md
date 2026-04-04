# yeet

_Some say error handling is hard. They're wrong. It's just been done poorly._

There is a certain kind of programmer who, when faced with an error, throws an exception and walks away. Hopes for the best. That programmer is not you.

You are here because you believe errors deserve to be _handled_, carried with dignity from the place they are born to the place they belong.

```ts
import { either } from 'yeet'

const result = either(function* (raise) {
  const user = yield* getUser('1')
  if (!user.active) return raise('Inactive')
  const orders = yield* getOrders(user.id)
  return { user, orders }
})
// Either<"UserNotFound" | "Inactive" | "DbError", { user, orders }>
```

No method chains. No wrapper types on every line. No explicit type annotations.

Just generators. Just JavaScript.

---

## The Simple Truth

**Sync:**

```ts
const user = yield * getUser(id)
```

**Async:**

```ts
const user = yield * (await fetchUser(id))
```

**Raw promises that might reject:**

```ts
const data = yield * (await raise(fetch('/api')))
```

That's it. That's the whole API.

---

## What `raise` Does

```ts
raise('NotFound') // → Left<"NotFound">
raise(fetch('/api')) // → Promise<Either<Rejected, Response>>
```

One function. Two jobs. No confusion.

---

## When You Need More

**Accumulate all errors instead of short-circuiting:**

```ts
const result = validate(function* (check) {
  const age = yield* check(validateAge(input.age))
  const name = yield* check(validateName(input.name))
  return { age, name }
})
// Either<ValidationError[], { age, name }>
```

**Try multiple sources, take first success:**

```ts
const data = firstOf(function* () {
  yield cache.get(key)
  yield db.get(key)
  yield api.get(key)
})
// Either<Error[], Data>
```

**Collect successes and failures separately:**

```ts
const { values, errors } = collect(function* () {
  for (const item of items) yield process(item)
})
```

**The engine, if you want to drive it yourself:**

`fold` / `foldAsync` accept a `Strategy` (`init`, `step`, `finish`) and run any generator through it. Everything above is built on top of these two functions.

---

## Install

```sh
bun add yeet
```

---

## Why This Exists

Every Result library asks you to learn a new language. Method chains. Pipe operators. Bespoke combinators for things you already know how to do.

This library asks you to learn nothing. If you know `yield*`, you already know everything. The errors flow through the types automatically. TypeScript sees what you yield and builds the union for you. No annotations. No ceremony.

`Left` and `Right` implement `Symbol.iterator`, `Symbol.toPrimitive`, and `toJSON`. They compose. They serialise. They behave.

_Some things in life just work. This is one of them._

---

MIT
