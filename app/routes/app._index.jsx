import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { getShopify } from "~/shopify.server";
import { createPaymentsAppsClient } from "~/services/paymentsAppsClient.server";
import { logger } from "~/services/logger.server";

/**
 * Merchant onboarding: the only admin surface. It marks the payments app as
 * ready on the shop with paymentsAppConfigure. A full merchant UI is out of scope.
 */
export const loader = async ({ request }) => {
  const { session } = await getShopify().authenticate.admin(request);
  return json({ shop: session.shop, apiKey: process.env.SHOPIFY_API_KEY });
};

export const action = async ({ request }) => {
  const { session } = await getShopify().authenticate.admin(request);
  const form = await request.formData();
  const externalHandle = String(form.get("externalHandle") || "").trim();

  if (!externalHandle) return json({ ok: false, errors: [{ message: "Account name is required." }] });

  const client = createPaymentsAppsClient({ shop: session.shop, accessToken: session.accessToken });
  const { userErrors } = await client.configure({ externalHandle, ready: true });

  logger.info({ event: "payments_app.configured", shop: session.shop, externalHandle, userErrors }, "paymentsAppConfigure");
  return json({ ok: userErrors.length === 0, errors: userErrors });
};

export default function Onboarding() {
  const { shop, apiKey } = useLoaderData();
  const result = useActionData();

  return (
    <main>
      <h1>Tap Credit Card</h1>
      <p>
        Connect <strong>{shop}</strong> to your processor account. This calls{" "}
        <code>paymentsAppConfigure(ready: true)</code>.
      </p>
      <Form method="post">
        <label>
          Account name{" "}
          <input name="externalHandle" placeholder="tap-merchant-123" required />
        </label>{" "}
        <button type="submit">Activate</button>
      </Form>
      {result?.ok && (
        <p>
          Activated.{" "}
          <a href={`https://${shop}/services/payments_partners/gateways/${apiKey}/settings`}>Return to Shopify</a>
        </p>
      )}
      {result?.errors?.map((e, i) => (
        <p role="alert" key={i}>
          {e.message}
        </p>
      ))}
    </main>
  );
}
