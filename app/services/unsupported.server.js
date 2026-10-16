import prisma from "~/db.server";
import { logger } from "./logger.server";
import { clientForShop } from "./shopAuth.server";
import { enqueue } from "./jobs.server";
import { InvalidRequestError } from "./payments.server";

const MESSAGE = {
  capture: "Manual capture is not supported by this payments app. Payments are processed as sales; use refunds.",
  void: "Voids are not supported by this payments app. Use a refund instead.",
};

/**
 * The credit card target requires capture and void URLs. This case study
 * implements refund only, so capture/void sessions are acknowledged (201)
 * and rejected once with PROCESSING_ERROR.
 */
export async function receiveUnsupportedSession(kind, body, { shop, requestId }) {
  if (!body?.id || !body?.gid || !body?.payment_id) throw new InvalidRequestError("id, gid and payment_id are required");

  const session = await prisma.unsupportedSession.upsert({
    where: { id: body.id },
    create: { id: body.id, gid: body.gid, kind, shop, paymentId: body.payment_id },
    update: {},
  });
  logger.info({ event: `${kind}.received`, sessionId: session.id, paymentId: session.paymentId, shop, requestId }, `${kind} session received`);
  return session;
}

export function scheduleUnsupportedWork(session) {
  if (session.rejectedAt) return undefined;
  return enqueue(`${session.kind}:${session.id}`, () => rejectUnsupported(session.id));
}

async function rejectUnsupported(id) {
  const s = await prisma.unsupportedSession.findUnique({ where: { id } });
  if (!s || s.rejectedAt) return;

  const client = await clientForShop(s.shop);
  const reason = { code: "PROCESSING_ERROR", merchantMessage: MESSAGE[s.kind] };
  const { userErrors } = s.kind === "capture" ? await client.rejectCapture(s.gid, reason) : await client.rejectVoid(s.gid, reason);

  await prisma.unsupportedSession.update({
    where: { id },
    data: userErrors.length ? { lastError: JSON.stringify(userErrors) } : { rejectedAt: new Date(), lastError: null },
  });
  logger.info({ event: `${s.kind}.rejected`, sessionId: id, userErrors }, `${s.kind} session rejected (unsupported)`);
}
