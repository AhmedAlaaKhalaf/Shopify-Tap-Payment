import { completeChallenge, getChallenge, NotFoundError } from "~/services/payments.server";
import { logger } from "~/services/logger.server";

/**
 * MOCK 3-D Secure ACS page. Shopify renders this URL (sent with
 * paymentSessionRedirect) in an iframe in checkout. A real integration would
 * hand off to the issuer's ACS / 3DS server instead.
 */

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, body, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:420px;margin:32px auto;padding:0 16px}button{padding:10px 16px;margin-right:8px}</style>
</head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

/** Shopify requires navigating the parent browsing context, not window.top. */
function returnToShopify(redirectUrl, message) {
  if (!redirectUrl) return page("Done", `<p>${escapeHtml(message)}</p><p>You can close this window.</p>`);
  const target = JSON.stringify(redirectUrl).replace(/</g, "\\u003c");
  return page(
    "Returning to checkout",
    `<p>${escapeHtml(message)}</p><p><a id="return" href="${escapeHtml(redirectUrl)}" target="_parent">Return to checkout</a></p>
<script>window.parent.location.href = ${target};</script>`,
  );
}

export const loader = async ({ params }) => {
  const challenge = await getChallenge(params.token);
  if (!challenge) return page("Not found", "<p>Unknown or expired authentication request.</p>", 404);

  const s = challenge.paymentSession;
  if (challenge.status !== "PENDING") return returnToShopify(s.buyerReturnUrl, "This authentication is already complete.");

  return page(
    "Verify your payment",
    `<h1>Verify your payment</h1>
<p>Mock issuer authentication (3-D Secure 2.2).</p>
<p><strong>${escapeHtml(s.amount)} ${escapeHtml(s.currency)}</strong> · ${escapeHtml(s.cardBrand ?? "card")} ending ${escapeHtml(s.cardLast4 ?? "••••")}</p>
<form method="post">
  <button name="intent" value="pass" type="submit">Authenticate</button>
  <button name="intent" value="fail" type="submit">Fail authentication</button>
</form>`,
  );
};

export const action = async ({ request, params }) => {
  const form = await request.formData();
  const passed = form.get("intent") === "pass";

  try {
    const result = await completeChallenge(params.token, passed);
    const message =
      result.status === "confirming" ? "Authentication successful." : passed ? "Payment could not be completed." : "Authentication failed.";
    return returnToShopify(result.redirectUrl, message);
  } catch (err) {
    if (err instanceof NotFoundError) return page("Not found", "<p>Unknown authentication request.</p>", 404);
    logger.error({ event: "3ds.failed", err }, "3DS completion failed");
    return page("Error", "<p>Something went wrong. Please return to checkout and try again.</p>", 500);
  }
};
