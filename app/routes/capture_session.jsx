import { created, shopifySessionEndpoint } from "~/services/http.server";
import { receiveUnsupportedSession, scheduleUnsupportedWork } from "~/services/unsupported.server";

export const action = shopifySessionEndpoint("capture_session", async (body, ctx) => {
  scheduleUnsupportedWork(await receiveUnsupportedSession("capture", body, ctx));
  return created();
});
