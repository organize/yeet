import { Result } from 'better-result'
import { afterAll, bench, describe } from 'vitest'

import { BENCH_OPTS } from './bench-options.ts'
import { either } from './combinators.ts'
import { left, right, type Either } from './either.ts'
import { ndjson } from './stream.ts'
import yeet from './unplugin.ts'

const YEET_SOURCE = new URL('./index.ts', import.meta.url).href
const STREAM_SOURCE = new URL('./stream.ts', import.meta.url).href
const FIXTURE_ID = 'src/overhead.bench.fixture.js'
const BENCH_BATCH = readPositiveInt('BENCH_BATCH', 64)

type User = {
  readonly id: string
  readonly name: string
  readonly active: boolean
}
type Order = { readonly id: string; readonly userId: string }
type Session = {
  readonly id: string
  readonly userId: string
  readonly tenant: {
    readonly id: string
    readonly region: 'us' | 'eu'
    readonly flags: { readonly checkoutV2: boolean }
  }
}
type Account = {
  readonly id: string
  readonly userId: string
  readonly status: 'active' | 'suspended'
  readonly plan: {
    readonly tier: 'free' | 'pro'
    readonly limits: { readonly maxOrderValueCents: number }
  }
  readonly billing: {
    readonly currency: 'USD' | 'EUR'
    readonly taxRegion: 'CA' | 'NY'
  }
}
type CartItem = {
  readonly sku: string
  readonly qty: number
  readonly unitCents: number
  readonly metadata: {
    readonly category: 'book' | 'device'
    readonly grams: number
  }
}
type Cart = {
  readonly id: string
  readonly userId: string
  readonly items: readonly CartItem[]
  readonly shipping: {
    readonly country: 'US' | 'DE'
    readonly postalCode: string
  }
}
type Reservation = {
  readonly id: string
  readonly lines: ReadonlyArray<{
    readonly sku: string
    readonly qty: number
    readonly warehouse: { readonly id: string; readonly zone: string }
  }>
}
type PriceBreakdown = {
  readonly subtotalCents: number
  readonly shippingCents: number
  readonly discountCents: number
}
type TaxQuote = { readonly rateBasisPoints: number; readonly taxCents: number }
type Fulfillment = {
  readonly reservation: Reservation
  readonly price: PriceBreakdown
  readonly tax: TaxQuote
}
type PaymentMethod = {
  readonly id: string
  readonly network: 'visa' | 'mastercard'
  readonly risk: { readonly fingerprint: string; readonly verified: boolean }
}
type RiskDecision = {
  readonly score: number
  readonly reasons: readonly string[]
}
type OrderReceipt = { readonly id: string; readonly totalCents: number }
type BenchModule = {
  singleSuccess: (index: number) => unknown
  twoSuccess: (index: number) => unknown
  singleFailure: (index: number) => unknown
  asyncTwoSuccess: (index: number) => Promise<unknown>
  checkout: (index: number) => unknown
}
type StreamBenchModule = {
  ndjsonStream: (index: number) => Promise<unknown>
}
type RawPlugin = {
  readonly transform?: {
    readonly handler?: (
      code: string,
      id: string,
    ) =>
      | string
      | { readonly code: string }
      | null
      | Promise<
          | string
          | {
              readonly code: string
            }
          | null
        >
  }
}

const USERS: Record<string, User> = {
  '1': { id: '1', name: 'Axel', active: true },
  '2': { id: '2', name: 'Bea', active: true },
}
const USER_ID = '1'
const ORDERS: Record<string, readonly Order[]> = {
  '1': [{ id: 'order-1', userId: '1' }],
  '2': [{ id: 'order-2', userId: '2' }],
}
const SESSION: Session = {
  id: 'session-1',
  userId: '1',
  tenant: { id: 'tenant-1', region: 'us', flags: { checkoutV2: true } },
}
const ACCOUNT: Account = {
  id: 'account-1',
  userId: '1',
  status: 'active',
  plan: { tier: 'pro', limits: { maxOrderValueCents: 50_000 } },
  billing: { currency: 'USD', taxRegion: 'CA' },
}
const CART: Cart = {
  id: 'cart-1',
  userId: '1',
  items: [
    {
      sku: 'book-1',
      qty: 2,
      unitCents: 1_999,
      metadata: { category: 'book', grams: 450 },
    },
    {
      sku: 'device-1',
      qty: 1,
      unitCents: 12_999,
      metadata: { category: 'device', grams: 900 },
    },
    {
      sku: 'book-2',
      qty: 1,
      unitCents: 2_499,
      metadata: { category: 'book', grams: 380 },
    },
  ],
  shipping: { country: 'US', postalCode: '94107' },
}
const PAYMENT_METHOD: PaymentMethod = {
  id: 'pm-1',
  network: 'visa',
  risk: { fingerprint: 'fp-1', verified: true },
}
const HIT_IDS = ['1', '2'] as const
const MISS_IDS = ['missing-a', 'missing-b'] as const
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const NDJSON_A = chunkText(
  `${Array.from({ length: 48 }, (_, index) =>
    JSON.stringify({ id: index, token: `tool-${index}` }),
  ).join('\n')}\n`,
  53,
).map((chunk) => encoder.encode(chunk))
const NDJSON_B = chunkText(
  `${Array.from({ length: 48 }, (_, index) =>
    JSON.stringify({ id: index + 48, token: `tool-${index}` }),
  ).join('\n')}\n`,
  53,
).map((chunk) => encoder.encode(chunk))

