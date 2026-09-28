package dev.eightlines.gauntlet.core.schema;

import dev.eightlines.gauntlet.core.json.JsonList;
import dev.eightlines.gauntlet.core.json.JsonObject;
import dev.eightlines.gauntlet.core.json.JsonValue;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** Bounded, iterative analysis proving that operation presets cannot contain secret values. */
final class PresetSecretAnalyzer {
  private static final List<String> DYNAMIC_INSTANCE_KEYWORDS =
      List.of(
          "contains",
          "additionalProperties",
          "propertyNames",
          "unevaluatedItems",
          "unevaluatedProperties",
          "contentSchema");
  private static final List<String> SAME_INSTANCE_ARRAY_KEYWORDS =
      List.of("allOf", "anyOf", "oneOf");
  private static final List<String> SAME_INSTANCE_KEYWORDS = List.of("not", "if", "then", "else");
  private static final int MAX_GRAPH_NODES = 250_000;
  private static final int MAX_GRAPH_EDGES = 500_000;
  private static final int MAX_PRESET_VISITS = 500_000;

  private PresetSecretAnalyzer() {}

  static boolean operationPresetsOmitSecrets(JsonObject operation) {
    JsonObject handling = objectOrNull(operation.get("inputHandling"));
    if (handling == null) {
      return true;
    }
    Set<String> schemaPointers = new HashSet<>();
    for (JsonObject rule : objects(handling.get("rules"))) {
      if ("secret".equals(string(rule.get("kind")))) {
        schemaPointers.add(requiredString(rule, "schemaPointer"));
      }
    }
    if (schemaPointers.isEmpty()) {
      return true;
    }
    SecretRouteGraph graph =
        compileSecretRouteGraph(object(operation.get("inputSchema")), schemaPointers);
    return graph != null && presetsOmitGraphSecrets(graph, objects(operation.get("presets")));
  }

  static List<JsonValue.Scalar> collectOperationSecretAtoms(
      JsonObject operation, JsonObject input) {
    JsonObject handling = objectOrNull(operation.get("inputHandling"));
    if (handling == null) {
      return List.of();
    }
    Set<String> schemaPointers = new HashSet<>();
    for (JsonObject rule : objects(handling.get("rules"))) {
      if ("secret".equals(string(rule.get("kind")))) {
        schemaPointers.add(requiredString(rule, "schemaPointer"));
      }
    }
    if (schemaPointers.isEmpty()) {
      return List.of();
    }

    SecretRouteGraph graph =
        compileSecretRouteGraph(object(operation.get("inputSchema")), schemaPointers);
    if (graph == null) {
      throw new IllegalArgumentException("secret rule is not instance-addressable");
    }

    long calculated =
        (long) graph.graph.nodes.size() * 4
            + (long) graph.graph.edgeCount * 2
            + (long) countJsonNodes(input) * 64;
    int visitBudget = (int) Math.min(MAX_PRESET_VISITS, Math.max(8_192L, calculated));
    int visitCount = 0;
    var atoms = new ArrayList<JsonValue.Scalar>();
    Map<Integer, Set<JsonValue>> objectVisits = new HashMap<>();
    Set<Integer> primitiveVisits = new HashSet<>();
    ArrayDeque<Visit> pending = new ArrayDeque<>();
    pending.push(new Visit(0, input));

    while (!pending.isEmpty()) {
      Visit visit = pending.pop();
      visitCount++;
      if (visitCount > visitBudget) {
        throw new IllegalArgumentException("secret traversal budget exceeded");
      }
      if (graph.secretNodeIds.contains(visit.nodeId)) {
        collectAtoms(visit.value, atoms);
      }
      Node node = graph.graph.nodes.get(visit.nodeId);
      if (visit.value instanceof JsonObject || visit.value instanceof JsonList) {
        Set<JsonValue> prior =
            objectVisits.computeIfAbsent(
                visit.nodeId,
                ignored -> java.util.Collections.newSetFromMap(new IdentityHashMap<>()));
        if (!prior.add(visit.value)) {
          continue;
        }
      } else if (!primitiveVisits.add(visit.nodeId)) {
        continue;
      }
      pushChildVisits(pending, node, visit.value);
    }
    return List.copyOf(atoms);
  }

