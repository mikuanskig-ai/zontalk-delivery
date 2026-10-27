// ============================================================
// Cloud-side print queue — enqueues a print_jobs row per order when
// an account has opted in (print_configs.enabled), and bumps the
// "agent last seen" indicator whenever any valid API key polls for
// jobs. The local agent that actually talks to a physical thermal
// printer is a separate, not-yet-built consumer of
// GET/POST /api/v1/print-jobs*.
//
// Both functions build their own supabaseAdmin() rather than take a
// `db` parameter — mirrors runAutomationsForTrigger
// (src/lib/automations/engine.ts), the precedent for this class of
// side effect (fire-alongside-the-order, cross-cutting, not a direct
// dependency of order-creation itself). Only 1 of finalizeDeliveryOrder's
// 4 callers passes a non-admin session client; forcing print_jobs
// writes to also work under that client's RLS would mean opening
// write policies to the `agent` role for no real benefit, and other
// code in this app (dispatchWebhookEvent's `db`-reused update) shows
// that pattern already causes a silent under-RLS no-op bug elsewhere.
//
// The local agent that consumes this queue lives in `print-agent/`
// at the repo root (standalone Windows .exe, own build pipeline —
// see print-agent/README.md).
// ============================================================

import { supabaseAdmin } from '@/lib/payments/admin-client';
import type { SalaoTicket } from '@/lib/salao/tickets';

const RETRY_BACKOFF_SECONDS = 60;
const MAX_ATTEMPTS = 3;

/**
 * Inserts a print_jobs row for a newly-created order, if the account
 * has print_configs.enabled. Never throws — a failure here must never
 * block order creation, same contract as the Mercado Pago preference
 * block in create-order.ts.
 */
export async function enqueuePrintJob(accountId: string, orderId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: config } = await db
      .from('print_configs')
      .select('enabled')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config?.enabled) return;

    const { error } = await db.from('print_jobs').insert({
      account_id: accountId,
      order_id: orderId,
    });
    if (error) {
      console.error('[print-queue] failed to enqueue print job:', error.message);
    }
  } catch (err) {
    console.error('[print-queue] failed to enqueue print job:', err);
  }
}

/**
 * Call right after an order is cancelled. If the kitchen already has
 * a physical ticket for it (a print_jobs row reached `printed` before
 * the cancel), enqueue a fresh job so a follow-up ticket — clearly
 * marked CANCELADO by both the print-agent's receipt renderer and the
 * browser reprint page, which check `receipt.status`/`order.status`
 * — goes out too. Paper already in the kitchen's hands can't be
 * recalled; a corrected ticket is the only way to reach it.
 *
 * A job that never printed (still `pending` when cancelled) does NOT
 * need this: GET /api/v1/print-jobs already self-heals that case —
 * it marks a pending job whose order is now cancelled as `skipped`
 * instead of serving it to the agent (see that route's own comment).
 * Nothing was ever physically printed for it, so there's nothing to
 * correct. Same for `failed`.
 *
 * Confirmed live (2026-08-31, Churrascaria Concórdia): the AI
 * duplicated an order (a customer's unrelated follow-up message
 * triggered a second place_order for the same items). Whichever one
 * got cancelled afterward — via cancel_order or a staff member's
 * manual PATCH — had already printed by then, and the kitchen had no
 * way to tell the two identical tickets apart. They prepared food for
 * both.
 */
export async function notifyOrderCancellation(accountId: string, orderId: string): Promise<void> {
  try {
    const db = supabaseAdmin();
    const { data: printedJob } = await db
      .from('print_jobs')
      .select('id')
      .eq('order_id', orderId)
      .eq('status', 'printed')
      .limit(1)
      .maybeSingle();
    if (!printedJob) return;

    await enqueuePrintJob(accountId, orderId);
  } catch (err) {
    console.error('[print-queue] failed to enqueue cancellation notice:', err);
  }
}

/**
 * Enfileira um ticket do módulo Salão (rodada da mesa, cancelamento de
 * item, pré-conta, fechamento do caixa). O conteúdo (`payload`) é
 * congelado agora: diferente de um pedido de delivery, não há linha no
 * banco para o agente reler depois.
 *
 * Só imprime se a conta ligou a impressão (print_configs.enabled), igual
 * ao delivery. Nunca lança — falha de impressão não pode derrubar o
 * lançamento do garçom nem o fechamento da comanda. Devolve se o job foi
 * criado, para a tela poder dizer "enviado à cozinha" ou "impressão
 * desligada".
 */
export async function enqueueSalaoPrint(
  accountId: string,
  kind: 'salao_round' | 'salao_item_cancel' | 'salao_bill' | 'cash_report',
  target: 'cozinha' | 'caixa',
  payload: SalaoTicket,
): Promise<{ queued: boolean }> {
  try {
    const db = supabaseAdmin();
    const { data: config } = await db
      .from('print_configs')
      .select('enabled')
      .eq('account_id', accountId)
      .maybeSingle();

    if (!config?.enabled) return { queued: false };

    const { error } = await db.from('print_jobs').insert({
      account_id: accountId,
      order_id: null,
      kind,
      target,
      payload,
    });
    if (error) {
      console.error('[print-queue] failed to enqueue salao print job:', error.message);
      return { queued: false };
    }
    return { queued: true };
  } catch (err) {
    console.error('[print-queue] failed to enqueue salao print job:', err);
    return { queued: false };
  }
}

/** Fire-and-forget — mirrors touchLastUsed (src/lib/api-keys/store.ts).
 *  `caixa: true` = o agente declarou ter impressora de caixa (módulo
 *  Salão); o painel usa isso para avisar quando a pré-conta e o
 *  fechamento do caixa estão sem quem imprima. */
export function touchPrintAgentPoll(accountId: string, opts: { caixa?: boolean } = {}): void {
  const now = new Date().toISOString();
  const patch: Record<string, string> = { last_polled_at: now };
  if (opts.caixa) patch.last_polled_caixa_at = now;
  void supabaseAdmin()
    .from('print_configs')
    .update(patch)
    .eq('account_id', accountId)
    .then(({ error }) => {
      if (error) {
        console.warn('[print-queue] last_polled_at bump failed:', error.message);
      }
    });
}

/**
 * Applies a failed print attempt: increments `attempts`, and either
 * schedules a backed-off retry (still `pending`) or, past
 * MAX_ATTEMPTS, marks the job terminally `failed`. Pure computation —
 * the caller performs the actual DB update with the returned patch.
 */
export function nextFailureState(
  attempts: number,
  errorMessage: string | null,
): { status: 'pending' | 'failed'; attempts: number; next_attempt_at: string | null; error: string | null } {
  const nextAttempts = attempts + 1;
  if (nextAttempts >= MAX_ATTEMPTS) {
    return { status: 'failed', attempts: nextAttempts, next_attempt_at: null, error: errorMessage };
  }
  const nextAttemptAt = new Date(Date.now() + nextAttempts * RETRY_BACKOFF_SECONDS * 1000);
  return {
    status: 'pending',
    attempts: nextAttempts,
    next_attempt_at: nextAttemptAt.toISOString(),
    error: errorMessage,
  };
}
