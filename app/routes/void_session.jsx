import { created, shopifySessionEndpoint } from "~/services/http.server";
import { receiveUnsupportedSession, scheduleUnsupportedWork } from "~/services/unsupported.server";

export const action = shopifySessionEndpoint("void_session", async (body, ctx) => {
  scheduleUnsupportedWork(await receiveUnsupportedSession("void", body, ctx));
  return created();
});