  static List<LocatedValue> resolveOperationInputLocations(
      JsonObject operation, JsonObject input, String schemaPointer) {
    JsonObject rootSchema = object(operation.get("inputSchema"));
    Graph graph = buildInstanceRouteGraph(rootSchema);
    if (graph == null) {
      throw new IllegalArgumentException("input schema route graph is invalid");
    }
    Provenance provenance = compileRouteProvenance(graph);
    ResolvedSchema resolved = resolveSchemaPointer(rootSchema, schemaPointer);
    if (provenance == null || resolved == null) {
      throw new IllegalArgumentException("schema pointer is not instance-addressable");
    }
    Node target = graph.nodesByPointer.get(resolved.pointer());
    if (target == null) {
      throw new IllegalArgumentException("schema pointer is not instance-addressable");
    }
    int component = provenance.componentByNode[target.id];
    boolean[] dynamicTaint = compileDynamicTaint(graph);
    if (provenance.routeCounts[component] == 0
        || dynamicTaint[target.id]
        || (!isFalseSchema(target.schema)
            && (provenance.routeCounts[component] > 1 || provenance.ambiguous[component]))) {
      throw new IllegalArgumentException("schema pointer is ambiguous");
    }
    if (isFalseSchema(target.schema)) {
      return List.of();
    }

    long calculated =
        (long) graph.nodes.size() * 4
            + (long) graph.edgeCount * 2
            + (long) countJsonNodes(input) * 64;
    int visitBudget = (int) Math.min(MAX_PRESET_VISITS, Math.max(8_192L, calculated));
    int visitCount = 0;
    Map<Integer, Set<JsonValue>> objectVisits = new HashMap<>();
    Set<String> primitiveVisits = new HashSet<>();
    Map<String, LocatedValue> locations = new LinkedHashMap<>();
    ArrayDeque<LocatedVisit> pending = new ArrayDeque<>();
    pending.push(new LocatedVisit(0, input, ""));

    while (!pending.isEmpty()) {
      LocatedVisit visit = pending.pop();
      visitCount++;
      if (visitCount > visitBudget) {
        throw new IllegalArgumentException("input route traversal budget exceeded");
      }
      if (visit.nodeId == target.id) {
        locations.putIfAbsent(
            visit.instancePointer, new LocatedValue(visit.value, visit.instancePointer));
      }
      if (visit.value instanceof JsonObject || visit.value instanceof JsonList) {
        Set<JsonValue> prior =
            objectVisits.computeIfAbsent(
                visit.nodeId,
                ignored -> java.util.Collections.newSetFromMap(new IdentityHashMap<>()));
        if (!prior.add(visit.value)) {
          continue;
        }
      } else if (!primitiveVisits.add(visit.nodeId + "\0" + visit.instancePointer)) {
        continue;
      }
      pushLocatedChildVisits(pending, graph.nodes.get(visit.nodeId), visit);
    }
    return List.copyOf(locations.values());
  }

  private static void pushLocatedChildVisits(
      ArrayDeque<LocatedVisit> pending, Node node, LocatedVisit visit) {
    if (visit.value instanceof JsonList list) {
      for (int index = list.values().size() - 1; index >= 0; index--) {
        JsonValue child = list.values().get(index);
        String childPointer = childPointer(visit.instancePointer, Integer.toString(index));
        List<Map.Entry<Integer, List<Integer>>> tails = new ArrayList<>(node.arrayTails.entrySet());
        for (Map.Entry<Integer, List<Integer>> tail : tails.reversed()) {
          if (index >= tail.getKey()) {
            for (int target : tail.getValue().reversed()) {
              pending.push(new LocatedVisit(target, child, childPointer));
            }
          }
        }
        for (int target : node.arrayIndices.getOrDefault(index, List.of()).reversed()) {
          pending.push(new LocatedVisit(target, child, childPointer));
        }
      }
    } else if (visit.value instanceof JsonObject object) {
      List<Map.Entry<String, JsonValue>> entries = new ArrayList<>(object.values().entrySet());
      for (Map.Entry<String, JsonValue> entry : entries.reversed()) {
        for (int target :
            node.dependentSchemas.getOrDefault(entry.getKey(), List.of()).reversed()) {
          pending.push(new LocatedVisit(target, visit.value, visit.instancePointer));
        }
        String childPointer = childPointer(visit.instancePointer, entry.getKey());
        for (int target : node.properties.getOrDefault(entry.getKey(), List.of()).reversed()) {
          pending.push(new LocatedVisit(target, entry.getValue(), childPointer));
        }
      }
    }
    for (int target : node.sameInstance.reversed()) {
      pending.push(new LocatedVisit(target, visit.value, visit.instancePointer));
    }
  }

