import type {
  InputHandlingRule,
  JsonValue,
  ObjectJsonSchema,
  OperationDefinition,
} from "./types.js";

type SchemaNode = boolean | Record<string, unknown>;

interface ResolvedSchema {
  readonly pointer: string;
  readonly schema: SchemaNode;
}

interface GraphEdge {
  readonly target: number;
  readonly dynamic: boolean;
}

interface InstanceRouteNode extends ResolvedSchema {
  readonly id: number;
  readonly edges: GraphEdge[];
  readonly sameInstance: number[];
  readonly properties: Map<string, number[]>;
  readonly dependentSchemas: Map<string, number[]>;
  readonly arrayIndices: Map<number, number[]>;
  readonly arrayTails: Map<number, number[]>;
}

interface InstanceRouteGraph {
  readonly nodes: readonly InstanceRouteNode[];
  readonly nodesByPointer: ReadonlyMap<string, InstanceRouteNode>;
  readonly edgeCount: number;
}

interface TargetRouteGraph extends InstanceRouteGraph {
  readonly targetNodeIds: ReadonlySet<number>;
}

const DYNAMIC_INSTANCE_KEYWORDS = [
  "contains",
  "additionalProperties",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;

const SAME_INSTANCE_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
const SAME_INSTANCE_KEYWORDS = ["not", "if", "then", "else"] as const;

const MAX_GRAPH_NODES = 250_000;
const MAX_GRAPH_EDGES = 500_000;
const MAX_PRESET_VISITS = 500_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asSchemaNode(value: unknown): SchemaNode | undefined {
  if (typeof value === "boolean") return value;
  return asRecord(value);
}

function decodePointer(pointer: string): readonly string[] | undefined {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return undefined;
    segments.push(encoded.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return segments;
}

function pointerFor(segments: readonly string[]): string {
  return segments.length === 0
    ? ""
    : `/${segments.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function childPointer(parent: string, segment: string): string {
  return `${parent}/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function resolveSchemaPointer(
  rootSchema: ObjectJsonSchema,
  pointer: string,
): ResolvedSchema | undefined {
  const segments = decodePointer(pointer);
  if (segments === undefined) return undefined;
  let current: unknown = rootSchema;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  const schema = asSchemaNode(current);
  return schema === undefined ? undefined : { pointer: pointerFor(segments), schema };
}

function resolveLocalReference(
  rootSchema: ObjectJsonSchema,
  reference: string,
): ResolvedSchema | undefined {
  if (!reference.startsWith("#")) return undefined;
  let pointer: string;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return undefined;
  }
  return resolveSchemaPointer(rootSchema, pointer);
}

function appendTransition(
  transitions: Map<string, number[]>,
  key: string,
  target: number,
): void {
  const targets = transitions.get(key);
  if (targets === undefined) {
    transitions.set(key, [target]);
  } else {
    targets.push(target);
  }
}

function appendIndexedTransition(
  transitions: Map<number, number[]>,
  key: number,
  target: number,
): void {
  const targets = transitions.get(key);
  if (targets === undefined) {
    transitions.set(key, [target]);
  } else {
    targets.push(target);
  }
}

function buildInstanceRouteGraph(rootSchema: ObjectJsonSchema): InstanceRouteGraph | undefined {
  const nodes: InstanceRouteNode[] = [];
  const nodesByPointer = new Map<string, InstanceRouteNode>();
  let edgeCount = 0;
  let valid = true;

  const ensureNode = (resolved: ResolvedSchema): InstanceRouteNode => {
    const existing = nodesByPointer.get(resolved.pointer);
    if (existing !== undefined) return existing;
    const node: InstanceRouteNode = {
      ...resolved,
      id: nodes.length,
      edges: [],
      sameInstance: [],
      properties: new Map(),
      dependentSchemas: new Map(),
      arrayIndices: new Map(),
      arrayTails: new Map(),
    };
    nodes.push(node);
    nodesByPointer.set(node.pointer, node);
    if (nodes.length > MAX_GRAPH_NODES) valid = false;
    return node;
  };

  const addEdge = (
    source: InstanceRouteNode,
    resolved: ResolvedSchema,
    dynamic: boolean,
  ): InstanceRouteNode => {
    const target = ensureNode(resolved);
    source.edges.push({ target: target.id, dynamic });
    edgeCount += 1;
    if (edgeCount > MAX_GRAPH_EDGES) valid = false;
    return target;
  };

  ensureNode({ pointer: "", schema: rootSchema });
  for (let cursor = 0; cursor < nodes.length && valid; cursor += 1) {
    const node = nodes[cursor]!;
    const { pointer: schemaPointer, schema } = node;
    if (typeof schema === "boolean") continue;

    if (typeof schema.$ref === "string") {
      const referenced = resolveLocalReference(rootSchema, schema.$ref);
      if (referenced === undefined) {
        valid = false;
      } else {
        node.sameInstance.push(addEdge(node, referenced, false).id);
      }
    }

    const properties = asRecord(schema.properties);
    if (properties !== undefined) {
      for (const [property, child] of Object.entries(properties)) {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) continue;
        const resolved = {
          pointer: childPointer(childPointer(schemaPointer, "properties"), property),
          schema: childSchema,
        };
        appendTransition(node.properties, property, addEdge(node, resolved, false).id);
      }
    }

    const dependentSchemas = asRecord(schema.dependentSchemas);
    if (dependentSchemas !== undefined) {
      for (const [property, child] of Object.entries(dependentSchemas)) {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) continue;
        const resolved = {
          pointer: childPointer(childPointer(schemaPointer, "dependentSchemas"), property),
          schema: childSchema,
        };
        appendTransition(node.dependentSchemas, property, addEdge(node, resolved, false).id);
      }
    }

    for (const keyword of SAME_INSTANCE_ARRAY_KEYWORDS) {
      const children = schema[keyword];
      if (!Array.isArray(children)) continue;
      children.forEach((child, index) => {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) return;
        const resolved = {
          pointer: childPointer(childPointer(schemaPointer, keyword), String(index)),
          schema: childSchema,
        };
        node.sameInstance.push(addEdge(node, resolved, false).id);
      });
    }

    for (const keyword of SAME_INSTANCE_KEYWORDS) {
      const childSchema = asSchemaNode(schema[keyword]);
      if (childSchema === undefined) continue;
      const resolved = {
        pointer: childPointer(schemaPointer, keyword),
        schema: childSchema,
      };
      node.sameInstance.push(addEdge(node, resolved, false).id);
    }

    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    prefixItems.forEach((child, index) => {
      const childSchema = asSchemaNode(child);
      if (childSchema === undefined) return;
      const resolved = {
        pointer: childPointer(childPointer(schemaPointer, "prefixItems"), String(index)),
        schema: childSchema,
      };
      appendIndexedTransition(node.arrayIndices, index, addEdge(node, resolved, false).id);
    });

    const items = asSchemaNode(schema.items);
    if (items !== undefined) {
      const resolved = { pointer: childPointer(schemaPointer, "items"), schema: items };
      appendIndexedTransition(node.arrayTails, prefixItems.length, addEdge(node, resolved, false).id);
    }

    const patternProperties = asRecord(schema.patternProperties);
    if (patternProperties !== undefined) {
      for (const [pattern, child] of Object.entries(patternProperties)) {
        const childSchema = asSchemaNode(child);
        if (childSchema === undefined) continue;
        addEdge(node, {
          pointer: childPointer(childPointer(schemaPointer, "patternProperties"), pattern),
          schema: childSchema,
        }, true);
      }
    }

    for (const keyword of DYNAMIC_INSTANCE_KEYWORDS) {
      const childSchema = asSchemaNode(schema[keyword]);
      if (childSchema === undefined) continue;
      addEdge(node, {
        pointer: childPointer(schemaPointer, keyword),
        schema: childSchema,
      }, true);
    }
  }

  return valid ? { nodes, nodesByPointer, edgeCount } : undefined;
}

