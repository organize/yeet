import { Result } from 'better-result'
/**
 * Head-to-head benchmarks: yeet vs the installed better-result version
 *
 * Mirrors the either scenarios from index.bench.ts as closely as the two
 * APIs allow:
 *
 *   yeet          │ better-result
 *   ──────────────┼──────────────────────────────────────────────────
 *   right(v)      │ Result.ok(v)
 *   left(e)       │ Result.err(e)
 *   either(fn*)   │ Result.gen(fn*)  — must return Result.ok/err
 *
 * validate / firstOf have no equivalents in better-result and are omitted.
 * collect vs Result.partition is apples-to-oranges (generator vs plain array)
 * and is also omitted.
 */
import { bench, describe } from 'vitest'

import { either } from '../src/combinators.js'
import { left, right, type Either } from '../src/either.js'
import { BENCH_OPTS } from './bench-options.js'

type User = { id: string; name: string; active: boolean }
type Order = { id: string; userId: string }
type Session = {
  id: string
  userId: string
  tenant: { id: string; region: 'us' | 'eu'; flags: { checkoutV2: boolean } }
}
type Account = {
  id: string
  userId: string
  status: 'active' | 'suspended'
  plan: { tier: 'free' | 'pro'; limits: { maxOrderValueCents: number } }
  billing: { currency: 'USD' | 'EUR'; taxRegion: 'CA' | 'NY' }
}
type CartItem = {
  sku: string
  qty: number
  unitCents: number
  metadata: { category: 'book' | 'device'; grams: number }
}
type Cart = {
  id: string
  userId: string
  items: CartItem[]
  shipping: { country: 'US' | 'DE'; postalCode: string }
}
type Reservation = {
  id: string
  lines: Array<{
    sku: string
    qty: number
    warehouse: { id: string; zone: string }
  }>
}
type PriceBreakdown = {
  subtotalCents: number
  shippingCents: number
  discountCents: number
}
type TaxQuote = { rateBasisPoints: number; taxCents: number }
type PaymentMethod = {
  id: string
  network: 'visa' | 'mastercard'
  risk: { fingerprint: string; verified: boolean }
}
type RiskDecision = { score: number; reasons: string[] }
type OrderReceipt = { id: string; totalCents: number }

const USER: User = { id: '1', name: 'Axel', active: true }
const ORDERS: Order[] = [{ id: 'order-1', userId: '1' }]
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

// yeet helpers
const getUser = (id: string): Either<'UserNotFound', User> =>
  id === '1' ? right(USER) : left('UserNotFound')

const getOrders = (_userId: string): Either<'DbError', Order[]> => right(ORDERS)

const getSession = (id: string): Either<'SessionExpired', Session> =>
  id === 'session-1' ? right(SESSION) : left('SessionExpired')

const getAccount = (userId: string): Either<'AccountMissing', Account> =>
  userId === ACCOUNT.userId ? right(ACCOUNT) : left('AccountMissing')

const getCart = (userId: string): Either<'CartMissing', Cart> =>
  userId === CART.userId ? right(CART) : left('CartMissing')

const reserveInventory = (
  cart: Cart,
): Either<'InventoryUnavailable', Reservation> =>
  cart.items.length > 0
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

const priceCart = (
  cart: Cart,
  account: Account,
): Either<'PricingUnavailable', PriceBreakdown> => {
  let subtotalCents = 0
  for (const item of cart.items) subtotalCents += item.qty * item.unitCents

  return right({
    subtotalCents,
    shippingCents: cart.shipping.country === 'US' ? 799 : 1_499,
    discountCents: account.plan.tier === 'pro' ? 500 : 0,
  })
}

const quoteTax = (
  price: PriceBreakdown,
  account: Account,
): Either<'TaxUnavailable', TaxQuote> => {
  const taxableCents =
    price.subtotalCents + price.shippingCents - price.discountCents
  const rateBasisPoints = account.billing.taxRegion === 'CA' ? 825 : 700

  return right({
    rateBasisPoints,
    taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10_000),
  })
}

const getPaymentMethod = (
  userId: string,
): Either<'PaymentMissing', PaymentMethod> =>
  userId === USER.id ? right(PAYMENT_METHOD) : left('PaymentMissing')