  private static void collectAtoms(JsonValue root, List<JsonValue.Scalar> atoms) {
    ArrayDeque<JsonValue> pending = new ArrayDeque<>();
    pending.push(root);
    while (!pending.isEmpty()) {
      JsonValue value = pending.pop();
      if (value instanceof JsonValue.Scalar scalar) {
        atoms.add(scalar);
      } else if (value instanceof JsonObject object) {
        for (Map.Entry<String, JsonValue> entry : object.values().entrySet()) {
          atoms.add(new JsonValue.Scalar(entry.getKey()));
          pending.push(entry.getValue());
        }
      } else if (value instanceof JsonList list) {
        pending.addAll(list.values());
      }
    }
  }

  private static Graph buildInstanceRouteGraph(JsonObject rootSchema) {
    List<Node> nodes = new ArrayList<>();
    Map<String, Node> nodesByPointer = new HashMap<>();
    int[] edgeCount = {0};
    boolean[] valid = {true};

    java.util.function.Function<ResolvedSchema, Node> ensureNode =
        resolved -> {
          Node existing = nodesByPointer.get(resolved.pointer());
          if (existing != null) {
            return existing;
          }
          Node node = new Node(nodes.size(), resolved.pointer(), resolved.schema());
          nodes.add(node);
          nodesByPointer.put(node.pointer, node);
          if (nodes.size() > MAX_GRAPH_NODES) {
            valid[0] = false;
          }
          return node;
        };

    ensureNode.apply(new ResolvedSchema("", rootSchema));
    for (int cursor = 0; cursor < nodes.size() && valid[0]; cursor++) {
      Node node = nodes.get(cursor);
      if (!(node.schema instanceof JsonObject schema)) {
        continue;
      }

      java.util.function.BiFunction<ResolvedSchema, Boolean, Node> addEdge =
          (resolved, dynamic) -> {
            Node target = ensureNode.apply(resolved);
            node.edges.add(new Edge(target.id, dynamic));
            edgeCount[0]++;
            if (edgeCount[0] > MAX_GRAPH_EDGES) {
              valid[0] = false;
            }
            return target;
          };

      String reference = string(schema.get("$ref"));
      if (reference != null) {
        ResolvedSchema referenced = resolveLocalReference(rootSchema, reference);
        if (referenced == null) {
          valid[0] = false;
        } else {
          node.sameInstance.add(addEdge.apply(referenced, false).id);
        }
      }

      addObjectChildren(schema, "properties", node.properties, node, addEdge);
      addObjectChildren(schema, "dependentSchemas", node.dependentSchemas, node, addEdge);

      for (String keyword : SAME_INSTANCE_ARRAY_KEYWORDS) {
        JsonList children = listOrNull(schema.get(keyword));
        if (children == null) {
          continue;
        }
        for (int index = 0; index < children.values().size(); index++) {
          JsonValue child = children.values().get(index);
          if (!isSchemaNode(child)) {
            continue;
          }
          ResolvedSchema resolved =
              new ResolvedSchema(
                  childPointer(childPointer(node.pointer, keyword), Integer.toString(index)),
                  child);
          node.sameInstance.add(addEdge.apply(resolved, false).id);
        }
      }

      for (String keyword : SAME_INSTANCE_KEYWORDS) {
        JsonValue child = schema.get(keyword);
        if (!isSchemaNode(child)) {
          continue;
        }
        node.sameInstance.add(
            addEdge.apply(new ResolvedSchema(childPointer(node.pointer, keyword), child), false)
                .id);
      }

      JsonList prefixItems = listOrNull(schema.get("prefixItems"));
      int prefixCount = prefixItems == null ? 0 : prefixItems.values().size();
      if (prefixItems != null) {
        for (int index = 0; index < prefixItems.values().size(); index++) {
          JsonValue child = prefixItems.values().get(index);
          if (!isSchemaNode(child)) {
            continue;
          }
          Node target =
              addEdge.apply(
                  new ResolvedSchema(
                      childPointer(
                          childPointer(node.pointer, "prefixItems"), Integer.toString(index)),
                      child),
                  false);
          append(node.arrayIndices, index, target.id);
        }
      }
      JsonValue items = schema.get("items");
      if (isSchemaNode(items)) {
        Node target =
            addEdge.apply(new ResolvedSchema(childPointer(node.pointer, "items"), items), false);
        append(node.arrayTails, prefixCount, target.id);
      }

      JsonObject patternProperties = objectOrNull(schema.get("patternProperties"));
      if (patternProperties != null) {
        for (Map.Entry<String, JsonValue> entry : patternProperties.values().entrySet()) {
          if (isSchemaNode(entry.getValue())) {
            addEdge.apply(
                new ResolvedSchema(
                    childPointer(childPointer(node.pointer, "patternProperties"), entry.getKey()),
                    entry.getValue()),
                true);
          }
        }
      }

      for (String keyword : DYNAMIC_INSTANCE_KEYWORDS) {
        JsonValue child = schema.get(keyword);
        if (isSchemaNode(child)) {
          addEdge.apply(new ResolvedSchema(childPointer(node.pointer, keyword), child), true);
        }
      }
    }
    return valid[0] ? new Graph(nodes, nodesByPointer, edgeCount[0]) : null;
  }