function graphComponents(edgesByNode: readonly (readonly GraphEdge[])[]): {
  readonly componentByNode: Int32Array;
  readonly componentCount: number;
} {
  const seen = new Uint8Array(edgesByNode.length);
  const finishOrder: number[] = [];
  for (let start = 0; start < edgesByNode.length; start += 1) {
    if (seen[start] === 1) continue;
    seen[start] = 1;
    const stack: { readonly node: number; nextEdge: number }[] = [{ node: start, nextEdge: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edges = edgesByNode[frame.node]!;
      if (frame.nextEdge < edges.length) {
        const target = edges[frame.nextEdge]!.target;
        frame.nextEdge += 1;
        if (seen[target] === 0) {
          seen[target] = 1;
          stack.push({ node: target, nextEdge: 0 });
        }
      } else {
        finishOrder.push(frame.node);
        stack.pop();
      }
    }
  }

  const reverseEdges = Array.from({ length: edgesByNode.length }, () => [] as number[]);
  for (let source = 0; source < edgesByNode.length; source += 1) {
    for (const edge of edgesByNode[source]!) reverseEdges[edge.target]!.push(source);
  }

  const componentByNode = new Int32Array(edgesByNode.length);
  componentByNode.fill(-1);
  let componentCount = 0;
  for (let index = finishOrder.length - 1; index >= 0; index -= 1) {
    const start = finishOrder[index]!;
    if (componentByNode[start] !== -1) continue;
    componentByNode[start] = componentCount;
    const pending = [start];
    while (pending.length > 0) {
      const node = pending.pop()!;
      for (const source of reverseEdges[node]!) {
        if (componentByNode[source] === -1) {
          componentByNode[source] = componentCount;
          pending.push(source);
        }
      }
    }
    componentCount += 1;
  }
  return { componentByNode, componentCount };
}

function compileDominance(
  graph: InstanceRouteGraph,
): ((dominatorNode: number, node: number) => boolean) | undefined {
  // Iterative Lengauer-Tarjan keeps dominance independent of DFS edge order
  // while bounding work by the finite graph rather than recursive histories.
  const nodeCount = graph.nodes.length;
  const dfsNumberByNode = new Uint32Array(nodeCount);
  const parent = new Uint32Array(nodeCount + 1);
  let dfsCount = 1;
  dfsNumberByNode[0] = dfsCount;
  const dfsStack: { readonly node: number; nextEdge: number }[] = [{ node: 0, nextEdge: 0 }];
  while (dfsStack.length > 0) {
    const frame = dfsStack[dfsStack.length - 1]!;
    const edges = graph.nodes[frame.node]!.edges;
    if (frame.nextEdge >= edges.length) {
      dfsStack.pop();
      continue;
    }
    const target = edges[frame.nextEdge]!.target;
    frame.nextEdge += 1;
    if (dfsNumberByNode[target] !== 0) continue;
    dfsCount += 1;
    dfsNumberByNode[target] = dfsCount;
    parent[dfsCount] = dfsNumberByNode[frame.node]!;
    dfsStack.push({ node: target, nextEdge: 0 });
  }
  if (dfsCount !== nodeCount) return undefined;

  const predecessorCounts = new Uint32Array(nodeCount + 1);
  for (const source of graph.nodes) {
    for (const edge of source.edges) {
      const target = dfsNumberByNode[edge.target]!;
      predecessorCounts[target] = predecessorCounts[target]! + 1;
    }
  }
  const predecessorOffsets = new Uint32Array(nodeCount + 2);
  for (let vertex = 1; vertex <= nodeCount; vertex += 1) {
    predecessorOffsets[vertex + 1] = predecessorOffsets[vertex]! + predecessorCounts[vertex]!;
  }
  const predecessorPositions = predecessorOffsets.slice();
  const predecessors = new Uint32Array(graph.edgeCount);
  for (const source of graph.nodes) {
    const sourceVertex = dfsNumberByNode[source.id]!;
    for (const edge of source.edges) {
      const targetVertex = dfsNumberByNode[edge.target]!;
      const position = predecessorPositions[targetVertex]!;
      predecessors[position] = sourceVertex;
      predecessorPositions[targetVertex] = position + 1;
    }
  }

  const semi = new Uint32Array(nodeCount + 1);
  const label = new Uint32Array(nodeCount + 1);
  const ancestor = new Uint32Array(nodeCount + 1);
  const immediateDominator = new Uint32Array(nodeCount + 1);
  const bucketHead = new Uint32Array(nodeCount + 1);
  const bucketNext = new Uint32Array(nodeCount + 1);
  for (let vertex = 1; vertex <= nodeCount; vertex += 1) {
    semi[vertex] = vertex;
    label[vertex] = vertex;
  }

  const compressionPath: number[] = [];
  const evaluate = (vertex: number): number => {
    if (ancestor[vertex] === 0) return label[vertex]!;
    compressionPath.length = 0;
    let cursor = vertex;
    while (ancestor[ancestor[cursor]!] !== 0) {
      compressionPath.push(cursor);
      cursor = ancestor[cursor]!;
    }
    for (let index = compressionPath.length - 1; index >= 0; index -= 1) {
      const child = compressionPath[index]!;
      const ancestorVertex = ancestor[child]!;
      if (semi[label[ancestorVertex]!]! < semi[label[child]!]!) {
        label[child] = label[ancestorVertex]!;
      }
      ancestor[child] = ancestor[ancestorVertex]!;
    }
    return label[vertex]!;
  };

  for (let vertex = nodeCount; vertex >= 2; vertex -= 1) {
    for (
      let position = predecessorOffsets[vertex]!;
      position < predecessorOffsets[vertex + 1]!;
      position += 1
    ) {
      const candidate = evaluate(predecessors[position]!);
      if (semi[candidate]! < semi[vertex]!) semi[vertex] = semi[candidate]!;
    }
    bucketNext[vertex] = bucketHead[semi[vertex]!]!;
    bucketHead[semi[vertex]!] = vertex;
    const parentVertex = parent[vertex]!;
    ancestor[vertex] = parentVertex;
    let deferred = bucketHead[parentVertex]!;
    bucketHead[parentVertex] = 0;
    while (deferred !== 0) {
      const next = bucketNext[deferred]!;
      const candidate = evaluate(deferred);
      immediateDominator[deferred] = semi[candidate]! < semi[deferred]!
        ? candidate
        : parentVertex;
      deferred = next;
    }
  }
  for (let vertex = 2; vertex <= nodeCount; vertex += 1) {
    if (immediateDominator[vertex] === 0) return undefined;
    if (immediateDominator[vertex] !== semi[vertex]) {
      immediateDominator[vertex] = immediateDominator[immediateDominator[vertex]!]!;
    }
  }

  const childCounts = new Uint32Array(nodeCount + 1);
  for (let vertex = 2; vertex <= nodeCount; vertex += 1) {
    const dominator = immediateDominator[vertex]!;
    childCounts[dominator] = childCounts[dominator]! + 1;
  }
  const childOffsets = new Uint32Array(nodeCount + 2);
  for (let vertex = 1; vertex <= nodeCount; vertex += 1) {
    childOffsets[vertex + 1] = childOffsets[vertex]! + childCounts[vertex]!;
  }
  const childPositions = childOffsets.slice();
  const children = new Uint32Array(Math.max(0, nodeCount - 1));
  for (let vertex = 2; vertex <= nodeCount; vertex += 1) {
    const dominator = immediateDominator[vertex]!;
    const position = childPositions[dominator]!;
    children[position] = vertex;
    childPositions[dominator] = position + 1;
  }

  const enteredAt = new Uint32Array(nodeCount + 1);
  const exitedAt = new Uint32Array(nodeCount + 1);
  let timestamp = 1;
  enteredAt[1] = timestamp;
  const dominatorStack: { readonly vertex: number; nextChild: number }[] = [{
    vertex: 1,
    nextChild: childOffsets[1]!,
  }];
  while (dominatorStack.length > 0) {
    const frame = dominatorStack[dominatorStack.length - 1]!;
    if (frame.nextChild < childOffsets[frame.vertex + 1]!) {
      const child = children[frame.nextChild]!;
      frame.nextChild += 1;
      timestamp += 1;
      enteredAt[child] = timestamp;
      dominatorStack.push({ vertex: child, nextChild: childOffsets[child]! });
    } else {
      exitedAt[frame.vertex] = timestamp;
      dominatorStack.pop();
    }
  }

  return (dominatorNode: number, node: number): boolean => {
    const dominator = dfsNumberByNode[dominatorNode]!;
    const dominated = dfsNumberByNode[node]!;
    return enteredAt[dominator]! <= enteredAt[dominated]!
      && exitedAt[dominated]! <= exitedAt[dominator]!;
  };
}

function compileDynamicTaint(graph: InstanceRouteGraph): Uint8Array {
  const tainted = new Uint8Array(graph.nodes.length);
  const pending: number[] = [];
  for (const node of graph.nodes) {
    for (const edge of node.edges) {
      if (!edge.dynamic || tainted[edge.target] === 1) continue;
      tainted[edge.target] = 1;
      pending.push(edge.target);
    }
  }
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    for (const edge of graph.nodes[pending[cursor]!]!.edges) {
      if (tainted[edge.target] === 1) continue;
      tainted[edge.target] = 1;
      pending.push(edge.target);
    }
  }
  return tainted;
}