const LOWERED_SOURCE = `
  import { either, left, right } from ${JSON.stringify(YEET_SOURCE)}
  import { ndjson } from ${JSON.stringify(STREAM_SOURCE)}

  const encoder = new TextEncoder()
  const USERS = {
    "1": { id: "1", name: "Axel", active: true },
    "2": { id: "2", name: "Bea", active: true },
  }
  const ORDERS = {
    "1": [{ id: "order-1", userId: "1" }],
    "2": [{ id: "order-2", userId: "2" }],
  }
  const HIT_IDS = ["1", "2"]
  const MISS_IDS = ["missing-a", "missing-b"]
  const SESSION = {
    id: "session-1",
    userId: "1",
    tenant: { id: "tenant-1", region: "us", flags: { checkoutV2: true } },
  }
  const ACCOUNT = {
    id: "account-1",
    userId: "1",
    status: "active",
    plan: { tier: "pro", limits: { maxOrderValueCents: 50000 } },
    billing: { currency: "USD", taxRegion: "CA" },
  }
  const CART = {
    id: "cart-1",
    userId: "1",
    items: [
      {
        sku: "book-1",
        qty: 2,
        unitCents: 1999,
        metadata: { category: "book", grams: 450 },
      },
      {
        sku: "device-1",
        qty: 1,
        unitCents: 12999,
        metadata: { category: "device", grams: 900 },
      },
      {
        sku: "book-2",
        qty: 1,
        unitCents: 2499,
        metadata: { category: "book", grams: 380 },
      },
    ],
    shipping: { country: "US", postalCode: "94107" },
  }
  const PAYMENT_METHOD = {
    id: "pm-1",
    network: "visa",
    risk: { fingerprint: "fp-1", verified: true },
  }
  const NDJSON_A = chunkText(
    Array.from({ length: 48 }, (_, index) =>
      JSON.stringify({ id: index, token: "tool-" + index })
    ).join("\\n") + "\\n",
    53,
  ).map((chunk) => encoder.encode(chunk))
  const NDJSON_B = chunkText(
    Array.from({ length: 48 }, (_, index) =>
      JSON.stringify({ id: index + 48, token: "tool-" + index })
    ).join("\\n") + "\\n",
    53,
  ).map((chunk) => encoder.encode(chunk))

  function bit(index) {
    return index & 1
  }

  function getUser(id) {
    const user = USERS[id]
    return user === undefined ? left("UserNotFound") : right(user)
  }

  function getOrders(userId) {
    return right(ORDERS[userId])
  }

  function getSession(id) {
    return id === "session-1" ? right(SESSION) : left("SessionExpired")
  }

  function getAccount(userId) {
    return userId === ACCOUNT.userId ? right(ACCOUNT) : left("AccountMissing")
  }

  function getCart(userId) {
    return userId === CART.userId ? right(CART) : left("CartMissing")
  }

  function reserveInventory(cart) {
    return cart.items.length > 0
      ? right({
          id: "reservation-1",
          lines: cart.items.map((item) => ({
            sku: item.sku,
            qty: item.qty,
            warehouse: {
              id:
                item.metadata.category === "device"
                  ? "warehouse-b"
                  : "warehouse-a",
              zone: item.metadata.grams > 500 ? "heavy" : "standard",
            },
          })),
        })
      : left("InventoryUnavailable")
  }

  function priceCart(cart, account) {
    let subtotalCents = 0
    for (const item of cart.items) subtotalCents += item.qty * item.unitCents

    return right({
      subtotalCents,
      shippingCents: cart.shipping.country === "US" ? 799 : 1499,
      discountCents: account.plan.tier === "pro" ? 500 : 0,
    })
  }

  function quoteTax(price, account) {
    const taxableCents =
      price.subtotalCents + price.shippingCents - price.discountCents
    const rateBasisPoints = account.billing.taxRegion === "CA" ? 825 : 700

    return right({
      rateBasisPoints,
      taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10000),
    })
  }

  function getPaymentMethod(userId) {
    return userId === USERS["1"].id ? right(PAYMENT_METHOD) : left("PaymentMissing")
  }

  function assessRisk(user, account, cart, payment) {
    return right({
      score:
        (user.active ? 5 : 90) +
        (account.plan.tier === "pro" ? 3 : 15) +
        (payment.risk.verified ? 0 : 25) +
        cart.items.length,
      reasons: payment.risk.verified ? [] : ["unverified-payment"],
    })
  }

  function persistOrder(user, reservation, price, tax) {
    return right({
      id: "order-" + user.id + "-" + reservation.lines.length,
      totalCents:
        price.subtotalCents +
        price.shippingCents -
        price.discountCents +
        tax.taxCents,
    })
  }

  function buildFulfillment(cart, account) {
    return either(function* (raise) {
      const reservation = yield* reserveInventory(cart)
      const price = yield* priceCart(cart, account)
      if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
        return raise("LimitExceeded")
      }
      const tax = yield* quoteTax(price, account)
      return { reservation, price, tax }
    })
  }

  async function fetchUser(id) {
    return getUser(id)
  }

  async function fetchOrders(userId) {
    return getOrders(userId)
  }

  export function singleSuccess(index) {
    return either(function* () {
      const user = yield* getUser(HIT_IDS[bit(index)])
      return user
    })
  }

  export function twoSuccess(index) {
    return either(function* (raise) {
      const user = yield* getUser(HIT_IDS[bit(index)])
      if (!user.active) return raise("Inactive")
      const orders = yield* getOrders(user.id)
      return { user, first: orders[0] }
    })
  }

  export function singleFailure(index) {
    return either(function* () {
      const user = yield* getUser(MISS_IDS[bit(index)])
      return user
    })
  }

  export async function asyncTwoSuccess(index) {
    return either(async function* (raise) {
      const user = yield* await fetchUser(HIT_IDS[bit(index)])
      const orders = yield* await fetchOrders(user.id)
      if (orders.length === 0) return raise("NoOrders")
      return { user, orders }
    })
  }

  export function checkout() {
    return either(function* (raise) {
      const session = yield* getSession("session-1")
      if (!session.tenant.flags.checkoutV2) return raise("CheckoutDisabled")

      const user = yield* getUser(session.userId)
      if (!user.active) return raise("Inactive")

      const account = yield* getAccount(user.id)
      if (account.status !== "active") return raise("AccountSuspended")

      const cart = yield* getCart(user.id)
      const fulfillment = yield* buildFulfillment(cart, account)
      const payment = yield* getPaymentMethod(user.id)
      const risk = yield* assessRisk(user, account, cart, payment)
      if (risk.score > 80) return raise("RiskRejected")

      const receipt = yield* persistOrder(
        user,
        fulfillment.reservation,
        fulfillment.price,
        fulfillment.tax,
      )

      return {
        receipt,
        customer: {
          id: user.id,
          tenant: session.tenant.id,
          account: { id: account.id, tier: account.plan.tier },
        },
        checkout: {
          cart: { id: cart.id, itemCount: cart.items.length },
          fulfillment,
          payment: {
            id: payment.id,
            network: payment.network,
            riskScore: risk.score,
          },
        },
      }
    })
  }

  export async function ndjsonStream(index) {
    const chunks = bit(index) === 0 ? NDJSON_A : NDJSON_B

    return either(async function* () {
      let count = 0
      let sum = 0
      for await (const next of ndjson(asyncValues(chunks))) {
        const event = yield* next
        count++
        sum += event.id
      }
      return { count, sum }
    })
  }

  async function* asyncValues(values) {
    for (let index = 0; index < values.length; index++) yield values[index]
  }

  function chunkText(input, size) {
    const chunks = []
    for (let index = 0; index < input.length; index += size) {
      chunks.push(input.slice(index, index + size))
    }
    return chunks
  }
`