  private static void addObjectChildren(
      JsonObject schema,
      String keyword,
      Map<String, List<Integer>> transitions,
      Node node,
      java.util.function.BiFunction<ResolvedSchema, Boolean, Node> addEdge) {
    JsonObject children = objectOrNull(schema.get(keyword));
    if (children == null) {
      return;
    }
    for (Map.Entry<String, JsonValue> entry : children.values().entrySet()) {
      if (!isSchemaNode(entry.getValue())) {
        continue;
      }
      Node target =
          addEdge.apply(
              new ResolvedSchema(
                  childPointer(childPointer(node.pointer, keyword), entry.getKey()),
                  entry.getValue()),
              false);
      append(transitions, entry.getKey(), target.id);
    }
  }

  private static Components graphComponents(List<List<Edge>> edgesByNode) {
    boolean[] seen = new boolean[edgesByNode.size()];
    List<Integer> finishOrder = new ArrayList<>(edgesByNode.size());
    for (int start = 0; start < edgesByNode.size(); start++) {
      if (seen[start]) {
        continue;
      }
      seen[start] = true;
      ArrayDeque<TraversalFrame> stack = new ArrayDeque<>();
      stack.push(new TraversalFrame(start));
      while (!stack.isEmpty()) {
        TraversalFrame frame = stack.peek();
        List<Edge> edges = edgesByNode.get(frame.node);
        if (frame.nextEdge < edges.size()) {
          int target = edges.get(frame.nextEdge++).target;
          if (!seen[target]) {
            seen[target] = true;
            stack.push(new TraversalFrame(target));
          }
        } else {
          finishOrder.add(frame.node);
          stack.pop();
        }
      }
    }

    List<List<Integer>> reverseEdges = new ArrayList<>(edgesByNode.size());
    for (int index = 0; index < edgesByNode.size(); index++) {
      reverseEdges.add(new ArrayList<>());
    }
    for (int source = 0; source < edgesByNode.size(); source++) {
      for (Edge edge : edgesByNode.get(source)) {
        reverseEdges.get(edge.target).add(source);
      }
    }

    int[] componentByNode = new int[edgesByNode.size()];
    Arrays.fill(componentByNode, -1);
    int componentCount = 0;
    for (int index = finishOrder.size() - 1; index >= 0; index--) {
      int start = finishOrder.get(index);
      if (componentByNode[start] != -1) {
        continue;
      }
      componentByNode[start] = componentCount;
      ArrayDeque<Integer> pending = new ArrayDeque<>();
      pending.push(start);
      while (!pending.isEmpty()) {
        int node = pending.pop();
        for (int source : reverseEdges.get(node)) {
          if (componentByNode[source] == -1) {
            componentByNode[source] = componentCount;
            pending.push(source);
          }
        }
      }
      componentCount++;
    }
    return new Components(componentByNode, componentCount);
  }