function compileRouteProvenance(graph: InstanceRouteGraph): {
  readonly componentByNode: Int32Array;
  readonly routeCounts: Uint8Array;
  readonly ambiguous: Uint8Array;
} | undefined {
  const dominates = compileDominance(graph);
  if (dominates === undefined) return undefined;
  // A transition back to a dominator is always a revisit: every route to its
  // source has already crossed the target. All other transitions retain their
  // provenance, including cross-entry references into a recursive component.
  const residualEdges = graph.nodes.map((node) => node.edges.filter(
    (edge) => !dominates(edge.target, node.id),
  ));
  const { componentByNode, componentCount } = graphComponents(residualEdges);
  const componentEdges = Array.from(
    { length: componentCount },
    () => [] as { readonly target: number }[],
  );
  const indegree = new Uint32Array(componentCount);
  const ambiguous = new Uint8Array(componentCount);
  for (let source = 0; source < residualEdges.length; source += 1) {
    const sourceComponent = componentByNode[source]!;
    for (const edge of residualEdges[source]!) {
      const targetComponent = componentByNode[edge.target]!;
      if (sourceComponent === targetComponent) {
        // Cycles left after natural revisits are removed have independent
        // entries, so their locations (and descendants) are ambiguous.
        ambiguous[sourceComponent] = 1;
      } else {
        componentEdges[sourceComponent]!.push({ target: targetComponent });
        indegree[targetComponent] = indegree[targetComponent]! + 1;
      }
    }
  }

  const routeCounts = new Uint8Array(componentCount);
  routeCounts[componentByNode[0]!] = 1;
  const ready: number[] = [];
  for (let component = 0; component < componentCount; component += 1) {
    if (indegree[component] === 0) ready.push(component);
  }
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const source = ready[cursor]!;
    for (const edge of componentEdges[source]!) {
      if (routeCounts[source]! > 0) {
        routeCounts[edge.target] = Math.min(
          2,
          routeCounts[edge.target]! + routeCounts[source]!,
        );
        if (ambiguous[source] === 1) ambiguous[edge.target] = 1;
      }
      indegree[edge.target] = indegree[edge.target]! - 1;
      if (indegree[edge.target] === 0) ready.push(edge.target);
    }
  }
  return ready.length === componentCount
    ? { componentByNode, routeCounts, ambiguous }
    : undefined;
}

