import { PassThrough } from "node:stream";
import { createReadableStreamFromReadable } from "@remix-run/node";
import { RemixServer } from "@remix-run/react";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { resumeInFlightWork } from "./services/recovery.server";
import { logger } from "./services/logger.server";

const ABORT_DELAY = 5000;

if (!globalThis.__recoveryStarted) {
  globalThis.__recoveryStarted = true;
  resumeInFlightWork().catch((err) => logger.error({ event: "recovery.failed", err }, "recovery failed"));
}

export default function handleRequest(request, responseStatusCode, responseHeaders, remixContext) {
  const readyEvent = isbot(request.headers.get("user-agent") ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <RemixServer context={remixContext} url={request.url} abortDelay={ABORT_DELAY} />,
      {
        [readyEvent]() {
          const body = new PassThrough();
          responseHeaders.set("Content-Type", "text/html");
          resolve(new Response(createReadableStreamFromReadable(body), { headers: responseHeaders, status: responseStatusCode }));
          pipe(body);
        },
        onShellError: reject,
        onError(error) {
          responseStatusCode = 500;
          logger.error({ err: error }, "render error");
        },
      },
    );
    setTimeout(abort, ABORT_DELAY);
  });
}