  private static Dominance compileDominance(Graph graph) {
    int nodeCount = graph.nodes.size();
    int[] dfsNumberByNode = new int[nodeCount];
    int[] nodeByDfsNumber = new int[nodeCount + 1];
    int[] parent = new int[nodeCount + 1];
    int dfsCount = 1;
    dfsNumberByNode[0] = dfsCount;
    nodeByDfsNumber[dfsCount] = 0;
    ArrayDeque<TraversalFrame> stack = new ArrayDeque<>();
    stack.push(new TraversalFrame(0));
    while (!stack.isEmpty()) {
      TraversalFrame frame = stack.peek();
      List<Edge> edges = graph.nodes.get(frame.node).edges;
      if (frame.nextEdge >= edges.size()) {
        stack.pop();
        continue;
      }
      int target = edges.get(frame.nextEdge++).target;
      if (dfsNumberByNode[target] != 0) {
        continue;
      }
      dfsCount++;
      dfsNumberByNode[target] = dfsCount;
      nodeByDfsNumber[dfsCount] = target;
      parent[dfsCount] = dfsNumberByNode[frame.node];
      stack.push(new TraversalFrame(target));
    }
    if (dfsCount != nodeCount) {
      return null;
    }

    int[] predecessorCounts = new int[nodeCount + 1];
    for (Node source : graph.nodes) {
      for (Edge edge : source.edges) {
        predecessorCounts[dfsNumberByNode[edge.target]]++;
      }
    }
    int[] predecessorOffsets = new int[nodeCount + 2];
    for (int vertex = 1; vertex <= nodeCount; vertex++) {
      predecessorOffsets[vertex + 1] = predecessorOffsets[vertex] + predecessorCounts[vertex];
    }
    int[] predecessorPositions = predecessorOffsets.clone();
    int[] predecessors = new int[graph.edgeCount];
    for (Node source : graph.nodes) {
      int sourceVertex = dfsNumberByNode[source.id];
      for (Edge edge : source.edges) {
        int targetVertex = dfsNumberByNode[edge.target];
        predecessors[predecessorPositions[targetVertex]++] = sourceVertex;
      }
    }

    int[] semi = new int[nodeCount + 1];
    int[] label = new int[nodeCount + 1];
    int[] ancestor = new int[nodeCount + 1];
    int[] immediateDominator = new int[nodeCount + 1];
    int[] bucketHead = new int[nodeCount + 1];
    int[] bucketNext = new int[nodeCount + 1];
    for (int vertex = 1; vertex <= nodeCount; vertex++) {
      semi[vertex] = vertex;
      label[vertex] = vertex;
    }
    List<Integer> compressionPath = new ArrayList<>();
    java.util.function.IntUnaryOperator evaluate =
        vertex -> {
          if (ancestor[vertex] == 0) {
            return label[vertex];
          }
          compressionPath.clear();
          int cursor = vertex;
          while (ancestor[ancestor[cursor]] != 0) {
            compressionPath.add(cursor);
            cursor = ancestor[cursor];
          }
          for (int index = compressionPath.size() - 1; index >= 0; index--) {
            int child = compressionPath.get(index);
            int ancestorVertex = ancestor[child];
            if (semi[label[ancestorVertex]] < semi[label[child]]) {
              label[child] = label[ancestorVertex];
            }
            ancestor[child] = ancestor[ancestorVertex];
          }
          return label[vertex];
        };

    for (int vertex = nodeCount; vertex >= 2; vertex--) {
      for (int position = predecessorOffsets[vertex];
          position < predecessorOffsets[vertex + 1];
          position++) {
        int candidate = evaluate.applyAsInt(predecessors[position]);
        if (semi[candidate] < semi[vertex]) {
          semi[vertex] = semi[candidate];
        }
      }
      bucketNext[vertex] = bucketHead[semi[vertex]];
      bucketHead[semi[vertex]] = vertex;
      int parentVertex = parent[vertex];
      ancestor[vertex] = parentVertex;
      int deferred = bucketHead[parentVertex];
      bucketHead[parentVertex] = 0;
      while (deferred != 0) {
        int next = bucketNext[deferred];
        int candidate = evaluate.applyAsInt(deferred);
        immediateDominator[deferred] = semi[candidate] < semi[deferred] ? candidate : parentVertex;
        deferred = next;
      }
    }
    for (int vertex = 2; vertex <= nodeCount; vertex++) {
      if (immediateDominator[vertex] == 0) {
        return null;
      }
      if (immediateDominator[vertex] != semi[vertex]) {
        immediateDominator[vertex] = immediateDominator[immediateDominator[vertex]];
      }
    }

    int[] childCounts = new int[nodeCount + 1];
    for (int vertex = 2; vertex <= nodeCount; vertex++) {
      childCounts[immediateDominator[vertex]]++;
    }
    int[] childOffsets = new int[nodeCount + 2];
    for (int vertex = 1; vertex <= nodeCount; vertex++) {
      childOffsets[vertex + 1] = childOffsets[vertex] + childCounts[vertex];
    }
    int[] childPositions = childOffsets.clone();
    int[] children = new int[Math.max(0, nodeCount - 1)];
    for (int vertex = 2; vertex <= nodeCount; vertex++) {
      int dominator = immediateDominator[vertex];
      children[childPositions[dominator]++] = vertex;
    }

    int[] enteredAt = new int[nodeCount + 1];
    int[] exitedAt = new int[nodeCount + 1];
    int timestamp = 1;
    enteredAt[1] = timestamp;
    ArrayDeque<DominatorFrame> dominatorStack = new ArrayDeque<>();
    dominatorStack.push(new DominatorFrame(1, childOffsets[1]));
    while (!dominatorStack.isEmpty()) {
      DominatorFrame frame = dominatorStack.peek();
      if (frame.nextChild < childOffsets[frame.vertex + 1]) {
        int child = children[frame.nextChild++];
        timestamp++;
        enteredAt[child] = timestamp;
        dominatorStack.push(new DominatorFrame(child, childOffsets[child]));
      } else {
        exitedAt[frame.vertex] = timestamp;
        dominatorStack.pop();
      }
    }
    return new Dominance(dfsNumberByNode, enteredAt, exitedAt);
  }