function compileTargetRouteGraph(
  rootSchema: ObjectJsonSchema,
  schemaPointers: ReadonlySet<string>,
): TargetRouteGraph | undefined {
  const graph = buildInstanceRouteGraph(rootSchema);
  if (graph === undefined) return undefined;
  const provenance = compileRouteProvenance(graph);
  if (provenance === undefined) return undefined;
  const dynamicTaint = compileDynamicTaint(graph);

  const targetNodeIds = new Set<number>();
  const targetPointers = new Set<string>();
  for (const schemaPointer of schemaPointers) {
    const resolved = resolveSchemaPointer(rootSchema, schemaPointer);
    if (resolved === undefined) return undefined;
    if (targetPointers.has(resolved.pointer)) continue;
    targetPointers.add(resolved.pointer);
    const target: InstanceRouteNode | undefined = graph.nodesByPointer.get(resolved.pointer);
    if (target === undefined) return undefined;
    const component = provenance.componentByNode[target.id]!;
    if (provenance.routeCounts[component] === 0
      || dynamicTaint[target.id] === 1
      || (target.schema !== false
        && (provenance.routeCounts[component]! > 1 || provenance.ambiguous[component] === 1))) {
      return undefined;
    }
    if (target.schema !== false) targetNodeIds.add(target.id);
  }
  return { ...graph, targetNodeIds };
}

