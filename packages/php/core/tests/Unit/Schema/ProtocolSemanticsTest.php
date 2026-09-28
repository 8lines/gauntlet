<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Schema;

use EightLines\Gauntlet\Core\Schema\PresetSecretAnalyzer;
use EightLines\Gauntlet\Core\Schema\ProtocolSemantics;
use Opis\JsonSchema\CompliantValidator;
use PHPUnit\Framework\TestCase;

final class ProtocolSemanticsTest extends TestCase
{
    private const ARTIFACT_SHA256 = 'eda4d229cb32beb7aa37e9e09df67c3b66cef29d30667af0376b66ae6b075331';
    private const SCHEMA_SHA256 = '0200906fd69b625bc8b696bbc781441dfd0f5f2908181c2448f91b8a11369368';

    public function testSharedArtifactIsDraft202012ValidAndHasExactly117UniqueOutcomeIds(): void
    {
        [$artifact] = self::fixture();
        self::assertSame('tc-adapter-semantic-vectors@1', $artifact->format);
        self::assertSame('rfc6902-test-subset@1', $artifact->patchProfile);
        self::assertSame('tc-preset-operation@1', $artifact->presetAssemblyProfile);
        self::assertSame('tc-preset-workloads@1', $artifact->workloadProfile);
        self::assertCount(56, $artifact->documentVectors);
        self::assertCount(7, $artifact->workloads);

        $ids = array_map(static fn (object $vector): string => $vector->id, $artifact->documentVectors);
        foreach ($artifact->presetSuites as $suite) {
            foreach ($suite->cases as $case) {
                $ids[] = $suite->id . '.' . $case->id;
            }
        }
        foreach ($artifact->workloads as $workload) {
            $ids[] = $workload->id;
        }

        self::assertCount(117, $ids);
        self::assertCount(117, array_unique($ids));
        foreach ($ids as $id) {
            self::assertMatchesRegularExpression('/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/', $id);
        }
    }

    public function testAll54SharedPresetCasesHaveTheExactSemanticOutcome(): void
    {
        [$artifact, $operation] = self::fixture();
        $count = 0;
        foreach ($artifact->presetSuites as $suite) {
            foreach ($suite->cases as $case) {
                ++$count;
                $candidate = self::copy($operation);
                $candidate->inputSchema = self::copy($suite->inputSchema);
                $candidate->inputHandling = (object) [
                    'rules' => array_map(
                        static fn (string $pointer): object => (object) [
                            'kind' => 'secret',
                            'schemaPointer' => $pointer,
                            'retention' => 'none',
                        ],
                        $suite->secretPointers,
                    ),
                ];
                $candidate->dataSources = [];
                unset($candidate->uiSchema);
                $candidate->presets = array_map(
                    static fn (object $input, int $index): object => (object) [
                        'id' => 'preset-' . $index,
                        'label' => 'Preset ' . $index,
                        'input' => self::copy($input),
                    ],
                    $case->presetInputs,
                    array_keys($case->presetInputs),
                );
                $candidate->revision = $case->expectedRevision;

                self::assertSame(
                    $case->expected,
                    ProtocolSemantics::operationSemanticsAreValid($candidate),
                    $suite->id . '.' . $case->id,
                );
            }
        }
        self::assertSame(54, $count);
    }

    public function testAll56SharedDocumentVectorsHaveTheExactSemanticOutcome(): void
    {
        [$artifact] = self::fixture();
        $sources = self::sources($artifact);
        $count = 0;

        foreach ($artifact->documentVectors as $vector) {
            ++$count;
            if ($vector->predicate === 'resolve') {
                $request = self::patched(
                    self::copy($sources[$vector->request->source]),
                    $vector->request->patches,
                );
                $response = self::patched(
                    self::copy($sources[$vector->response->source]),
                    $vector->response->patches,
                );
                $actual = ProtocolSemantics::resolveSemanticsAreValid($request, $response);
            } else {
                $document = self::patched(
                    self::copy($sources[$vector->document->source]),
                    $vector->document->patches,
                );
                if ($vector->document->revision->mode === 'set') {
                    $revisionField = $vector->predicate === 'manifest' ? 'manifestRevision' : 'revision';
                    $document->{$revisionField} = $vector->document->revision->value;
                }
                $actual = $vector->predicate === 'manifest'
                    ? ProtocolSemantics::manifestSemanticsAreValid($document)
                    : ProtocolSemantics::operationSemanticsAreValid($document);
            }

            self::assertSame($vector->expected, $actual, $vector->id);
        }

        self::assertSame(56, $count);
    }

