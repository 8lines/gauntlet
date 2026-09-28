import { createAdapterFetchHandler, type AdapterFetchHandlerOptions } from "@8lines/gauntlet-typescript-node";

export type NextGauntletRouteHandler = (request: Request) => Promise<Response>;
export function createGauntletRouteHandler(options: AdapterFetchHandlerOptions): NextGauntletRouteHandler {
  const handler = createAdapterFetchHandler(options);
  return (request) => {
    const url = new URL(request.url);
    return handler({ kind: "trusted-normalized", request, normalizedTarget: `${url.pathname}${url.search}` });
  };
}