function countJsonNodes(root: unknown): number {
  let count = 0;
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    count += 1;
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return count;
}

function graphTargetsAreValid(
  graph: TargetRouteGraph,
  values: readonly JsonValue[],
  targetIsValid: (nodeId: number, value: JsonValue) => boolean,
): boolean {
  interface VisitState {
    readonly nodeId: number;
    readonly value: JsonValue;
  }

  function* childVisits(node: InstanceRouteNode, value: JsonValue): Generator<VisitState> {
    for (const target of node.sameInstance) {
      yield { nodeId: target, value };
    }

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const childValue = value[index]!;
        for (const target of node.arrayIndices.get(index) ?? []) {
          yield { nodeId: target, value: childValue };
        }
        for (const [firstIndex, targets] of node.arrayTails) {
          if (index < firstIndex) continue;
          for (const target of targets) {
            yield { nodeId: target, value: childValue };
          }
        }
      }
    } else if (value !== null && typeof value === "object") {
      const objectValue = value as Readonly<Record<string, JsonValue>>;
      for (const property in objectValue) {
        if (!Object.hasOwn(objectValue, property)) continue;
        const childValue = objectValue[property]!;
        for (const target of node.properties.get(property) ?? []) {
          yield { nodeId: target, value: childValue };
        }
        for (const target of node.dependentSchemas.get(property) ?? []) {
          yield { nodeId: target, value };
        }
      }
    }
  }

  const inputNodeCount = values.reduce<number>(
    (count, value) => count + countJsonNodes(value),
    0,
  );
  const visitBudget = Math.min(
    MAX_PRESET_VISITS,
    Math.max(8_192, graph.nodes.length * 4 + graph.edgeCount * 2 + inputNodeCount * 64),
  );
  let visitCount = 0;

  for (const input of values) {
    const objectVisits = new Map<number, WeakSet<object>>();
    const primitiveVisits = new Set<number>();
    const continuations: Generator<VisitState>[] = [];
    let current: VisitState | undefined = {
      nodeId: 0,
      value: input,
    };

    const resume = (): VisitState | undefined => {
      while (continuations.length > 0) {
        const continuation = continuations[continuations.length - 1]!;
        const next = continuation.next();
        if (!next.done) return next.value;
        continuations.pop();
      }
      return undefined;
    };

    while (current !== undefined) {
      const { nodeId, value } = current;
      visitCount += 1;
      if (visitCount > visitBudget
        || (graph.targetNodeIds.has(nodeId) && !targetIsValid(nodeId, value))) return false;
      const node = graph.nodes[nodeId]!;

      if (value !== null && typeof value === "object") {
        const prior = objectVisits.get(nodeId) ?? new WeakSet<object>();
        if (prior.has(value)) {
          current = resume();
          continue;
        }
        prior.add(value);
        objectVisits.set(nodeId, prior);
      } else {
        if (primitiveVisits.has(nodeId)) {
          current = resume();
          continue;
        }
        primitiveVisits.add(nodeId);
      }

      const continuation = childVisits(node, value);
      const next = continuation.next();
      if (next.done) {
        current = resume();
      } else {
        continuations.push(continuation);
        current = next.value;
      }
    }
  }
  return true;
}