const vanillaModule: BenchModule = {
  singleSuccess: vanillaSingleSuccess,
  twoSuccess: vanillaTwoSuccess,
  singleFailure: vanillaSingleFailure,
  asyncTwoSuccess: vanillaAsyncTwoSuccess,
  checkout: vanillaCheckout,
}
const betterResultModule: BenchModule = {
  singleSuccess: betterSingleSuccess,
  twoSuccess: betterTwoSuccess,
  singleFailure: betterSingleFailure,
  asyncTwoSuccess: betterAsyncTwoSuccess,
  checkout: betterCheckout,
}
const yeetModule: BenchModule = {
  singleSuccess: yeetSingleSuccess,
  twoSuccess: yeetTwoSuccess,
  singleFailure: yeetSingleFailure,
  asyncTwoSuccess: yeetAsyncTwoSuccess,
  checkout: yeetCheckout,
}
const vanillaStreamModule: StreamBenchModule = {
  ndjsonStream: vanillaNdjsonStream,
}
const yeetStreamModule: StreamBenchModule = {
  ndjsonStream: yeetNdjsonStream,
}
const loweredModule = await importBenchModule(
  await transformWithPlugin(LOWERED_SOURCE),
)
const benchSink = { value: undefined as unknown }

afterAll(() => {
  void benchSink.value
})