  private static boolean[] compileDynamicTaint(Graph graph) {
    boolean[] tainted = new boolean[graph.nodes.size()];
    List<Integer> pending = new ArrayList<>();
    for (Node node : graph.nodes) {
      for (Edge edge : node.edges) {
        if (edge.dynamic && !tainted[edge.target]) {
          tainted[edge.target] = true;
          pending.add(edge.target);
        }
      }
    }
    for (int cursor = 0; cursor < pending.size(); cursor++) {
      for (Edge edge : graph.nodes.get(pending.get(cursor)).edges) {
        if (!tainted[edge.target]) {
          tainted[edge.target] = true;
          pending.add(edge.target);
        }
      }
    }
    return tainted;
  }

  private static Provenance compileRouteProvenance(Graph graph) {
    Dominance dominance = compileDominance(graph);
    if (dominance == null) {
      return null;
    }
    List<List<Edge>> residualEdges = new ArrayList<>(graph.nodes.size());
    for (Node node : graph.nodes) {
      List<Edge> retained = new ArrayList<>();
      for (Edge edge : node.edges) {
        if (!dominance.dominates(edge.target, node.id)) {
          retained.add(edge);
        }
      }
      residualEdges.add(retained);
    }
    Components components = graphComponents(residualEdges);
    List<List<Integer>> componentEdges = new ArrayList<>(components.count);
    for (int index = 0; index < components.count; index++) {
      componentEdges.add(new ArrayList<>());
    }
    int[] indegree = new int[components.count];
    boolean[] ambiguous = new boolean[components.count];
    for (int source = 0; source < residualEdges.size(); source++) {
      int sourceComponent = components.byNode[source];
      for (Edge edge : residualEdges.get(source)) {
        int targetComponent = components.byNode[edge.target];
        if (sourceComponent == targetComponent) {
          ambiguous[sourceComponent] = true;
        } else {
          componentEdges.get(sourceComponent).add(targetComponent);
          indegree[targetComponent]++;
        }
      }
    }

    byte[] routeCounts = new byte[components.count];
    routeCounts[components.byNode[0]] = 1;
    List<Integer> ready = new ArrayList<>();
    for (int component = 0; component < components.count; component++) {
      if (indegree[component] == 0) {
        ready.add(component);
      }
    }
    for (int cursor = 0; cursor < ready.size(); cursor++) {
      int source = ready.get(cursor);
      for (int target : componentEdges.get(source)) {
        if (routeCounts[source] > 0) {
          routeCounts[target] = (byte) Math.min(2, routeCounts[target] + routeCounts[source]);
          if (ambiguous[source]) {
            ambiguous[target] = true;
          }
        }
        indegree[target]--;
        if (indegree[target] == 0) {
          ready.add(target);
        }
      }
    }
    return ready.size() == components.count
        ? new Provenance(components.byNode, routeCounts, ambiguous)
        : null;
  }

  private static SecretRouteGraph compileSecretRouteGraph(
      JsonObject rootSchema, Set<String> schemaPointers) {
    Graph graph = buildInstanceRouteGraph(rootSchema);
    if (graph == null) {
      return null;
    }
    Provenance provenance = compileRouteProvenance(graph);
    if (provenance == null) {
      return null;
    }
    boolean[] dynamicTaint = compileDynamicTaint(graph);
    Set<Integer> secretNodeIds = new HashSet<>();
    Set<String> targetPointers = new HashSet<>();
    for (String schemaPointer : schemaPointers) {
      ResolvedSchema resolved = resolveSchemaPointer(rootSchema, schemaPointer);
      if (resolved == null) {
        return null;
      }
      if (!targetPointers.add(resolved.pointer())) {
        continue;
      }
      Node target = graph.nodesByPointer.get(resolved.pointer());
      if (target == null) {
        return null;
      }
      int component = provenance.componentByNode[target.id];
      boolean falseSchema = isFalseSchema(target.schema);
      if (provenance.routeCounts[component] == 0
          || dynamicTaint[target.id]
          || (!falseSchema
              && (provenance.routeCounts[component] > 1 || provenance.ambiguous[component]))) {
        return null;
      }
      if (!falseSchema) {
        secretNodeIds.add(target.id);
      }
    }
    return new SecretRouteGraph(graph, secretNodeIds);
  }

