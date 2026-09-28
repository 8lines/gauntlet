<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Definition;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Json\Rfc8785CanonicalJson;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolRequirements;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;
use EightLines\Gauntlet\Core\Schema\PlacementRules;
use EightLines\Gauntlet\Core\Schema\PresetSecretAnalyzer;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;

final readonly class OperationDefinition
{
    /**
     * @param list<DataSourceReference> $dataSources
     * @param list<OperationPreset> $presets
     * @param list<string> $tags
     * @param class-string|null $inputClass
     * @param list<OperationPlacement> $placements
     */
    public function __construct(
        public string $id,
        public string $featureId,
        public string $label,
        public ?string $description,
        public JsonObject $inputSchema,
        public ?InputHandling $inputHandling,
        public ?JsonObject $contextSchema,
        public ?OperationUiSchema $uiSchema,
        public array $dataSources,
        public array $presets,
        public ExecutionPolicy $execution,
        public OperationOutput $output,
        public ?string $icon = null,
        public int $order = 0,
        public array $tags = [],
        public ?ProtocolRequirements $requirements = null,
        public ?ProtocolExtensions $extensions = null,
        public ?string $inputClass = null,
        public array $placements = [],
    ) {
        ProtocolId::assert($id);
        ProtocolId::assert($featureId);
        ProtocolValue::assertNonBlank($label, 'Operation label');
        TcSchemaCore::assert($inputSchema, true);
        if ($contextSchema !== null) {
            TcSchemaCore::assert($contextSchema, true);
        }
        self::assertDefinitions($dataSources, DataSourceReference::class, 'data source reference');
        self::assertDefinitions($presets, OperationPreset::class, 'operation preset');
        ProtocolValue::assertUniqueStrings($tags, 'operation tags');
        if ($inputClass !== null && trim($inputClass) === '') {
            throw new \InvalidArgumentException('Input class must not be blank.');
        }
        if ($inputHandling !== null) {
            self::assertInputHandlingIsAttributable($inputSchema, $inputHandling, $presets);
        }
        self::assertDefinitions($placements, OperationPlacement::class, 'operation placement');
        if ($placements !== [] && !PlacementRules::areValid(
            json_decode(json_encode($inputSchema, JSON_THROW_ON_ERROR)),
            array_map(static fn (array $rule): string => $rule['schemaPointer'], $inputHandling?->rules ?? []),
            json_decode(json_encode(array_map(
                static fn (OperationPlacement $placement): array => $placement->toProtocolArray(),
                $placements,
            ), JSON_THROW_ON_ERROR)),
        )) {
            throw new \InvalidArgumentException('Operation placements are invalid.');
        }
    }

    public function revision(): string
    {
        return Rfc8785CanonicalJson::revision(JsonOwnership::object($this->toProtocolArray(false)));
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(bool $withRevision = true): array
    {
        $document = [
            'id' => $this->id,
            'featureId' => $this->featureId,
            'label' => $this->label,
            'inputSchema' => $this->inputSchema,
            'dataSources' => array_map(
                static fn (DataSourceReference $reference): array => $reference->toProtocolArray(),
                $this->dataSources,
            ),
            'presets' => array_map(
                static fn (OperationPreset $preset): array => $preset->toProtocolArray(),
                $this->presets,
            ),
            'execution' => $this->execution->toProtocolArray(),
            'output' => $this->output->toProtocolArray(),
            'order' => $this->order,
            'tags' => $this->tags,
        ];

        if ($this->description !== null) {
            $document['description'] = $this->description;
        }
        if ($this->contextSchema !== null) {
            $document['contextSchema'] = $this->contextSchema;
        }
        if ($this->inputHandling !== null) {
            $document['inputHandling'] = $this->inputHandling->toProtocolArray();
        }
        if ($this->uiSchema !== null) {
            $document['uiSchema'] = $this->uiSchema->toProtocolArray();
        }
        if ($this->icon !== null) {
            $document['icon'] = $this->icon;
        }
        if ($this->requirements !== null) {
            $document['requirements'] = $this->requirements->toProtocolArray();
        }
        if ($this->placements !== []) {
            $document['placements'] = array_map(
                static fn (OperationPlacement $placement): array => $placement->toProtocolArray(),
                $this->placements,
            );
        }
        if ($this->extensions !== null) {
            $document['extensions'] = $this->extensions->toProtocolArray();
        }
        if ($withRevision) {
            $document['revision'] = $this->revision();
        }

        return $document;
    }

    /** @param list<mixed> $values @param class-string $class */
    private static function assertDefinitions(array $values, string $class, string $name): void
    {
        foreach ($values as $value) {
            if (!$value instanceof $class) {
                throw new \InvalidArgumentException('Invalid ' . $name . '.');
            }
        }
    }

    /** @param list<OperationPreset> $presets */
    private static function assertInputHandlingIsAttributable(
        JsonObject $schema,
        InputHandling $handling,
        array $presets,
    ): void {
        $root = $schema->jsonSerialize();
        $allPointers = array_map(
            static fn (array $rule): string => $rule['schemaPointer'],
            $handling->rules,
        );
        if (PresetSecretAnalyzer::valuesAtSchemaPointers($root, $allPointers, new \stdClass()) === null) {
            throw new \InvalidArgumentException('Input handling schema path is not statically attributable.');
        }
        $presetRecords = array_map(
            static fn (OperationPreset $preset): object => (object) [
                'input' => $preset->input->jsonSerialize(),
            ],
            $presets,
        );
        if (!PresetSecretAnalyzer::presetsOmitSecrets(
            $root,
            $handling->secretSchemaPointers(),
            $presetRecords,
        )) {
            throw new \InvalidArgumentException('Operation preset contains a secret value.');
        }
    }
}