benchFamily('overhead: sync single success', 'singleSuccess')
benchFamily('overhead: sync two successes', 'twoSuccess')
benchFamily('overhead: sync failure', 'singleFailure')
benchFamily('overhead: async two successes', 'asyncTwoSuccess')
benchFamily('overhead: complex checkout success', 'checkout')
benchStreamFamily()

function benchFamily(suite: string, fn: keyof BenchModule): void {
  describe(suite, () => {
    benchVariant('vanilla exceptions', vanillaModule, fn)
    benchVariant('better-result', betterResultModule, fn)
    benchVariant('yeet', yeetModule, fn)
    benchVariant('yeet lowered', loweredModule, fn)
  })
}

function benchVariant(
  name: string,
  module: BenchModule,
  fn: keyof BenchModule,
): void {
  const next = indexer()
  bench(
    name,
    async () => {
      await consumeBatch(module, fn, next)
    },
    BENCH_OPTS,
  )
}

function benchStreamFamily(): void {
  describe('streams: ndjson success', () => {
    benchStreamVariant('vanilla parser', vanillaStreamModule)
    benchStreamVariant('yeet stream', yeetStreamModule)
    benchStreamVariant('yeet stream lowered', loweredModule)
  })
}

function benchStreamVariant(name: string, module: StreamBenchModule): void {
  const next = indexer()
  bench(
    name,
    async () => {
      await consumeStreamBatch(module, next)
    },
    BENCH_OPTS,
  )
}

async function consumeBatch(
  module: BenchModule,
  fn: keyof BenchModule,
  next: () => number,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = await module[fn](next())
  }
  benchSink.value = value
}

async function consumeStreamBatch(
  module: StreamBenchModule,
  next: () => number,
): Promise<void> {
  let value: unknown
  for (let batch = 0; batch < BENCH_BATCH; batch++) {
    value = await module.ndjsonStream(next())
  }
  benchSink.value = value
}

function vanillaSingleSuccess(index: number): unknown {
  try {
    return getUserOrThrow(HIT_IDS[bit(index)])
  } catch (error) {
    return error
  }
}

function vanillaTwoSuccess(index: number): unknown {
  try {
    const user = getUserOrThrow(HIT_IDS[bit(index)])
    if (!user.active) throw new Error('Inactive')
    const orders = getOrdersOrThrow(user.id)
    return { user, first: orders[0] }
  } catch (error) {
    return error
  }
}

function vanillaSingleFailure(index: number): unknown {
  try {
    return getUserOrThrow(MISS_IDS[bit(index)])
  } catch (error) {
    return error
  }
}

async function vanillaAsyncTwoSuccess(index: number): Promise<unknown> {
  try {
    const user = await fetchUserOrThrow(HIT_IDS[bit(index)])
    const orders = await fetchOrdersOrThrow(user.id)
    if (orders.length === 0) throw new Error('NoOrders')
    return { user, orders }
  } catch (error) {
    return error
  }
}

function vanillaCheckout(): unknown {
  try {
    const session = getSessionOrThrow('session-1')
    if (!session.tenant.flags.checkoutV2) throw new Error('CheckoutDisabled')

    const user = getUserOrThrow(session.userId)
    if (!user.active) throw new Error('Inactive')

    const account = getAccountOrThrow(user.id)
    if (account.status !== 'active') throw new Error('AccountSuspended')

    const cart = getCartOrThrow(user.id)
    const fulfillment = buildFulfillmentOrThrow(cart, account)
    const payment = getPaymentMethodOrThrow(user.id)
    const risk = assessRiskOrThrow(user, account, cart, payment)
    if (risk.score > 80) throw new Error('RiskRejected')

    const receipt = persistOrderOrThrow(
      user,
      fulfillment.reservation,
      fulfillment.price,
      fulfillment.tax,
    )

    return checkoutPayload(
      session,
      user,
      account,
      cart,
      fulfillment,
      payment,
      risk,
      receipt,
    )
  } catch (error) {
    return error
  }
}

async function vanillaNdjsonStream(index: number): Promise<unknown> {
  try {
    return await parseNdjsonStream(bit(index) === 0 ? NDJSON_A : NDJSON_B)
  } catch (error) {
    return error
  }
}

function betterSingleSuccess(index: number): unknown {
  return Result.gen(function* () {
    const user = yield* brGetUser(HIT_IDS[bit(index)])
    return Result.ok(user)
  })
}