  private static boolean presetsOmitGraphSecrets(SecretRouteGraph graph, List<JsonObject> presets) {
    int inputNodeCount = 0;
    for (JsonObject preset : presets) {
      inputNodeCount += countJsonNodes(object(preset.get("input")));
    }
    long calculated =
        (long) graph.graph.nodes.size() * 4
            + (long) graph.graph.edgeCount * 2
            + (long) inputNodeCount * 64;
    int visitBudget = (int) Math.min(MAX_PRESET_VISITS, Math.max(8_192L, calculated));
    int visitCount = 0;

    for (JsonObject preset : presets) {
      Map<Integer, Set<JsonValue>> objectVisits = new HashMap<>();
      Set<Integer> primitiveVisits = new HashSet<>();
      ArrayDeque<Visit> pending = new ArrayDeque<>();
      pending.push(new Visit(0, object(preset.get("input"))));
      while (!pending.isEmpty()) {
        Visit visit = pending.pop();
        visitCount++;
        if (visitCount > visitBudget || graph.secretNodeIds.contains(visit.nodeId)) {
          return false;
        }
        Node node = graph.graph.nodes.get(visit.nodeId);
        if (visit.value instanceof JsonObject || visit.value instanceof JsonList) {
          Set<JsonValue> prior =
              objectVisits.computeIfAbsent(
                  visit.nodeId,
                  ignored -> java.util.Collections.newSetFromMap(new IdentityHashMap<>()));
          if (!prior.add(visit.value)) {
            continue;
          }
        } else if (!primitiveVisits.add(visit.nodeId)) {
          continue;
        }
        pushChildVisits(pending, node, visit.value);
      }
    }
    return true;
  }

  private static void pushChildVisits(ArrayDeque<Visit> pending, Node node, JsonValue value) {
    if (value instanceof JsonList list) {
      for (int index = list.values().size() - 1; index >= 0; index--) {
        JsonValue child = list.values().get(index);
        List<Map.Entry<Integer, List<Integer>>> tails = new ArrayList<>(node.arrayTails.entrySet());
        for (Map.Entry<Integer, List<Integer>> tail : tails.reversed()) {
          if (index >= tail.getKey()) {
            for (int target : tail.getValue().reversed()) {
              pending.push(new Visit(target, child));
            }
          }
        }
        List<Integer> indices = node.arrayIndices.getOrDefault(index, List.of());
        for (int target : indices.reversed()) {
          pending.push(new Visit(target, child));
        }
      }
    } else if (value instanceof JsonObject object) {
      List<Map.Entry<String, JsonValue>> entries = new ArrayList<>(object.values().entrySet());
      for (Map.Entry<String, JsonValue> entry : entries.reversed()) {
        List<Integer> dependencies = node.dependentSchemas.getOrDefault(entry.getKey(), List.of());
        for (int target : dependencies.reversed()) {
          pending.push(new Visit(target, value));
        }
        List<Integer> properties = node.properties.getOrDefault(entry.getKey(), List.of());
        for (int target : properties.reversed()) {
          pending.push(new Visit(target, entry.getValue()));
        }
      }
    }
    for (int target : node.sameInstance.reversed()) {
      pending.push(new Visit(target, value));
    }
  }

  private static int countJsonNodes(JsonValue root) {
    int count = 0;
    ArrayDeque<JsonValue> pending = new ArrayDeque<>();
    pending.push(root);
    while (!pending.isEmpty()) {
      JsonValue value = pending.pop();
      count++;
      if (value instanceof JsonObject object) {
        pending.addAll(object.values().values());
      } else if (value instanceof JsonList list) {
        pending.addAll(list.values());
      }
    }
    return count;
  }

  private static ResolvedSchema resolveSchemaPointer(JsonObject rootSchema, String pointer) {
    List<String> segments = decodePointer(pointer);
    if (segments == null) {
      return null;
    }
    JsonValue current = rootSchema;
    for (String segment : segments) {
      if (!(current instanceof JsonObject object)) {
        return null;
      }
      current = object.get(segment);
      if (current == null) {
        return null;
      }
    }
    return isSchemaNode(current) ? new ResolvedSchema(pointerFor(segments), current) : null;
  }

  private static ResolvedSchema resolveLocalReference(JsonObject rootSchema, String reference) {
    if (!reference.startsWith("#")) {
      return null;
    }
    try {
      String pointer =
          URLDecoder.decode(reference.substring(1).replace("+", "%2B"), StandardCharsets.UTF_8);
      return resolveSchemaPointer(rootSchema, pointer);
    } catch (IllegalArgumentException exception) {
      return null;
    }
  }

