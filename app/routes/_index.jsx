import { redirect } from "@remix-run/node";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const target = url.searchParams.get("shop") ? "/app" : "/auth/login";
  return redirect(`${target}${url.search}`);
};