    public function testAllSevenClosedWorkloadsMatchTheSharedAnalyzerOutcomesAndLimits(): void
    {
        [$artifact] = self::fixture();
        self::assertSame(
            [
                'maxGraphNodes' => PresetSecretAnalyzer::MAX_GRAPH_NODES,
                'maxGraphEdges' => PresetSecretAnalyzer::MAX_GRAPH_EDGES,
                'maxPresetVisits' => PresetSecretAnalyzer::MAX_PRESET_VISITS,
                'minimumVisitBudget' => PresetSecretAnalyzer::MINIMUM_VISIT_BUDGET,
                'graphNodeWeight' => PresetSecretAnalyzer::GRAPH_NODE_WEIGHT,
                'graphEdgeWeight' => PresetSecretAnalyzer::GRAPH_EDGE_WEIGHT,
                'inputNodeWeight' => PresetSecretAnalyzer::INPUT_NODE_WEIGHT,
                'routeCountSaturation' => PresetSecretAnalyzer::ROUTE_COUNT_SATURATION,
            ],
            get_object_vars($artifact->presetAnalysisLimits),
        );

        $allowedKinds = [
            'deep-chain',
            'rules-presets-cartesian',
            'dense-mutual-reference',
            'wide-array',
        ];
        $count = 0;
        foreach ($artifact->workloads as $workload) {
            ++$count;
            self::assertContains($workload->recipe->kind, $allowedKinds, $workload->id);
            [$schema, $secretPointers, $presets] = self::materializeWorkload($workload);
            self::assertSame(
                $workload->expected,
                PresetSecretAnalyzer::presetsOmitSecrets($schema, $secretPointers, $presets),
                $workload->id,
            );
        }
        self::assertSame(7, $count);
    }

    /** @return array{object, object} */
    private static function fixture(): array
    {
        $root = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1';
        $artifactBytes = file_get_contents($root . '/adapter-semantic-vectors.json');
        $schemaBytes = file_get_contents($root . '/adapter-semantic-vectors.schema.json');
        self::assertIsString($artifactBytes);
        self::assertIsString($schemaBytes);
        self::assertSame(self::ARTIFACT_SHA256, hash('sha256', $artifactBytes));
        self::assertSame(self::SCHEMA_SHA256, hash('sha256', $schemaBytes));
        $artifact = json_decode($artifactBytes, false, 512, JSON_THROW_ON_ERROR);
        $artifactSchema = json_decode($schemaBytes, false, 512, JSON_THROW_ON_ERROR);
        self::assertTrue((new CompliantValidator())->validate($artifact, $artifactSchema)->isValid());
        $operationBytes = file_get_contents($root . '/operation.valid.json');
        self::assertIsString($operationBytes);

        return [$artifact, json_decode($operationBytes, false, 512, JSON_THROW_ON_ERROR)];
    }

    /** @return array<string, object> */
    private static function sources(object $artifact): array
    {
        $root = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1';
        $sources = [];
        foreach ($artifact->sourceFixtures as $source) {
            $bytes = file_get_contents($root . '/' . $source->file);
            self::assertIsString($bytes);
            self::assertSame($source->sha256, 'sha256:' . hash('sha256', $bytes), $source->id);
            $sources[$source->id] = json_decode($bytes, false, 512, JSON_THROW_ON_ERROR);
        }

        return $sources;
    }

    /** @param list<object> $patches */
    private static function patched(object $document, array $patches): object
    {
        foreach ($patches as $patch) {
            $value = $patch->op === 'copy'
                ? self::copyValue(self::pointerValue($document, $patch->from))
                : ($patch->value ?? null);
            [$parent, $token] = self::pointerParent($document, $patch->path);
            if (is_array($parent)) {
                $index = $token === '-' ? count($parent) : (int) $token;
                if ($patch->op === 'add' || $patch->op === 'copy') {
                    array_splice($parent, $index, 0, [$value]);
                } elseif ($patch->op === 'remove') {
                    array_splice($parent, $index, 1);
                } else {
                    $parent[$index] = $value;
                }
                self::writePointerParent($document, $patch->path, $parent);
            } elseif ($patch->op === 'remove') {
                unset($parent->{$token});
            } else {
                $parent->{$token} = $value;
            }
        }

        return $document;
    }

    private static function pointerValue(object $document, string $pointer): mixed
    {
        $current = $document;
        foreach (self::pointerSegments($pointer) as $segment) {
            $current = is_array($current) ? $current[(int) $segment] : $current->{$segment};
        }

        return $current;
    }

