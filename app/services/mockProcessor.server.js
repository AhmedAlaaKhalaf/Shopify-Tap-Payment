import { randomUUID } from "node:crypto";

/**
 * MOCK card processor. Nothing here touches a real network.
 *
 * Outcomes are driven by the card's last 4 digits, or by the customer's
 * billing family name when the card cannot be decrypted (a real Shopify
 * payload encrypted with a certificate we do not hold).
 */

export const STUB_FINGERPRINT = "stub-local-dev";

export const Scenario = Object.freeze({
  APPROVE: "approve",
  DECLINE: "decline",
  CHALLENGE: "challenge",
  ERROR: "error",
});

const CARD_RULES = {
  "4242": { type: Scenario.APPROVE },
  "4444": { type: Scenario.APPROVE },
  "0002": { type: Scenario.DECLINE, code: "CARD_DECLINED", message: "Card declined by issuer" },
  "0069": { type: Scenario.DECLINE, code: "EXPIRED_CARD", message: "Card expired" },
  "0127": { type: Scenario.DECLINE, code: "INCORRECT_CVC", message: "CVC check failed" },
  "3220": { type: Scenario.CHALLENGE },
  "0119": { type: Scenario.ERROR },
};

const NAME_RULES = {
  decline: CARD_RULES["0002"],
  "3ds": CARD_RULES["3220"],
  error: CARD_RULES["0119"],
};

export class CardDecryptionError extends Error {}
export class ProcessorError extends Error {}

/**
 * STUB for Shopify's ECIES card decryption. The real implementation runs in a
 * PCI DSS environment:
 *   1. base64-decode `encrypted_message` and `tag`
 *   2. pick the certificate private key matching `fingerprint`
 *   3. ECDH(private key, `ephemeral_public_key`) -> shared secret -> KDF
 *   4. verify HMAC(encrypted_message) === tag
 *   5. decrypt encrypted_message
 * Here, only payloads produced by the local simulator (fingerprint
 * STUB_FINGERPRINT, base64 JSON) can be "decrypted".
 */
export function decryptCard(paymentMethod) {
  const data = paymentMethod?.data;
  if (paymentMethod?.type !== "credit_card" || !data?.encrypted_message) {
    throw new CardDecryptionError("payment_method is not an encrypted credit card");
  }

  if (data.fingerprint !== STUB_FINGERPRINT) {
    return { pan: null, last4: null, brand: null, decrypted: false };
  }

  let card;
  try {
    card = JSON.parse(Buffer.from(data.encrypted_message, "base64").toString("utf8"));
  } catch (err) {
    throw new CardDecryptionError("encrypted_message could not be decoded", { cause: err });
  }

  const pan = String(card.number ?? "").replace(/\s+/g, "");
  if (!/^\d{12,19}$/.test(pan)) throw new CardDecryptionError("invalid card number");

  return {
    pan,
    last4: pan.slice(-4),
    brand: brandFor(pan),
    month: card.month,
    year: card.year,
    name: card.name,
    decrypted: true,
  };
}

function brandFor(pan) {
  if (pan.startsWith("4")) return "visa";
  if (/^(5[1-5]|2[2-7])/.test(pan)) return "master";
  return "unknown";
}

export function scenarioFor({ card, customer }) {
  if (card?.last4 && CARD_RULES[card.last4]) return CARD_RULES[card.last4];
  const familyName = customer?.billing_address?.family_name?.trim().toLowerCase();
  return NAME_RULES[familyName] ?? { type: Scenario.APPROVE };
}

export function requiresChallenge(ctx) {
  return scenarioFor(ctx).type === Scenario.CHALLENGE;
}

const latency = () => new Promise((resolve) => setTimeout(resolve, Number(process.env.MOCK_PROCESSOR_LATENCY_MS ?? 50)));

// A real processor deduplicates on the idempotency key server-side.
const authorizations = new Map();
const refunds = new Map();

export async function authorize({ idempotencyKey, card, customer, amountMinor, currency }) {
  if (authorizations.has(idempotencyKey)) return authorizations.get(idempotencyKey);
  await latency();

  const scenario = scenarioFor({ card, customer });
  if (scenario.type === Scenario.ERROR) throw new ProcessorError("processor unavailable (simulated)");

  const result =
    scenario.type === Scenario.DECLINE
      ? { approved: false, code: scenario.code, message: scenario.message }
      : {
          approved: true,
          processorRef: `mock_chg_${randomUUID()}`,
          networkTransactionId: `mock_ntid_${randomUUID().slice(0, 12)}`,
          amountMinor,
          currency,
        };

  authorizations.set(idempotencyKey, result);
  return result;
}

export async function refund({ idempotencyKey, processorRef, amount }) {
  if (refunds.has(idempotencyKey)) return refunds.get(idempotencyKey);
  await latency();

  const result = String(amount).endsWith(".99")
    ? { ok: false, message: "Refund declined by processor (simulated .99 trigger)" }
    : { ok: true, refundRef: `mock_ref_${randomUUID()}`, processorRef };

  refunds.set(idempotencyKey, result);
  return result;
}

export function resetMockProcessor() {
  authorizations.clear();
  refunds.clear();
}
