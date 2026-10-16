import prisma from "~/db.server";
import { logger } from "./logger.server";
import { PaymentState, RefundState } from "./stateMachine.server";
import { schedulePaymentWork } from "./payments.server";
import { scheduleRefundWork } from "./refunds.server";
import { scheduleUnsupportedWork } from "./unsupported.server";

/**
 * Re-enqueues work lost when the process stopped between acknowledging
 * Shopify and finalizing (the in-process queue is not durable).
 */
export async function resumeInFlightWork() {
  const terminal = [PaymentState.RESOLVED, PaymentState.REJECTED];
  const [payments, refunds, unsupported] = await Promise.all([
    prisma.paymentSession.findMany({
      where: { OR: [{ state: { notIn: terminal } }, { outcome: { not: null }, finalizedAt: null }] },
    }),
    prisma.refundSession.findMany({ where: { OR: [{ state: RefundState.INITIATED }, { outcome: { not: null }, finalizedAt: null }] } }),
    prisma.unsupportedSession.findMany({ where: { rejectedAt: null } }),
  ]);

  payments.forEach(schedulePaymentWork);
  refunds.forEach(scheduleRefundWork);
  unsupported.forEach(scheduleUnsupportedWork);

  logger.info(
    { event: "recovery.resumed", payments: payments.length, refunds: refunds.length, unsupported: unsupported.length },
    "resumed in-flight sessions",
  );
}