function betterTwoSuccess(index: number): unknown {
  return Result.gen(function* () {
    const user = yield* brGetUser(HIT_IDS[bit(index)])
    if (!user.active) return Result.err('Inactive' as const)
    const orders = yield* brGetOrders(user.id)
    return Result.ok({ user, first: orders[0] })
  })
}

function betterSingleFailure(index: number): unknown {
  return Result.gen(function* () {
    const user = yield* brGetUser(MISS_IDS[bit(index)])
    return Result.ok(user)
  })
}

async function betterAsyncTwoSuccess(index: number): Promise<unknown> {
  return Result.gen(async function* () {
    const user = yield* Result.await(brFetchUser(HIT_IDS[bit(index)]))
    const orders = yield* Result.await(brFetchOrders(user.id))
    if (orders.length === 0) return Result.err('NoOrders' as const)
    return Result.ok({ user, orders })
  })
}

function betterCheckout(): unknown {
  return Result.gen(function* () {
    const session = yield* brGetSession('session-1')
    if (!session.tenant.flags.checkoutV2) {
      return Result.err('CheckoutDisabled' as const)
    }

    const user = yield* brGetUser(session.userId)
    if (!user.active) return Result.err('Inactive' as const)

    const account = yield* brGetAccount(user.id)
    if (account.status !== 'active') {
      return Result.err('AccountSuspended' as const)
    }

    const cart = yield* brGetCart(user.id)
    const fulfillment = yield* brBuildFulfillment(cart, account)
    const payment = yield* brGetPaymentMethod(user.id)
    const risk = yield* brAssessRisk(user, account, cart, payment)
    if (risk.score > 80) return Result.err('RiskRejected' as const)

    const receipt = yield* brPersistOrder(
      user,
      fulfillment.reservation,
      fulfillment.price,
      fulfillment.tax,
    )

    return Result.ok(
      checkoutPayload(
        session,
        user,
        account,
        cart,
        fulfillment,
        payment,
        risk,
        receipt,
      ),
    )
  })
}

function yeetSingleSuccess(index: number): unknown {
  return either(function* () {
    const user = yield* getUser(HIT_IDS[bit(index)])
    return user
  })
}

function yeetTwoSuccess(index: number): unknown {
  return either(function* (raise) {
    const user = yield* getUser(HIT_IDS[bit(index)])
    if (!user.active) return raise('Inactive' as const)
    const orders = yield* getOrders(user.id)
    return { user, first: orders[0] }
  })
}

function yeetSingleFailure(index: number): unknown {
  return either(function* () {
    const user = yield* getUser(MISS_IDS[bit(index)])
    return user
  })
}

async function yeetAsyncTwoSuccess(index: number): Promise<unknown> {
  return either(async function* (raise) {
    const user = yield* await fetchUser(HIT_IDS[bit(index)])
    const orders = yield* await fetchOrders(user.id)
    if (orders.length === 0) return raise('NoOrders' as const)
    return { user, orders }
  })
}

function yeetCheckout(): unknown {
  return either(function* (raise) {
    const session = yield* getSession('session-1')
    if (!session.tenant.flags.checkoutV2)
      return raise('CheckoutDisabled' as const)

    const user = yield* getUser(session.userId)
    if (!user.active) return raise('Inactive' as const)

    const account = yield* getAccount(user.id)
    if (account.status !== 'active') return raise('AccountSuspended' as const)

    const cart = yield* getCart(user.id)
    const fulfillment = yield* buildFulfillment(cart, account)
    const payment = yield* getPaymentMethod(user.id)
    const risk = yield* assessRisk(user, account, cart, payment)
    if (risk.score > 80) return raise('RiskRejected' as const)

    const receipt = yield* persistOrder(
      user,
      fulfillment.reservation,
      fulfillment.price,
      fulfillment.tax,
    )

    return checkoutPayload(
      session,
      user,
      account,
      cart,
      fulfillment,
      payment,
      risk,
      receipt,
    )
  })
}

async function yeetNdjsonStream(index: number): Promise<unknown> {
  const chunks = bit(index) === 0 ? NDJSON_A : NDJSON_B

  return either(async function* () {
    let count = 0
    let sum = 0
    for await (const next of ndjson(asyncValues(chunks))) {
      const event = (yield* next) as { readonly id: number }
      count++
      sum += event.id
    }
    return { count, sum }
  })
}

function getUser(id: string): Either<'UserNotFound', User> {
  const user = USERS[id]
  return user === undefined ? left('UserNotFound') : right(user)
}

function getOrders(userId: string): Either<'DbError', readonly Order[]> {
  return right(ORDERS[userId] ?? [])
}

function getSession(id: string): Either<'SessionExpired', Session> {
  return id === 'session-1' ? right(SESSION) : left('SessionExpired')
}

function getAccount(userId: string): Either<'AccountMissing', Account> {
  return userId === ACCOUNT.userId ? right(ACCOUNT) : left('AccountMissing')
}

