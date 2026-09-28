<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Schema;

/**
 * Bounded port of the protocol package's preset-secret route analysis.
 *
 * Schema pointers identify schema locations, while graph transitions identify
 * how those locations apply to JSON instance locations. A secret location is
 * usable only when it has one unambiguous, statically known instance route.
 */
final class PresetSecretAnalyzer
{
    public const MAX_GRAPH_NODES = 250_000;
    public const MAX_GRAPH_EDGES = 500_000;
    public const MAX_PRESET_VISITS = 500_000;
    public const MINIMUM_VISIT_BUDGET = 8_192;
    public const GRAPH_NODE_WEIGHT = 4;
    public const GRAPH_EDGE_WEIGHT = 2;
    public const INPUT_NODE_WEIGHT = 64;
    public const ROUTE_COUNT_SATURATION = 2;

    private const DYNAMIC_INSTANCE_KEYWORDS = [
        'contains',
        'additionalProperties',
        'propertyNames',
        'unevaluatedItems',
        'unevaluatedProperties',
        'contentSchema',
    ];
    private const SAME_INSTANCE_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];
    private const SAME_INSTANCE_KEYWORDS = ['not', 'if', 'then', 'else'];

    /**
     * @param list<string> $schemaPointers
     * @param list<object> $presets
     */
    public static function presetsOmitSecrets(
        \stdClass $rootSchema,
        array $schemaPointers,
        array $presets,
    ): bool {
        $uniquePointers = array_values(array_unique($schemaPointers));
        if ($uniquePointers === []) {
            return true;
        }

        $graph = self::compileSecretRouteGraph($rootSchema, $uniquePointers);
        if ($graph === null) {
            return false;
        }

        return self::presetsOmitGraphSecrets($graph, $presets);
    }

    /**
     * Resolves statically attributable schema locations against one instance.
     * A null result means the route graph or visit budget could not prove a
     * unique safe mapping; an empty list means the locations were absent.
     *
     * @param list<string> $schemaPointers
     * @return list<mixed>|null
     */
    public static function valuesAtSchemaPointers(
        \stdClass $rootSchema,
        array $schemaPointers,
        mixed $instance,
    ): ?array {
        $uniquePointers = array_values(array_unique($schemaPointers));
        if ($uniquePointers === []) {
            return [];
        }
        $graph = self::compileSecretRouteGraph($rootSchema, $uniquePointers);
        if ($graph === null) {
            return null;
        }

        return self::graphTargetValues($graph, $instance);
    }

    /**
     * @return array{
     *   nodes: list<array{
     *     id:int,
     *     pointer:string,
     *     schema:bool|\stdClass,
     *     edges:list<array{target:int,dynamic:bool}>,
     *     same:list<int>,
     *     properties:array<string,list<int>>,
     *     dependent:array<string,list<int>>,
     *     indices:array<int,list<int>>,
     *     tails:array<int,list<int>>
     *   }>,
     *   edgeCount:int,
     *   secretNodeIds:array<int,true>
     * }|null
     */
    private static function compileSecretRouteGraph(\stdClass $rootSchema, array $schemaPointers): ?array
    {
        $graph = self::buildInstanceRouteGraph($rootSchema);
        if ($graph === null) {
            return null;
        }

        $provenance = self::compileRouteProvenance($graph);
        if ($provenance === null) {
            return null;
        }
        $dynamicTaint = self::compileDynamicTaint($graph['nodes']);
        $secretNodeIds = [];
        $targetPointers = [];

        foreach ($schemaPointers as $schemaPointer) {
            $resolved = self::resolveSchemaPointer($rootSchema, $schemaPointer);
            if ($resolved === null) {
                return null;
            }
            $canonicalPointer = $resolved['pointer'];
            if (isset($targetPointers[$canonicalPointer])) {
                continue;
            }
            $targetPointers[$canonicalPointer] = true;
            if (!isset($graph['nodesByPointer'][$canonicalPointer])) {
                return null;
            }

            $targetId = $graph['nodesByPointer'][$canonicalPointer];
            $component = $provenance['componentByNode'][$targetId];
            $routeCount = $provenance['routeCounts'][$component];
            $targetSchema = $graph['nodes'][$targetId]['schema'];
            if (
                $routeCount === 0
                || $dynamicTaint[$targetId]
                || (
                    $targetSchema !== false
                    && ($routeCount > 1 || $provenance['ambiguous'][$component])
                )
            ) {
                return null;
            }
            if ($targetSchema !== false) {
                $secretNodeIds[$targetId] = true;
            }
        }

        return [
            'nodes' => $graph['nodes'],
            'edgeCount' => $graph['edgeCount'],
            'secretNodeIds' => $secretNodeIds,
        ];
    }

    /**
     * @return array{
     *   nodes: list<array{
     *     id:int,
     *     pointer:string,
     *     schema:bool|\stdClass,
     *     edges:list<array{target:int,dynamic:bool}>,
     *     same:list<int>,
     *     properties:array<string,list<int>>,
     *     dependent:array<string,list<int>>,
     *     indices:array<int,list<int>>,
     *     tails:array<int,list<int>>
     *   }>,
     *   nodesByPointer:array<string,int>,
     *   edgeCount:int
     * }|null
     */
    private static function buildInstanceRouteGraph(\stdClass $rootSchema): ?array
    {
        $nodes = [];
        $nodesByPointer = [];
        $edgeCount = 0;

        $ensureNode = static function (string $pointer, bool|\stdClass $schema) use (&$nodes, &$nodesByPointer): int {
            if (array_key_exists($pointer, $nodesByPointer)) {
                return $nodesByPointer[$pointer];
            }
            $id = count($nodes);
            $nodes[] = [
                'id' => $id,
                'pointer' => $pointer,
                'schema' => $schema,
                'edges' => [],
                'same' => [],
                'properties' => [],
                'dependent' => [],
                'indices' => [],
                'tails' => [],
            ];
            $nodesByPointer[$pointer] = $id;

            return $id;
        };

        $addEdge = static function (
            int $source,
            string $pointer,
            bool|\stdClass $schema,
            bool $dynamic,
        ) use (&$nodes, &$edgeCount, $ensureNode): int {
            $target = $ensureNode($pointer, $schema);
            $nodes[$source]['edges'][] = ['target' => $target, 'dynamic' => $dynamic];
            ++$edgeCount;

            return $target;
        };

        $ensureNode('', $rootSchema);
        for ($cursor = 0; $cursor < count($nodes); ++$cursor) {
            if (count($nodes) > self::MAX_GRAPH_NODES || $edgeCount > self::MAX_GRAPH_EDGES) {
                return null;
            }
            $schema = $nodes[$cursor]['schema'];
            if (is_bool($schema)) {
                continue;
            }
            $schemaPointer = $nodes[$cursor]['pointer'];

            if (property_exists($schema, '$ref') && is_string($schema->{'$ref'})) {
                $reference = self::resolveLocalReference($rootSchema, $schema->{'$ref'});
                if ($reference === null) {
                    return null;
                }
                $nodes[$cursor]['same'][] = $addEdge(
                    $cursor,
                    $reference['pointer'],
                    $reference['schema'],
                    false,
                );
            }

            self::appendMapTransitions(
                $nodes,
                $cursor,
                $schemaPointer,
                $schema->properties ?? null,
                'properties',
                'properties',
                $addEdge,
            );
            self::appendMapTransitions(
                $nodes,
                $cursor,
                $schemaPointer,
                $schema->dependentSchemas ?? null,
                'dependentSchemas',
                'dependent',
                $addEdge,
            );

            foreach (self::SAME_INSTANCE_ARRAY_KEYWORDS as $keyword) {
                $children = $schema->{$keyword} ?? null;
                if (!is_array($children)) {
                    continue;
                }
                foreach ($children as $index => $child) {
                    if (!is_bool($child) && !$child instanceof \stdClass) {
                        continue;
                    }
                    $nodes[$cursor]['same'][] = $addEdge(
                        $cursor,
                        self::childPointer(self::childPointer($schemaPointer, $keyword), (string) $index),
                        $child,
                        false,
                    );
                }
            }

            foreach (self::SAME_INSTANCE_KEYWORDS as $keyword) {
                $child = $schema->{$keyword} ?? null;
                if (!is_bool($child) && !$child instanceof \stdClass) {
                    continue;
                }
                $nodes[$cursor]['same'][] = $addEdge(
                    $cursor,
                    self::childPointer($schemaPointer, $keyword),
                    $child,
                    false,
                );
            }

            $prefixItems = is_array($schema->prefixItems ?? null) ? $schema->prefixItems : [];
            foreach ($prefixItems as $index => $child) {
                if (!is_bool($child) && !$child instanceof \stdClass) {
                    continue;
                }
                $target = $addEdge(
                    $cursor,
                    self::childPointer(self::childPointer($schemaPointer, 'prefixItems'), (string) $index),
                    $child,
                    false,
                );
                $nodes[$cursor]['indices'][$index][] = $target;
            }

            $items = $schema->items ?? null;
            if (is_bool($items) || $items instanceof \stdClass) {
                $target = $addEdge(
                    $cursor,
                    self::childPointer($schemaPointer, 'items'),
                    $items,
                    false,
                );
                $nodes[$cursor]['tails'][count($prefixItems)][] = $target;
            }

            $patternProperties = $schema->patternProperties ?? null;
            if ($patternProperties instanceof \stdClass) {
                foreach (get_object_vars($patternProperties) as $pattern => $child) {
                    if (!is_bool($child) && !$child instanceof \stdClass) {
                        continue;
                    }
                    $addEdge(
                        $cursor,
                        self::childPointer(self::childPointer($schemaPointer, 'patternProperties'), $pattern),
                        $child,
                        true,
                    );
                }
            }

            foreach (self::DYNAMIC_INSTANCE_KEYWORDS as $keyword) {
                $child = $schema->{$keyword} ?? null;
                if (!is_bool($child) && !$child instanceof \stdClass) {
                    continue;
                }
                $addEdge(
                    $cursor,
                    self::childPointer($schemaPointer, $keyword),
                    $child,
                    true,
                );
            }
        }

        if (count($nodes) > self::MAX_GRAPH_NODES || $edgeCount > self::MAX_GRAPH_EDGES) {
            return null;
        }

        return [
            'nodes' => $nodes,
            'nodesByPointer' => $nodesByPointer,
            'edgeCount' => $edgeCount,
        ];
    }

    /**
     * @param list<array<string, mixed>> $nodes
     * @param callable(int,string,bool|\stdClass,bool):int $addEdge
     */
    private static function appendMapTransitions(
        array &$nodes,
        int $source,
        string $schemaPointer,
        mixed $children,
        string $schemaKeyword,
        string $transitionKey,
        callable $addEdge,
    ): void {
        if (!$children instanceof \stdClass) {
            return;
        }
        foreach (get_object_vars($children) as $property => $child) {
            if (!is_bool($child) && !$child instanceof \stdClass) {
                continue;
            }
            $target = $addEdge(
                $source,
                self::childPointer(self::childPointer($schemaPointer, $schemaKeyword), $property),
                $child,
                false,
            );
            $nodes[$source][$transitionKey][$property][] = $target;
        }
    }

    /**
     * @param array{nodes:list<array<string,mixed>>,edgeCount:int} $graph
     * @return array{componentByNode:list<int>,routeCounts:list<int>,ambiguous:list<bool>}|null
     */
    private static function compileRouteProvenance(array $graph): ?array
    {
        $dominates = self::compileDominance($graph['nodes']);
        if ($dominates === null) {
            return null;
        }

        $residualEdges = [];
        foreach ($graph['nodes'] as $node) {
            $residualEdges[$node['id']] = [];
            foreach ($node['edges'] as $edge) {
                if (!$dominates($edge['target'], $node['id'])) {
                    $residualEdges[$node['id']][] = $edge;
                }
            }
        }

        [$componentByNode, $componentCount] = self::graphComponents($residualEdges);
        $componentEdges = array_fill(0, $componentCount, []);
        $indegree = array_fill(0, $componentCount, 0);
        $ambiguous = array_fill(0, $componentCount, false);
        foreach ($residualEdges as $source => $edges) {
            $sourceComponent = $componentByNode[$source];
            foreach ($edges as $edge) {
                $targetComponent = $componentByNode[$edge['target']];
                if ($sourceComponent === $targetComponent) {
                    $ambiguous[$sourceComponent] = true;
                    continue;
                }
                $componentEdges[$sourceComponent][] = $targetComponent;
                ++$indegree[$targetComponent];
            }
        }

        $routeCounts = array_fill(0, $componentCount, 0);
        $routeCounts[$componentByNode[0]] = 1;
        $ready = [];
        foreach ($indegree as $component => $degree) {
            if ($degree === 0) {
                $ready[] = $component;
            }
        }
        for ($cursor = 0; $cursor < count($ready); ++$cursor) {
            $source = $ready[$cursor];
            foreach ($componentEdges[$source] as $target) {
                if ($routeCounts[$source] > 0) {
                    $routeCounts[$target] = min(
                        self::ROUTE_COUNT_SATURATION,
                        $routeCounts[$target] + $routeCounts[$source],
                    );
                    if ($ambiguous[$source]) {
                        $ambiguous[$target] = true;
                    }
                }
                --$indegree[$target];
                if ($indegree[$target] === 0) {
                    $ready[] = $target;
                }
            }
        }

        if (count($ready) !== $componentCount) {
            return null;
        }

        return compact('componentByNode', 'routeCounts', 'ambiguous');
    }

    /**
     * Computes immediate dominators with the iterative Cooper-Harvey-Kennedy
     * algorithm, then indexes the dominator tree for constant-time queries.
     *
     * @param list<array<string,mixed>> $nodes
     * @return (callable(int,int):bool)|null
     */
    private static function compileDominance(array $nodes): ?callable
    {
        $nodeCount = count($nodes);
        if ($nodeCount === 0) {
            return null;
        }

        $seen = array_fill(0, $nodeCount, false);
        $postorder = [];
        $seen[0] = true;
        $stack = [['node' => 0, 'next' => 0]];
        while ($stack !== []) {
            $last = array_key_last($stack);
            $node = $stack[$last]['node'];
            $edges = $nodes[$node]['edges'];
            if ($stack[$last]['next'] < count($edges)) {
                $target = $edges[$stack[$last]['next']]['target'];
                ++$stack[$last]['next'];
                if (!$seen[$target]) {
                    $seen[$target] = true;
                    $stack[] = ['node' => $target, 'next' => 0];
                }
                continue;
            }
            $postorder[] = $node;
            array_pop($stack);
        }
        if (count($postorder) !== $nodeCount) {
            return null;
        }

        $reversePostorder = array_reverse($postorder);
        $order = [];
        foreach ($reversePostorder as $index => $node) {
            $order[$node] = $index;
        }
        $predecessors = array_fill(0, $nodeCount, []);
        foreach ($nodes as $source => $node) {
            foreach ($node['edges'] as $edge) {
                $predecessors[$edge['target']][] = $source;
            }
        }

        $idom = array_fill(0, $nodeCount, -1);
        $idom[0] = 0;
        $intersect = static function (int $left, int $right) use (&$idom, $order): int {
            while ($left !== $right) {
                while ($order[$left] > $order[$right]) {
                    $left = $idom[$left];
                }
                while ($order[$right] > $order[$left]) {
                    $right = $idom[$right];
                }
            }

            return $left;
        };

        do {
            $changed = false;
            foreach (array_slice($reversePostorder, 1) as $node) {
                $processed = array_values(array_filter(
                    $predecessors[$node],
                    static fn (int $predecessor): bool => $idom[$predecessor] !== -1,
                ));
                if ($processed === []) {
                    continue;
                }
                $newIdom = array_shift($processed);
                foreach ($processed as $predecessor) {
                    $newIdom = $intersect($predecessor, $newIdom);
                }
                if ($idom[$node] !== $newIdom) {
                    $idom[$node] = $newIdom;
                    $changed = true;
                }
            }
        } while ($changed);

        if (in_array(-1, $idom, true)) {
            return null;
        }

        $children = array_fill(0, $nodeCount, []);
        for ($node = 1; $node < $nodeCount; ++$node) {
            $children[$idom[$node]][] = $node;
        }
        $enteredAt = array_fill(0, $nodeCount, 0);
        $exitedAt = array_fill(0, $nodeCount, 0);
        $timestamp = 1;
        $enteredAt[0] = $timestamp;
        $stack = [['node' => 0, 'next' => 0]];
        while ($stack !== []) {
            $last = array_key_last($stack);
            $node = $stack[$last]['node'];
            if ($stack[$last]['next'] < count($children[$node])) {
                $child = $children[$node][$stack[$last]['next']];
                ++$stack[$last]['next'];
                $enteredAt[$child] = ++$timestamp;
                $stack[] = ['node' => $child, 'next' => 0];
                continue;
            }
            $exitedAt[$node] = $timestamp;
            array_pop($stack);
        }

        return static fn (int $dominator, int $node): bool =>
            $enteredAt[$dominator] <= $enteredAt[$node]
            && $exitedAt[$node] <= $exitedAt[$dominator];
    }

    /**
     * @param list<list<array{target:int,dynamic:bool}>> $edgesByNode
     * @return array{list<int>,int}
     */
    private static function graphComponents(array $edgesByNode): array
    {
        $nodeCount = count($edgesByNode);
        $seen = array_fill(0, $nodeCount, false);
        $finishOrder = [];
        for ($start = 0; $start < $nodeCount; ++$start) {
            if ($seen[$start]) {
                continue;
            }
            $seen[$start] = true;
            $stack = [['node' => $start, 'next' => 0]];
            while ($stack !== []) {
                $last = array_key_last($stack);
                $node = $stack[$last]['node'];
                if ($stack[$last]['next'] < count($edgesByNode[$node])) {
                    $target = $edgesByNode[$node][$stack[$last]['next']]['target'];
                    ++$stack[$last]['next'];
                    if (!$seen[$target]) {
                        $seen[$target] = true;
                        $stack[] = ['node' => $target, 'next' => 0];
                    }
                    continue;
                }
                $finishOrder[] = $node;
                array_pop($stack);
            }
        }

        $reverseEdges = array_fill(0, $nodeCount, []);
        foreach ($edgesByNode as $source => $edges) {
            foreach ($edges as $edge) {
                $reverseEdges[$edge['target']][] = $source;
            }
        }
        $componentByNode = array_fill(0, $nodeCount, -1);
        $componentCount = 0;
        for ($index = count($finishOrder) - 1; $index >= 0; --$index) {
            $start = $finishOrder[$index];
            if ($componentByNode[$start] !== -1) {
                continue;
            }
            $componentByNode[$start] = $componentCount;
            $pending = [$start];
            while ($pending !== []) {
                $node = array_pop($pending);
                foreach ($reverseEdges[$node] as $source) {
                    if ($componentByNode[$source] === -1) {
                        $componentByNode[$source] = $componentCount;
                        $pending[] = $source;
                    }
                }
            }
            ++$componentCount;
        }

        return [$componentByNode, $componentCount];
    }

    /** @param list<array<string,mixed>> $nodes @return list<bool> */
    private static function compileDynamicTaint(array $nodes): array
    {
        $tainted = array_fill(0, count($nodes), false);
        $pending = [];
        foreach ($nodes as $node) {
            foreach ($node['edges'] as $edge) {
                if (!$edge['dynamic'] || $tainted[$edge['target']]) {
                    continue;
                }
                $tainted[$edge['target']] = true;
                $pending[] = $edge['target'];
            }
        }
        for ($cursor = 0; $cursor < count($pending); ++$cursor) {
            foreach ($nodes[$pending[$cursor]]['edges'] as $edge) {
                if (!$tainted[$edge['target']]) {
                    $tainted[$edge['target']] = true;
                    $pending[] = $edge['target'];
                }
            }
        }

        return $tainted;
    }

    /**
     * @param array{nodes:list<array<string,mixed>>,edgeCount:int,secretNodeIds:array<int,true>} $graph
     * @param list<object> $presets
     */
    private static function presetsOmitGraphSecrets(array $graph, array $presets): bool
    {
        $inputNodeCount = 0;
        foreach ($presets as $preset) {
            if (!property_exists($preset, 'input')) {
                return false;
            }
            $inputNodeCount += self::countJsonNodes($preset->input);
        }
        $visitBudget = min(
            self::MAX_PRESET_VISITS,
            max(
                self::MINIMUM_VISIT_BUDGET,
                count($graph['nodes']) * self::GRAPH_NODE_WEIGHT
                    + $graph['edgeCount'] * self::GRAPH_EDGE_WEIGHT
                    + $inputNodeCount * self::INPUT_NODE_WEIGHT,
            ),
        );
        $visitCount = 0;

        foreach ($presets as $preset) {
            $seen = [];
            $continuations = [];
            $current = ['nodeId' => 0, 'value' => $preset->input, 'path' => ''];
            while ($current !== null) {
                $nodeId = $current['nodeId'];
                ++$visitCount;
                if ($visitCount > $visitBudget || isset($graph['secretNodeIds'][$nodeId])) {
                    return false;
                }

                $visitKey = $nodeId . "\0" . $current['path'];
                if (isset($seen[$visitKey])) {
                    $current = self::resume($continuations);
                    continue;
                }
                $seen[$visitKey] = true;

                $continuation = self::childVisits(
                    $graph['nodes'][$nodeId],
                    $current['value'],
                    $current['path'],
                );
                $continuation->rewind();
                if (!$continuation->valid()) {
                    $current = self::resume($continuations);
                    continue;
                }
                $current = $continuation->current();
                $continuation->next();
                $continuations[] = $continuation;
            }
        }

        return true;
    }

    /**
     * @param array{nodes:list<array<string,mixed>>,edgeCount:int,secretNodeIds:array<int,true>} $graph
     * @return list<mixed>|null
     */
    private static function graphTargetValues(array $graph, mixed $instance): ?array
    {
        $visitBudget = min(
            self::MAX_PRESET_VISITS,
            max(
                self::MINIMUM_VISIT_BUDGET,
                count($graph['nodes']) * self::GRAPH_NODE_WEIGHT
                    + $graph['edgeCount'] * self::GRAPH_EDGE_WEIGHT
                    + self::countJsonNodes($instance) * self::INPUT_NODE_WEIGHT,
            ),
        );
        $visitCount = 0;
        $values = [];
        $seen = [];
        $continuations = [];
        $current = ['nodeId' => 0, 'value' => $instance, 'path' => ''];

        while ($current !== null) {
            $nodeId = $current['nodeId'];
            ++$visitCount;
            if ($visitCount > $visitBudget) {
                return null;
            }
            $visitKey = $nodeId . "\0" . $current['path'];
            if (isset($seen[$visitKey])) {
                $current = self::resume($continuations);
                continue;
            }
            $seen[$visitKey] = true;

            if (isset($graph['secretNodeIds'][$nodeId])) {
                $values[] = $current['value'];
                $current = self::resume($continuations);
                continue;
            }

            $continuation = self::childVisits(
                $graph['nodes'][$nodeId],
                $current['value'],
                $current['path'],
            );
            $continuation->rewind();
            if (!$continuation->valid()) {
                $current = self::resume($continuations);
                continue;
            }
            $current = $continuation->current();
            $continuation->next();
            $continuations[] = $continuation;
        }

        return $values;
    }

    /** @param list<\Generator> $continuations @return array{nodeId:int,value:mixed,path:string}|null */
    private static function resume(array &$continuations): ?array
    {
        while ($continuations !== []) {
            $last = array_key_last($continuations);
            $continuation = $continuations[$last];
            if ($continuation->valid()) {
                $current = $continuation->current();
                $continuation->next();

                return $current;
            }
            array_pop($continuations);
        }

        return null;
    }

    /**
     * @param array<string,mixed> $node
     * @return \Generator<int,array{nodeId:int,value:mixed,path:string}>
     */
    private static function childVisits(array $node, mixed $value, string $path): \Generator
    {
        foreach ($node['same'] as $target) {
            yield ['nodeId' => $target, 'value' => $value, 'path' => $path];
        }

        if (is_array($value)) {
            foreach ($value as $index => $childValue) {
                $childPath = self::childPointer($path, (string) $index);
                foreach ($node['indices'][$index] ?? [] as $target) {
                    yield ['nodeId' => $target, 'value' => $childValue, 'path' => $childPath];
                }
                foreach ($node['tails'] as $firstIndex => $targets) {
                    if ($index < $firstIndex) {
                        continue;
                    }
                    foreach ($targets as $target) {
                        yield ['nodeId' => $target, 'value' => $childValue, 'path' => $childPath];
                    }
                }
            }

            return;
        }

        if (!$value instanceof \stdClass) {
            return;
        }
        foreach (get_object_vars($value) as $property => $childValue) {
            $childPath = self::childPointer($path, $property);
            foreach ($node['properties'][$property] ?? [] as $target) {
                yield ['nodeId' => $target, 'value' => $childValue, 'path' => $childPath];
            }
            foreach ($node['dependent'][$property] ?? [] as $target) {
                yield ['nodeId' => $target, 'value' => $value, 'path' => $path];
            }
        }
    }

    private static function countJsonNodes(mixed $root): int
    {
        $count = 0;
        $pending = [$root];
        while ($pending !== []) {
            $value = array_pop($pending);
            ++$count;
            if (is_array($value)) {
                foreach ($value as $child) {
                    if (is_array($child) || $child instanceof \stdClass) {
                        $pending[] = $child;
                    } else {
                        ++$count;
                    }
                }
            } elseif ($value instanceof \stdClass) {
                foreach (get_object_vars($value) as $child) {
                    if (is_array($child) || $child instanceof \stdClass) {
                        $pending[] = $child;
                    } else {
                        ++$count;
                    }
                }
            }
        }

        return $count;
    }

    /** @return array{pointer:string,schema:bool|\stdClass}|null */
    private static function resolveLocalReference(\stdClass $rootSchema, string $reference): ?array
    {
        if (!str_starts_with($reference, '#')) {
            return null;
        }
        $decoded = rawurldecode(substr($reference, 1));

        return self::resolveSchemaPointer($rootSchema, $decoded);
    }

    /** @return array{pointer:string,schema:bool|\stdClass}|null */
    private static function resolveSchemaPointer(\stdClass $rootSchema, string $pointer): ?array
    {
        $segments = self::decodePointer($pointer);
        if ($segments === null) {
            return null;
        }
        $current = $rootSchema;
        $canonical = '';
        foreach ($segments as $segment) {
            if (!$current instanceof \stdClass || !property_exists($current, $segment)) {
                return null;
            }
            $current = $current->{$segment};
            $canonical = self::childPointer($canonical, $segment);
        }
        if (!is_bool($current) && !$current instanceof \stdClass) {
            return null;
        }

        return ['pointer' => $canonical, 'schema' => $current];
    }

    /** @return list<string>|null */
    private static function decodePointer(string $pointer): ?array
    {
        if ($pointer === '') {
            return [];
        }
        if (!str_starts_with($pointer, '/')) {
            return null;
        }
        $segments = [];
        foreach (explode('/', substr($pointer, 1)) as $encoded) {
            if (preg_match('/~(?:[^01]|$)/', $encoded) === 1) {
                return null;
            }
            $segments[] = str_replace(['~1', '~0'], ['/', '~'], $encoded);
        }

        return $segments;
    }

    private static function childPointer(string $parent, string $segment): string
    {
        return $parent . '/' . str_replace(['~', '/'], ['~0', '~1'], $segment);
    }
}