    /** @return array{object|array<mixed>, string} */
    private static function pointerParent(object $document, string $pointer): array
    {
        $segments = self::pointerSegments($pointer);
        $token = array_pop($segments);
        self::assertIsString($token);
        $current = $document;
        foreach ($segments as $segment) {
            $current = is_array($current) ? $current[(int) $segment] : $current->{$segment};
        }

        return [$current, $token];
    }

    /** @param array<mixed> $replacement */
    private static function writePointerParent(object $document, string $pointer, array $replacement): void
    {
        $segments = self::pointerSegments($pointer);
        array_pop($segments);
        if ($segments === []) {
            throw new \LogicException('Root arrays are not used by the semantic fixture.');
        }
        $token = array_pop($segments);
        $current = $document;
        foreach ($segments as $segment) {
            $current = is_array($current) ? $current[(int) $segment] : $current->{$segment};
        }
        if (is_array($current)) {
            $current[(int) $token] = $replacement;
        } else {
            $current->{$token} = $replacement;
        }
    }

    /** @return list<string> */
    private static function pointerSegments(string $pointer): array
    {
        return array_map(
            static fn (string $segment): string => str_replace(['~1', '~0'], ['/', '~'], $segment),
            explode('/', substr($pointer, 1)),
        );
    }

    private static function copyValue(mixed $value): mixed
    {
        return unserialize(serialize($value), ['allowed_classes' => [\stdClass::class]]);
    }

    /** @return array{\stdClass,list<string>,list<object>} */
    private static function materializeWorkload(object $workload): array
    {
        $recipe = $workload->recipe;
        if ($recipe->kind === 'deep-chain') {
            $schema = json_decode(
                '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",'
                . '"properties":{"chain":{"$ref":"#/$defs/node"}},"$defs":{"node":{"type":"object",'
                . '"properties":{"secret":{"$ref":"#/$defs/target"},"next":{"$ref":"#/$defs/node"}}},'
                . '"target":{"type":"string"}}}',
                false,
                512,
                JSON_THROW_ON_ERROR,
            );
            $node = $recipe->leaf === 'secret' ? (object) ['secret' => 'seeded'] : new \stdClass();
            for ($depth = 0; $depth < $recipe->depth; ++$depth) {
                $node = (object) ['next' => $node];
            }

            return [
                $schema,
                $recipe->secretPointer ? ['/$defs/target'] : [],
                [(object) ['input' => (object) ['chain' => $node]]],
            ];
        }

        if ($recipe->kind === 'rules-presets-cartesian') {
            $properties = new \stdClass();
            $pointers = [];
            for ($index = 0; $index < $recipe->propertyCount; ++$index) {
                $properties->{'secret' . $index} = (object) ['type' => 'string'];
                $pointers[] = '/properties/secret' . $index;
            }
            $schema = (object) [
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'properties' => $properties,
                'additionalProperties' => false,
            ];

            return [
                $schema,
                array_merge(...array_fill(0, $recipe->ruleCopies, $pointers)),
                array_map(
                    static fn (): object => (object) ['input' => new \stdClass()],
                    range(1, $recipe->presetCount),
                ),
            ];
        }

        if ($recipe->kind === 'dense-mutual-reference') {
            $definitions = new \stdClass();
            for ($source = 0; $source < $recipe->graphSize; ++$source) {
                $properties = new \stdClass();
                for ($target = 0; $target < $recipe->graphSize; ++$target) {
                    $properties->{'p' . $target} = (object) ['$ref' => '#/$defs/n' . $target];
                }
                $definitions->{'n' . $source} = (object) [
                    'type' => 'object',
                    'properties' => $properties,
                ];
            }
            $schema = (object) [
                '$schema' => 'https://json-schema.org/draft/2020-12/schema',
                'type' => 'object',
                'properties' => (object) [
                    'start' => (object) ['$ref' => '#/$defs/n0'],
                    'secret' => (object) ['type' => 'string'],
                ],
                '$defs' => $definitions,
            ];

            return [$schema, ['/properties/secret'], [(object) ['input' => new \stdClass()]]];
        }

        if ($recipe->kind === 'wide-array') {
            $schema = json_decode(
                '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object",'
                . '"properties":{"values":{"type":"array","items":{"$ref":"#/$defs/target"}}},'
                . '"$defs":{"target":{"type":"string"}}}',
                false,
                512,
                JSON_THROW_ON_ERROR,
            );

            return [
                $schema,
                $recipe->secretRule ? ['/$defs/target'] : [],
                [(object) ['input' => (object) ['values' => array_fill(0, $recipe->itemCount, 'x')]]],
            ];
        }

        throw new \LogicException('Unknown closed workload recipe.');
    }

    private static function copy(object $value): object
    {
        return unserialize(serialize($value), ['allowed_classes' => [\stdClass::class]]);
    }
}