function getCart(userId: string): Either<'CartMissing', Cart> {
  return userId === CART.userId ? right(CART) : left('CartMissing')
}

function reserveInventory(
  cart: Cart,
): Either<'InventoryUnavailable', Reservation> {
  return cart.items.length > 0
    ? right({
        id: 'reservation-1',
        lines: cart.items.map((item) => ({
          sku: item.sku,
          qty: item.qty,
          warehouse: {
            id:
              item.metadata.category === 'device'
                ? 'warehouse-b'
                : 'warehouse-a',
            zone: item.metadata.grams > 500 ? 'heavy' : 'standard',
          },
        })),
      })
    : left('InventoryUnavailable')
}

function priceCart(
  cart: Cart,
  account: Account,
): Either<'PricingUnavailable', PriceBreakdown> {
  let subtotalCents = 0
  for (const item of cart.items) subtotalCents += item.qty * item.unitCents

  return right({
    subtotalCents,
    shippingCents: cart.shipping.country === 'US' ? 799 : 1_499,
    discountCents: account.plan.tier === 'pro' ? 500 : 0,
  })
}

function quoteTax(
  price: PriceBreakdown,
  account: Account,
): Either<'TaxUnavailable', TaxQuote> {
  const taxableCents =
    price.subtotalCents + price.shippingCents - price.discountCents
  const rateBasisPoints = account.billing.taxRegion === 'CA' ? 825 : 700

  return right({
    rateBasisPoints,
    taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10_000),
  })
}

function getPaymentMethod(
  userId: string,
): Either<'PaymentMissing', PaymentMethod> {
  return userId === USER_ID ? right(PAYMENT_METHOD) : left('PaymentMissing')
}

function assessRisk(
  user: User,
  account: Account,
  cart: Cart,
  payment: PaymentMethod,
): Either<'RiskUnavailable', RiskDecision> {
  return right({
    score:
      (user.active ? 5 : 90) +
      (account.plan.tier === 'pro' ? 3 : 15) +
      (payment.risk.verified ? 0 : 25) +
      cart.items.length,
    reasons: payment.risk.verified ? [] : ['unverified-payment'],
  })
}

function persistOrder(
  user: User,
  reservation: Reservation,
  price: PriceBreakdown,
  tax: TaxQuote,
): Either<'OrderWriteFailed', OrderReceipt> {
  return right({
    id: `order-${user.id}-${reservation.lines.length}`,
    totalCents:
      price.subtotalCents +
      price.shippingCents -
      price.discountCents +
      tax.taxCents,
  })
}

function buildFulfillment(
  cart: Cart,
  account: Account,
): Either<
  | 'InventoryUnavailable'
  | 'PricingUnavailable'
  | 'LimitExceeded'
  | 'TaxUnavailable',
  Fulfillment
> {
  return either(function* (raise) {
    const reservation = yield* reserveInventory(cart)
    const price = yield* priceCart(cart, account)
    if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
      return raise('LimitExceeded' as const)
    }
    const tax = yield* quoteTax(price, account)

    return { reservation, price, tax }
  })
}

async function fetchUser(id: string): Promise<Either<'UserNotFound', User>> {
  return getUser(id)
}

async function fetchOrders(
  userId: string,
): Promise<Either<'DbError', readonly Order[]>> {
  return getOrders(userId)
}

function brGetUser(id: string): Result<User, 'UserNotFound'> {
  const user = USERS[id]
  return user === undefined ? Result.err('UserNotFound') : Result.ok(user)
}

function brGetOrders(userId: string): Result<readonly Order[], 'DbError'> {
  return Result.ok(ORDERS[userId] ?? [])
}

function brGetSession(id: string): Result<Session, 'SessionExpired'> {
  return id === 'session-1' ? Result.ok(SESSION) : Result.err('SessionExpired')
}

function brGetAccount(userId: string): Result<Account, 'AccountMissing'> {
  return userId === ACCOUNT.userId
    ? Result.ok(ACCOUNT)
    : Result.err('AccountMissing')
}

function brGetCart(userId: string): Result<Cart, 'CartMissing'> {
  return userId === CART.userId ? Result.ok(CART) : Result.err('CartMissing')
}

function brReserveInventory(
  cart: Cart,
): Result<Reservation, 'InventoryUnavailable'> {
  return cart.items.length > 0
    ? Result.ok({
        id: 'reservation-1',
        lines: cart.items.map((item) => ({
          sku: item.sku,
          qty: item.qty,
          warehouse: {
            id:
              item.metadata.category === 'device'
                ? 'warehouse-b'
                : 'warehouse-a',
            zone: item.metadata.grams > 500 ? 'heavy' : 'standard',
          },
        })),
      })
    : Result.err('InventoryUnavailable')
}

