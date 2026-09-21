/**
 * InfinitePay "Checkout Integrado" REST helpers — platform billing
 * (charging tenants for their Zontalk subscription). Not to be
 * confused with `src/lib/payments/mercadopago-api.ts`, which is the
 * gateway tenants use to charge THEIR OWN delivery customers.
 *
 * Thin wrapper, same shape as `mercadopago-api.ts`/`wuzapi-api.ts`:
 * named-args per function, no SDK dependency.
 *
 * Unlike Mercado Pago, InfinitePay documents no webhook signature
 * scheme at all — `checkPayment` (POST /payment_check) is therefore
 * the ONLY trustworthy source of payment status. Every call site in
 * this codebase must treat an incoming webhook body as a bare "check
 * again" hint, never as authoritative data (see
 * `src/lib/billing/invoices.ts`'s `reconcileInvoice`).
 *
 * Docs: https://ajuda.infinitepay.io (no formal API reference site as
 * of writing — endpoint shapes below are as documented in the
 * Checkout Integrado help article).
 */

const CHECKOUT_API_BASE = 'https://api.checkout.infinitepay.io'

async function checkoutRequest<T>(args: {
  path: string
  body: unknown
}): Promise<T> {
  const { path, body } = args
  const response = await fetch(`${CHECKOUT_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  let json: unknown
  try {
    json = await response.json()
  } catch {
    json = null
  }

  if (!response.ok) {
    const message =
      (json as { message?: string } | null)?.message ?? `InfinitePay error: ${response.status}`
    throw new Error(message)
  }

  return json as T
}

export interface CreatePaymentLinkArgs {
  handle: string
  /** Our own invoice id, sent as `order_nsu`. Never reuse across a
   *  regenerated link — see the `checkout_order_nsu` suffix scheme in
   *  invoices.ts. */
  orderNsu: string
  amountCents: number
  description: string
  redirectUrl: string
  webhookUrl: string
}

export interface CreatePaymentLinkResult {
  url: string
}

interface InfinitePayLinkResponse {
  url: string
}

export async function createPaymentLink(
  args: CreatePaymentLinkArgs,
): Promise<CreatePaymentLinkResult> {
  const { handle, orderNsu, amountCents, description, redirectUrl, webhookUrl } = args
  const data = await checkoutRequest<InfinitePayLinkResponse>({
    path: '/links',
    body: {
      handle,
      order_nsu: orderNsu,
      redirect_url: redirectUrl,
      webhook_url: webhookUrl,
      items: [{ quantity: 1, price: amountCents, description }],
    },
  })
  return { url: data.url }
}

export interface CheckPaymentArgs {
  orderNsu: string
  /** Defaults to the platform's INFINITEPAY_HANDLE. */
  handle?: string
}

export interface CheckPaymentResult {
  paid: boolean
  paidAmountCents: number
}

interface InfinitePayCheckResponse {
  success?: boolean
  paid?: boolean
  paid_amount?: number
  amount?: number
}

/**
 * Polls InfinitePay's own record for a payment link, independent of
 * whether a webhook ever arrived.
 *
 * The `handle` is REQUIRED by InfinitePay's /payment_check: without it
 * the API answers 404 "Not found" for every order, paid or not
 * (confirmed live 2026-09-21 — the cron's reconcile phase failed on
 * every run for that reason, and since the throw aborted the whole
 * cron, later billing phases never ran either). With the handle, an
 * unknown or unpaid order answers 200 `{"success":false}`, which is
 * the normal "still pending" state.
 */
export async function checkPayment(args: CheckPaymentArgs): Promise<CheckPaymentResult | null> {
  const { orderNsu, handle = getInfinitePayHandle() } = args
  const data = await checkoutRequest<InfinitePayCheckResponse>({
    path: '/payment_check',
    body: { handle, order_nsu: orderNsu },
  })
  if (!data.paid) return { paid: false, paidAmountCents: 0 }
  return { paid: true, paidAmountCents: data.paid_amount ?? data.amount ?? 0 }
}

/** Reads the platform's own InfinitePay handle from env — only at
 *  call time, so importing this module never breaks a build/test
 *  that doesn't touch billing (same discipline as
 *  `providers/openrouteservice.ts`'s `ORS_API_KEY` read). */
export function getInfinitePayHandle(): string {
  const handle = process.env.INFINITEPAY_HANDLE
  if (!handle) throw new Error('INFINITEPAY_HANDLE is not configured')
  return handle
}