  private static List<String> decodePointer(String pointer) {
    if (pointer.isEmpty()) {
      return List.of();
    }
    if (!pointer.startsWith("/")) {
      return null;
    }
    List<String> result = new ArrayList<>();
    for (String encoded : pointer.substring(1).split("/", -1)) {
      if (encoded.matches(".*~(?:[^01]|$).*$")) {
        return null;
      }
      result.add(encoded.replace("~1", "/").replace("~0", "~"));
    }
    return List.copyOf(result);
  }

  private static String pointerFor(List<String> segments) {
    if (segments.isEmpty()) {
      return "";
    }
    return "/"
        + segments.stream()
            .map(PresetSecretAnalyzer::escapePointerSegment)
            .collect(java.util.stream.Collectors.joining("/"));
  }

  private static String childPointer(String parent, String segment) {
    return parent + "/" + escapePointerSegment(segment);
  }

  private static String escapePointerSegment(String value) {
    return value.replace("~", "~0").replace("/", "~1");
  }

  private static boolean isSchemaNode(JsonValue value) {
    return value instanceof JsonObject
        || value instanceof JsonValue.Scalar scalar && scalar.value() instanceof Boolean;
  }

  private static boolean isFalseSchema(JsonValue value) {
    return value instanceof JsonValue.Scalar scalar && Boolean.FALSE.equals(scalar.value());
  }

  private static void append(Map<String, List<Integer>> map, String key, int target) {
    map.computeIfAbsent(key, ignored -> new ArrayList<>()).add(target);
  }

  private static void append(Map<Integer, List<Integer>> map, int key, int target) {
    map.computeIfAbsent(key, ignored -> new ArrayList<>()).add(target);
  }

  private static List<JsonObject> objects(JsonValue value) {
    JsonList list = listOrNull(value);
    if (list == null) {
      throw new IllegalArgumentException("expected array");
    }
    return list.values().stream().map(PresetSecretAnalyzer::object).toList();
  }

  private static JsonObject object(JsonValue value) {
    if (!(value instanceof JsonObject object)) {
      throw new IllegalArgumentException("expected object");
    }
    return object;
  }

  private static JsonObject objectOrNull(JsonValue value) {
    return value instanceof JsonObject object ? object : null;
  }

  private static JsonList listOrNull(JsonValue value) {
    return value instanceof JsonList list ? list : null;
  }

  private static String requiredString(JsonObject object, String key) {
    String value = string(object.get(key));
    if (value == null) {
      throw new IllegalArgumentException("missing required value");
    }
    return value;
  }

  private static String string(JsonValue value) {
    return value != null && value.unwrap() instanceof String string ? string : null;
  }

  private record ResolvedSchema(String pointer, JsonValue schema) {}

  private record Edge(int target, boolean dynamic) {}

  private static final class Node {
    private final int id;
    private final String pointer;
    private final JsonValue schema;
    private final List<Edge> edges = new ArrayList<>();
    private final List<Integer> sameInstance = new ArrayList<>();
    private final Map<String, List<Integer>> properties = new LinkedHashMap<>();
    private final Map<String, List<Integer>> dependentSchemas = new LinkedHashMap<>();
    private final Map<Integer, List<Integer>> arrayIndices = new LinkedHashMap<>();
    private final Map<Integer, List<Integer>> arrayTails = new LinkedHashMap<>();

    private Node(int id, String pointer, JsonValue schema) {
      this.id = id;
      this.pointer = pointer;
      this.schema = schema;
    }
  }

  private record Graph(List<Node> nodes, Map<String, Node> nodesByPointer, int edgeCount) {}

  private record SecretRouteGraph(Graph graph, Set<Integer> secretNodeIds) {}

  private static final class TraversalFrame {
    private final int node;
    private int nextEdge;

    private TraversalFrame(int node) {
      this.node = node;
    }
  }

  private static final class DominatorFrame {
    private final int vertex;
    private int nextChild;

    private DominatorFrame(int vertex, int nextChild) {
      this.vertex = vertex;
      this.nextChild = nextChild;
    }
  }

  private record Components(int[] byNode, int count) {}

  private record Provenance(int[] componentByNode, byte[] routeCounts, boolean[] ambiguous) {}

  private record Dominance(int[] dfsNumberByNode, int[] enteredAt, int[] exitedAt) {
    private boolean dominates(int dominatorNode, int node) {
      int dominator = dfsNumberByNode[dominatorNode];
      int dominated = dfsNumberByNode[node];
      return enteredAt[dominator] <= enteredAt[dominated]
          && exitedAt[dominated] <= exitedAt[dominator];
    }
  }

  private record Visit(int nodeId, JsonValue value) {}

  record LocatedValue(JsonValue value, String instancePointer) {}

  private record LocatedVisit(int nodeId, JsonValue value, String instancePointer) {}
}