function brPriceCart(
  cart: Cart,
  account: Account,
): Result<PriceBreakdown, 'PricingUnavailable'> {
  let subtotalCents = 0
  for (const item of cart.items) subtotalCents += item.qty * item.unitCents

  return Result.ok({
    subtotalCents,
    shippingCents: cart.shipping.country === 'US' ? 799 : 1_499,
    discountCents: account.plan.tier === 'pro' ? 500 : 0,
  })
}

function brQuoteTax(
  price: PriceBreakdown,
  account: Account,
): Result<TaxQuote, 'TaxUnavailable'> {
  const taxableCents =
    price.subtotalCents + price.shippingCents - price.discountCents
  const rateBasisPoints = account.billing.taxRegion === 'CA' ? 825 : 700

  return Result.ok({
    rateBasisPoints,
    taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10_000),
  })
}

function brGetPaymentMethod(
  userId: string,
): Result<PaymentMethod, 'PaymentMissing'> {
  return userId === USER_ID
    ? Result.ok(PAYMENT_METHOD)
    : Result.err('PaymentMissing')
}

function brAssessRisk(
  user: User,
  account: Account,
  cart: Cart,
  payment: PaymentMethod,
): Result<RiskDecision, 'RiskUnavailable'> {
  return Result.ok({
    score:
      (user.active ? 5 : 90) +
      (account.plan.tier === 'pro' ? 3 : 15) +
      (payment.risk.verified ? 0 : 25) +
      cart.items.length,
    reasons: payment.risk.verified ? [] : ['unverified-payment'],
  })
}

function brPersistOrder(
  user: User,
  reservation: Reservation,
  price: PriceBreakdown,
  tax: TaxQuote,
): Result<OrderReceipt, 'OrderWriteFailed'> {
  return Result.ok({
    id: `order-${user.id}-${reservation.lines.length}`,
    totalCents:
      price.subtotalCents +
      price.shippingCents -
      price.discountCents +
      tax.taxCents,
  })
}

function brBuildFulfillment(
  cart: Cart,
  account: Account,
): Result<
  Fulfillment,
  | 'InventoryUnavailable'
  | 'PricingUnavailable'
  | 'LimitExceeded'
  | 'TaxUnavailable'
> {
  return Result.gen(function* () {
    const reservation = yield* brReserveInventory(cart)
    const price = yield* brPriceCart(cart, account)
    if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
      return Result.err('LimitExceeded' as const)
    }
    const tax = yield* brQuoteTax(price, account)

    return Result.ok({ reservation, price, tax })
  })
}

async function brFetchUser(id: string): Promise<Result<User, 'UserNotFound'>> {
  return brGetUser(id)
}

async function brFetchOrders(
  userId: string,
): Promise<Result<readonly Order[], 'DbError'>> {
  return brGetOrders(userId)
}

function getUserOrThrow(id: string): User {
  const user = USERS[id]
  if (user === undefined) throw new Error('UserNotFound')
  return user
}

function getOrdersOrThrow(userId: string): readonly Order[] {
  return ORDERS[userId] ?? []
}

function getSessionOrThrow(id: string): Session {
  if (id !== 'session-1') throw new Error('SessionExpired')
  return SESSION
}

function getAccountOrThrow(userId: string): Account {
  if (userId !== ACCOUNT.userId) throw new Error('AccountMissing')
  return ACCOUNT
}

function getCartOrThrow(userId: string): Cart {
  if (userId !== CART.userId) throw new Error('CartMissing')
  return CART
}

function reserveInventoryOrThrow(cart: Cart): Reservation {
  if (cart.items.length === 0) throw new Error('InventoryUnavailable')
  return {
    id: 'reservation-1',
    lines: cart.items.map((item) => ({
      sku: item.sku,
      qty: item.qty,
      warehouse: {
        id: item.metadata.category === 'device' ? 'warehouse-b' : 'warehouse-a',
        zone: item.metadata.grams > 500 ? 'heavy' : 'standard',
      },
    })),
  }
}

function priceCartOrThrow(cart: Cart, account: Account): PriceBreakdown {
  let subtotalCents = 0
  for (const item of cart.items) subtotalCents += item.qty * item.unitCents

  return {
    subtotalCents,
    shippingCents: cart.shipping.country === 'US' ? 799 : 1_499,
    discountCents: account.plan.tier === 'pro' ? 500 : 0,
  }
}

function quoteTaxOrThrow(price: PriceBreakdown, account: Account): TaxQuote {
  const taxableCents =
    price.subtotalCents + price.shippingCents - price.discountCents
  const rateBasisPoints = account.billing.taxRegion === 'CA' ? 825 : 700

  return {
    rateBasisPoints,
    taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10_000),
  }
}

function getPaymentMethodOrThrow(userId: string): PaymentMethod {
  if (userId !== USER_ID) throw new Error('PaymentMissing')
  return PAYMENT_METHOD
}