const assessRisk = (
  user: User,
  account: Account,
  cart: Cart,
  payment: PaymentMethod,
): Either<'RiskUnavailable', RiskDecision> =>
  right({
    score:
      (user.active ? 5 : 90) +
      (account.plan.tier === 'pro' ? 3 : 15) +
      (payment.risk.verified ? 0 : 25) +
      cart.items.length,
    reasons: payment.risk.verified ? [] : ['unverified-payment'],
  })

const persistOrder = (
  user: User,
  reservation: Reservation,
  price: PriceBreakdown,
  tax: TaxQuote,
): Either<'OrderWriteFailed', OrderReceipt> =>
  right({
    id: `order-${user.id}-${reservation.lines.length}`,
    totalCents:
      price.subtotalCents +
      price.shippingCents -
      price.discountCents +
      tax.taxCents,
  })

const buildFulfillment = (cart: Cart, account: Account) =>
  either(function* (raise) {
    const reservation = yield* reserveInventory(cart)
    const price = yield* priceCart(cart, account)
    if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
      yield* raise('LimitExceeded' as const)
    }
    const tax = yield* quoteTax(price, account)

    return { reservation, price, tax }
  })

const runCheckout = () =>
  either(function* (raise) {
    const session = yield* getSession('session-1')
    if (!session.tenant.flags.checkoutV2)
      yield* raise('CheckoutDisabled' as const)

    const user = yield* getUser(session.userId)
    if (!user.active) yield* raise('Inactive' as const)

    const account = yield* getAccount(user.id)
    if (account.status !== 'active') yield* raise('AccountSuspended' as const)

    const cart = yield* getCart(user.id)
    const fulfillment = yield* buildFulfillment(cart, account)
    const payment = yield* getPaymentMethod(user.id)
    const risk = yield* assessRisk(user, account, cart, payment)
    if (risk.score > 80) yield* raise('RiskRejected' as const)

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

// better-result helpers
const brGetUser = (id: string) =>
  id === '1' ? Result.ok(USER) : Result.err('UserNotFound' as const)

const brGetOrders = (_userId: string) => Result.ok(ORDERS)

const brGetSession = (id: string) =>
  id === 'session-1'
    ? Result.ok(SESSION)
    : Result.err('SessionExpired' as const)

const brGetAccount = (userId: string) =>
  userId === ACCOUNT.userId
    ? Result.ok(ACCOUNT)
    : Result.err('AccountMissing' as const)

const brGetCart = (userId: string) =>
  userId === CART.userId ? Result.ok(CART) : Result.err('CartMissing' as const)

const brReserveInventory = (cart: Cart) =>
  cart.items.length > 0
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
    : Result.err('InventoryUnavailable' as const)

const brPriceCart = (cart: Cart, account: Account) => {
  let subtotalCents = 0
  for (const item of cart.items) subtotalCents += item.qty * item.unitCents

  return Result.ok({
    subtotalCents,
    shippingCents: cart.shipping.country === 'US' ? 799 : 1_499,
    discountCents: account.plan.tier === 'pro' ? 500 : 0,
  })
}

const brQuoteTax = (price: PriceBreakdown, account: Account) => {
  const taxableCents =
    price.subtotalCents + price.shippingCents - price.discountCents
  const rateBasisPoints = account.billing.taxRegion === 'CA' ? 825 : 700

  return Result.ok({
    rateBasisPoints,
    taxCents: Math.trunc((taxableCents * rateBasisPoints) / 10_000),
  })
}

const brGetPaymentMethod = (userId: string) =>
  userId === USER.id
    ? Result.ok(PAYMENT_METHOD)
    : Result.err('PaymentMissing' as const)

const brAssessRisk = (
  user: User,
  account: Account,
  cart: Cart,
  payment: PaymentMethod,
) =>
  Result.ok({
    score:
      (user.active ? 5 : 90) +
      (account.plan.tier === 'pro' ? 3 : 15) +
      (payment.risk.verified ? 0 : 25) +
      cart.items.length,
    reasons: payment.risk.verified ? [] : ['unverified-payment'],
  })

const brPersistOrder = (
  user: User,
  reservation: Reservation,
  price: PriceBreakdown,
  tax: TaxQuote,
) =>
  Result.ok({
    id: `order-${user.id}-${reservation.lines.length}`,
    totalCents:
      price.subtotalCents +
      price.shippingCents -
      price.discountCents +
      tax.taxCents,
  })

const brBuildFulfillment = (cart: Cart, account: Account) =>
  Result.gen(function* () {
    const reservation = yield* brReserveInventory(cart)
    const price = yield* brPriceCart(cart, account)
    if (price.subtotalCents > account.plan.limits.maxOrderValueCents) {
      return Result.err('LimitExceeded' as const)
    }
    const tax = yield* brQuoteTax(price, account)

    return Result.ok({ reservation, price, tax })
  })

const brRunCheckout = () =>
  Result.gen(function* () {
    const session = yield* brGetSession('session-1')
    if (!session.tenant.flags.checkoutV2) {
      return Result.err('CheckoutDisabled' as const)
    }

    const user = yield* brGetUser(session.userId)
    if (!user.active) return Result.err('Inactive' as const)

    const account = yield* brGetAccount(user.id)
    if (account.status !== 'active')
      return Result.err('AccountSuspended' as const)

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

    return Result.ok({
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
    })
  })

describe('either — single yield, success', () => {
  bench(
    'yeet',
    () => {
      either(function* () {
        const user = yield* getUser('1')
        return user
      })
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    () => {
      Result.gen(function* () {
        const user = yield* brGetUser('1')
        return Result.ok(user)
      })
    },
    BENCH_OPTS,
  )
})

describe('either — two yields, success', () => {
  bench(
    'yeet',
    () => {
      either(function* (raise) {
        const user = yield* getUser('1')
        if (!user.active) yield* raise('Inactive' as const)
        const orders = yield* getOrders(user.id)
        return { user, first: orders[0] }
      })
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    () => {
      Result.gen(function* () {
        const user = yield* brGetUser('1')
        if (!user.active) return Result.err('Inactive' as const)
        const orders = yield* brGetOrders(user.id)
        return Result.ok({ user, first: orders[0] })
      })
    },
    BENCH_OPTS,
  )
})

describe('either — single yield, short-circuit', () => {
  bench(
    'yeet',
    () => {
      either(function* () {
        const user = yield* getUser('not-found')
        return user
      })
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    () => {
      Result.gen(function* () {
        const user = yield* brGetUser('not-found')
        return Result.ok(user)
      })
    },
    BENCH_OPTS,
  )
})

describe('either — complex nested checkout, success', () => {
  bench(
    'yeet',
    () => {
      runCheckout()
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    () => {
      brRunCheckout()
    },
    BENCH_OPTS,
  )
})

const fetchUser = async (id: string): Promise<Either<'NotFound', User>> =>
  Promise.resolve(id === '1' ? right(USER) : left('NotFound' as const))

const fetchOrders = async (): Promise<Either<'DbError', Order[]>> =>
  Promise.resolve(right(ORDERS))

const brFetchUser = async (id: string) =>
  Promise.resolve(
    id === '1' ? Result.ok(USER) : Result.err('NotFound' as const),
  )

const brFetchOrders = async () => Promise.resolve(Result.ok(ORDERS))

describe('either async — two yields, success', () => {
  bench(
    'yeet',
    async () => {
      await either(async function* (raise) {
        const user = yield* await fetchUser('1')
        const orders = yield* await fetchOrders()
        if (orders.length === 0) yield* raise('NoOrders' as const)
        return { user, orders }
      })
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    async () => {
      await Result.gen(async function* () {
        const user = yield* Result.await(brFetchUser('1'))
        const orders = yield* Result.await(brFetchOrders())
        if (orders.length === 0) return Result.err('NoOrders' as const)
        return Result.ok({ user, orders })
      })
    },
    BENCH_OPTS,
  )
})

describe('either async — single yield, short-circuit', () => {
  bench(
    'yeet',
    async () => {
      await either(async function* () {
        const user = yield* await fetchUser('not-found')
        return user
      })
    },
    BENCH_OPTS,
  )

  bench(
    'better-result',
    async () => {
      await Result.gen(async function* () {
        const user = yield* Result.await(brFetchUser('not-found'))
        return Result.ok(user)
      })
    },
    BENCH_OPTS,
  )
})
