import {
  isProtocolId,
  type DataSourceDefinition,
  type DataSourceQuery,
  type DataSourceResolveRequest,
  type ProtocolId,
} from "@8lines/gauntlet-protocol";
import type { DataSource } from "./data-source.js";
import { cloneAndDeepFreeze } from "./operation-internals.js";

export class DataSourceRegistry {
  readonly #sources = new Map<ProtocolId, DataSource>();

  register(source: DataSource): void {
    const definition = cloneAndDeepFreeze(source.definition);
    const id = definition.id;
    if (!isProtocolId(id)) throw new TypeError(`Invalid data source ID: ${id}`);
    if (this.#sources.has(id)) throw new TypeError(`Duplicate data source ID: ${id}`);
    this.#sources.set(id, Object.freeze({
      definition,
      query: (request: DataSourceQuery) => source.query(request),
      resolve: (request: DataSourceResolveRequest) => source.resolve(request),
    }));
  }

  get(id: string): DataSource | undefined { return this.#sources.get(id); }
  require(id: string): DataSource {
    const source = this.get(id);
    if (source === undefined) throw new TypeError(`Unknown data source: ${id}`);
    return source;
  }
  definitions(): readonly DataSourceDefinition[] {
    return [...this.#sources.values()].map(({ definition }) => definition)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
