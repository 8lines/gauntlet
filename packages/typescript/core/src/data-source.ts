import type {
  DataSourceDefinition,
  DataSourcePage,
  DataSourceQuery,
  DataSourceResolveRequest,
  DataSourceResolveResponse,
} from "@8lines/gauntlet-protocol";

export interface DataSource {
  readonly definition: DataSourceDefinition;
  query(request: DataSourceQuery): DataSourcePage | Promise<DataSourcePage>;
  resolve(request: DataSourceResolveRequest): DataSourceResolveResponse | Promise<DataSourceResolveResponse>;
}