function assessRiskOrThrow(
  user: User,
  account: Account,
  cart: Cart,
  payment: PaymentMethod,
): RiskDecision {
  return {
    score:
      (user.active ? 5 : 90) +
      (account.plan.tier === 'pro' ? 3 : 15) +
      (payment.risk.verified ? 0 : 25) +
      cart.items.length,
    reasons: payment.risk.verified ? [] : ['unverified-payment'],
  }
}

function persistOrderOrThrow(
  user: User,
  reservation: Reservation,
  price: PriceBreakdown,
  tax: TaxQuote,
): OrderReceipt {
  return {
    id: `order-${user.id}-${reservation.lines.length}`,
    totalCents:
      price.subtotalCents +
      price.shippingCents -
      price.discountCents +
      tax.taxCents,
  }
}

function buildFulfillmentOrThrow(cart: Cart, account: Account): Fulfillment {
  const reservation = reserveInventoryOrThrow(cart)
  const price = priceCartOrThrow(cart, account)
  if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
    throw new Error('LimitExceeded')
  }
  const tax = quoteTaxOrThrow(price, account)
  return { reservation, price, tax }
}

async function fetchUserOrThrow(id: string): Promise<User> {
  return getUserOrThrow(id)
}

async function fetchOrdersOrThrow(userId: string): Promise<readonly Order[]> {
  return getOrdersOrThrow(userId)
}

async function parseNdjsonStream(
  chunks: readonly Uint8Array[],
): Promise<{ readonly count: number; readonly sum: number }> {
  let carry = ''
  let count = 0
  let sum = 0

  for await (const chunk of asyncValues(chunks)) {
    carry += decoder.decode(chunk)
    let newline = carry.indexOf('\n')
    while (newline !== -1) {
      const line = stripTrailingCr(carry.slice(0, newline))
      carry = carry.slice(newline + 1)
      if (line.length > 0) {
        const event = JSON.parse(line) as { readonly id: number }
        count++
        sum += event.id
      }
      newline = carry.indexOf('\n')
    }
  }

  if (carry.length > 0) {
    const event = JSON.parse(stripTrailingCr(carry)) as { readonly id: number }
    count++
    sum += event.id
  }

  return { count, sum }
}

async function* asyncValues<T>(
  values: readonly T[],
): AsyncGenerator<T, void, unknown> {
  for (let index = 0; index < values.length; index++) {
    yield values[index] as T
  }
}

function checkoutPayload(
  session: Session,
  user: User,
  account: Account,
  cart: Cart,
  fulfillment: Fulfillment,
  payment: PaymentMethod,
  risk: RiskDecision,
  receipt: OrderReceipt,
): {
  readonly receipt: OrderReceipt
  readonly customer: {
    readonly id: string
    readonly tenant: string
    readonly account: { readonly id: string; readonly tier: 'free' | 'pro' }
  }
  readonly checkout: {
    readonly cart: { readonly id: string; readonly itemCount: number }
    readonly fulfillment: Fulfillment
    readonly payment: {
      readonly id: string
      readonly network: 'visa' | 'mastercard'
      readonly riskScore: number
    }
  }
} {
  return {
    receipt,
    customer: {
      id: user.id,
      tenant: session.tenant.id,
      account: { id: account.id, tier: account.plan.tier },
    },
    checkout: {
      cart: { id: cart.id, itemCount: cart.items.length },
      fulfillment,
      payment: {
        id: payment.id,
        network: payment.network,
        riskScore: risk.score,
      },
    },
  }
}

function stripTrailingCr(input: string): string {
  return input.endsWith('\r') ? input.slice(0, -1) : input
}

function chunkText(input: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < input.length; index += size) {
    chunks.push(input.slice(index, index + size))
  }
  return chunks
}

function bit(index: number): 0 | 1 {
  return (index & 1) as 0 | 1
}

function indexer(): () => number {
  let index = 0
  return () => index++
}

function moduleUrl(code: string): string {
  return `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
}

async function importBenchModule(
  code: string,
): Promise<BenchModule & StreamBenchModule> {
  return (await import(moduleUrl(code))) as BenchModule & StreamBenchModule
}

async function transformWithPlugin(code: string): Promise<string> {
  const plugin = yeet.raw({
    moduleNames: [YEET_SOURCE],
    streamModuleNames: [STREAM_SOURCE],
  }) as RawPlugin
  const handler = plugin.transform?.handler
  if (handler === undefined) {
    throw new TypeError('yeet.raw() did not expose a transform handler')
  }

  const result = await handler(code, FIXTURE_ID)
  if (result === null) {
    throw new Error('yeet unplugin did not transform the overhead fixture')
  }

  return typeof result === 'string' ? result : result.code
}

function readPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
}