export function operationPresetsOmitSecrets(operation: OperationDefinition): boolean {
  const schemaPointers = new Set(
    operation.inputHandling?.rules.flatMap((rule) => rule.kind === "secret" ? [rule.schemaPointer] : []) ?? [],
  );
  if (schemaPointers.size === 0) return true;
  const graph = compileTargetRouteGraph(operation.inputSchema, schemaPointers);
  return graph !== undefined
    && graphTargetsAreValid(graph, operation.presets.map(({ input }) => input), () => false);
}

export type FileInputHandlingRule = Extract<InputHandlingRule, { readonly kind: "file" }>;

export function operationInputHandlingValuesAreValid(
  operation: OperationDefinition,
  input: JsonValue,
  fileReferenceIsValid: (value: JsonValue, rule: FileInputHandlingRule) => boolean,
): boolean {
  const rules = operation.inputHandling?.rules ?? [];
  if (rules.length === 0) return true;
  const schemaPointers = new Set(rules.map(({ schemaPointer }) => schemaPointer));
  const graph = compileTargetRouteGraph(operation.inputSchema, schemaPointers);
  if (graph === undefined) return false;

  const rulesByNode = new Map<number, InputHandlingRule[]>();
  for (const rule of rules) {
    const resolved = resolveSchemaPointer(operation.inputSchema, rule.schemaPointer);
    if (resolved === undefined) return false;
    const target = graph.nodesByPointer.get(resolved.pointer);
    if (target === undefined) return false;
    if (!graph.targetNodeIds.has(target.id)) continue;
    const nodeRules = rulesByNode.get(target.id);
    if (nodeRules === undefined) rulesByNode.set(target.id, [rule]);
    else nodeRules.push(rule);
  }

  return graphTargetsAreValid(graph, [input], (nodeId, value) => {
    for (const rule of rulesByNode.get(nodeId) ?? []) {
      if (rule.kind === "secret") return false;
      if (rule.multiple) {
        if (!Array.isArray(value)
          || !value.every((candidate) => fileReferenceIsValid(candidate, rule))) return false;
      } else if (!fileReferenceIsValid(value, rule)) {
        return false;
      }
    }
    return true;
  });
}
