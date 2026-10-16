import { json } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { LoginErrorType } from "@shopify/shopify-app-remix/server";
import { getShopify } from "~/shopify.server";

function errorMessage(result) {
  if (result?.shop === LoginErrorType.MissingShop) return "Enter your shop domain.";
  if (result?.shop === LoginErrorType.InvalidShop) return "Enter a valid myshopify.com domain.";
  return null;
}

export const loader = async ({ request }) => {
  return json({ error: errorMessage(await getShopify().login(request)) });
};

export const action = async ({ request }) => {
  return json({ error: errorMessage(await getShopify().login(request)) });
};

export default function Login() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const { error } = actionData ?? loaderData;
  return (
    <main>
      <h1>Install Tap Credit Card</h1>
      <Form method="post">
        <label>
          Shop domain{" "}
          <input name="shop" placeholder="example.myshopify.com" autoComplete="on" />
        </label>{" "}
        <button type="submit">Log in</button>
        {error && <p role="alert">{error}</p>}
      </Form>
    </main>
  );
}
