import { createGauntletRouteHandler } from "@8lines/gauntlet-next-adapter";
import { createConformanceCatalog } from "@8lines/gauntlet-typescript-fixture";

const handler = createGauntletRouteHandler({
  enabled: process.env.GAUNTLET_ENABLED === "true",
  catalog: createConformanceCatalog(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
