import type { AdapterClient, ClientResult } from "@8lines/gauntlet-dashboard-client";
import type {
  DataSourcePage, DataSourceQuery, DataSourceResolveRequest, DataSourceResolveResponse,
} from "@8lines/gauntlet-protocol";
import type { ManifestService } from "./manifest-service.js";

/** Shared by HTTP and MCP so both enforce the same catalog boundary. */
export function createDataSourceService(client: AdapterClient, manifests: ManifestService) {
  const targetFor = async (targetId: string, dataSourceId: string) => {
    const compatible = await manifests.requireCompatibleTarget(targetId);
    if (!compatible.ok) return compatible;
    const count = compatible.manifest.dataSources.filter(({ id }) => id === dataSourceId).length;
    if (count !== 1) {
      return { ok: false as const, problem: count === 0
        ? { type: "urn:gauntlet:problem:data-source-not-found" as const, title: "Data source not found", status: 404 }
        : { type: "urn:gauntlet:problem:adapter-invalid-response" as const, title: "Invalid adapter response", status: 502 } };
    }
    return compatible;
  };
  return {
    async query(targetId: string, dataSourceId: string, request: unknown): Promise<ClientResult<DataSourcePage>> {
      const compatible = await targetFor(targetId, dataSourceId);
      return compatible.ok ? await client.queryDataSource(compatible.target, dataSourceId, request as DataSourceQuery) : compatible;
    },
    async resolve(targetId: string, dataSourceId: string, request: unknown): Promise<ClientResult<DataSourceResolveResponse>> {
      const compatible = await targetFor(targetId, dataSourceId);
      return compatible.ok ? await client.resolveDataSource(compatible.target, dataSourceId, request as DataSourceResolveRequest) : compatible;
    },
  };
}

export type DataSourceService = ReturnType<typeof createDataSourceService>;
