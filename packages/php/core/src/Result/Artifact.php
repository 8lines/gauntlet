<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Result;

use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Protocol\ProtocolExtensions;
use EightLines\Gauntlet\Core\Protocol\ProtocolId;
use EightLines\Gauntlet\Core\Protocol\ProtocolValue;

/** A validated member of the closed v1 Artifact union. */
final readonly class Artifact
{
    public function __construct(
        public string $id,
        public string $kind,
        public JsonObject $data,
    ) {
        ProtocolId::assert($id);
        self::assertShape($kind, $data->jsonSerialize());
    }

    /** @return array<string, mixed> */
    public function toProtocolArray(): array
    {
        $document = ['id' => $this->id, 'kind' => $this->kind];
        foreach (get_object_vars($this->data->jsonSerialize()) as $key => $value) {
            $document[$key] = $value;
        }

        return $document;
    }

    private static function assertShape(string $kind, \stdClass $data): void
    {
        if (str_starts_with($kind, 'urn:')) {
            if (preg_match('/^urn:[A-Za-z0-9][A-Za-z0-9:._\/-]*$/D', $kind) !== 1) {
                throw new \InvalidArgumentException('Invalid namespaced artifact kind.');
            }
            self::assertMembers($data, ['data'], ['title', 'extensions']);

            return;
        }

        match ($kind) {
            'notice' => self::assertNotice($data),
            'metrics' => self::assertMetrics($data),
            'key-value' => self::assertKeyValue($data),
            'table' => self::assertTable($data),
            'json' => self::assertMembers($data, ['value'], ['title', 'extensions']),
            'markdown' => self::assertStringPayload($data, 'markdown'),
            'diff' => self::assertDiff($data),
            'timeline' => self::assertTimeline($data),
            'log' => self::assertLog($data),
            'download' => self::assertDownload($data),
            'link' => self::assertLink($data),
            'browser-launch' => self::assertBrowserLaunch($data),
            default => throw new \InvalidArgumentException('Unsupported artifact kind.'),
        };
    }

    private static function assertNotice(\stdClass $data): void
    {
        self::assertMembers($data, ['level', 'message'], ['title', 'extensions']);
        if (!in_array($data->level, ['info', 'success', 'warning', 'error'], true) || !is_string($data->message)) {
            throw new \InvalidArgumentException('Invalid notice artifact.');
        }
    }

    private static function assertMetrics(\stdClass $data): void
    {
        self::assertMembers($data, ['metrics'], ['title', 'extensions']);
        self::assertList($data->metrics, static function (mixed $metric): void {
            self::assertRecord($metric, ['name', 'value'], ['unit']);
            if (!is_string($metric->name) || (!is_int($metric->value) && !is_float($metric->value))) {
                throw new \InvalidArgumentException('Invalid metric artifact entry.');
            }
            if (property_exists($metric, 'unit') && !is_string($metric->unit)) {
                throw new \InvalidArgumentException('Invalid metric unit.');
            }
        });
    }

    private static function assertKeyValue(\stdClass $data): void
    {
        self::assertMembers($data, ['entries'], ['title', 'extensions']);
        self::assertList($data->entries, static function (mixed $entry): void {
            self::assertRecord($entry, ['key', 'label', 'value']);
            if (!is_string($entry->key) || !is_string($entry->label)) {
                throw new \InvalidArgumentException('Invalid key-value artifact entry.');
            }
        });
    }

    private static function assertTable(\stdClass $data): void
    {
        self::assertMembers($data, ['columns', 'rows'], ['title', 'extensions']);
        self::assertList($data->columns, static function (mixed $column): void {
            self::assertRecord($column, ['key', 'label']);
            if (!is_string($column->key) || !is_string($column->label)) {
                throw new \InvalidArgumentException('Invalid table column.');
            }
        });
        self::assertList($data->rows, static function (mixed $row): void {
            if (!$row instanceof \stdClass) {
                throw new \InvalidArgumentException('Table rows must be JSON objects.');
            }
        });
    }

    private static function assertStringPayload(\stdClass $data, string $member): void
    {
        self::assertMembers($data, [$member], ['title', 'extensions']);
        if (!is_string($data->{$member})) {
            throw new \InvalidArgumentException('Invalid string artifact payload.');
        }
    }

    private static function assertDiff(\stdClass $data): void
    {
        self::assertMembers($data, ['format', 'content'], ['title', 'extensions']);
        if ($data->format !== 'unified' || !is_string($data->content)) {
            throw new \InvalidArgumentException('Invalid diff artifact.');
        }
    }

    private static function assertTimeline(\stdClass $data): void
    {
        self::assertMembers($data, ['items'], ['title', 'extensions']);
        self::assertList($data->items, static function (mixed $item): void {
            self::assertRecord($item, ['timestamp', 'title'], ['description']);
            if (!is_string($item->timestamp) || !is_string($item->title)) {
                throw new \InvalidArgumentException('Invalid timeline item.');
            }
            ProtocolValue::assertRfc3339($item->timestamp);
            if (property_exists($item, 'description') && !is_string($item->description)) {
                throw new \InvalidArgumentException('Invalid timeline description.');
            }
        });
    }

    private static function assertLog(\stdClass $data): void
    {
        self::assertMembers($data, ['entries'], ['title', 'extensions']);
        self::assertList($data->entries, static function (mixed $entry): void {
            self::assertRecord($entry, ['level', 'message'], ['timestamp']);
            if (!in_array($entry->level, ['debug', 'info', 'warning', 'error'], true)
                || !is_string($entry->message)) {
                throw new \InvalidArgumentException('Invalid log artifact entry.');
            }
            if (property_exists($entry, 'timestamp')) {
                if (!is_string($entry->timestamp)) {
                    throw new \InvalidArgumentException('Invalid log timestamp.');
                }
                ProtocolValue::assertRfc3339($entry->timestamp);
            }
        });
    }

    private static function assertDownload(\stdClass $data): void
    {
        self::assertMembers($data, ['url', 'name', 'mediaType'], ['title', 'sizeBytes', 'extensions']);
        if (!is_string($data->url) || !is_string($data->name) || !is_string($data->mediaType)) {
            throw new \InvalidArgumentException('Invalid download artifact.');
        }
        ProtocolValue::assertHttpUrl($data->url);
        if (property_exists($data, 'sizeBytes')
            && (!is_int($data->sizeBytes) || $data->sizeBytes < 0 || $data->sizeBytes > ProtocolValue::MAX_SAFE_INTEGER)) {
            throw new \InvalidArgumentException('Invalid download size.');
        }
    }

    private static function assertLink(\stdClass $data): void
    {
        self::assertMembers($data, ['label', 'url'], ['title', 'extensions']);
        if (!is_string($data->label) || !is_string($data->url)) {
            throw new \InvalidArgumentException('Invalid link artifact.');
        }
        ProtocolValue::assertHttpUrl($data->url);
    }

    private static function assertBrowserLaunch(\stdClass $data): void
    {
        self::assertMembers($data, ['label'], ['title', 'extensions']);
        if (!is_string($data->label)) {
            throw new \InvalidArgumentException('Invalid browser-launch artifact.');
        }
    }

    /** @param list<string> $required @param list<string> $optional */
    private static function assertMembers(\stdClass $data, array $required, array $optional = []): void
    {
        self::assertRecord($data, $required, $optional);
        if (property_exists($data, 'title') && !is_string($data->title)) {
            throw new \InvalidArgumentException('Invalid artifact title.');
        }
        if (property_exists($data, 'extensions')) {
            if (!$data->extensions instanceof \stdClass) {
                throw new \InvalidArgumentException('Invalid artifact extensions.');
            }
            new ProtocolExtensions(JsonOwnership::object(get_object_vars($data->extensions)));
        }
    }

    /** @param list<string> $required @param list<string> $optional */
    private static function assertRecord(mixed $value, array $required, array $optional = []): void
    {
        if (!$value instanceof \stdClass) {
            throw new \InvalidArgumentException('Artifact member must be an object.');
        }
        $allowed = array_fill_keys([...$required, ...$optional], true);
        foreach (array_keys(get_object_vars($value)) as $key) {
            if (!isset($allowed[$key])) {
                throw new \InvalidArgumentException('Artifact contains an unsupported member.');
            }
        }
        foreach ($required as $key) {
            if (!property_exists($value, $key)) {
                throw new \InvalidArgumentException('Artifact is missing a required member.');
            }
        }
    }

    private static function assertList(mixed $value, callable $assertItem): void
    {
        if (!is_array($value) || !array_is_list($value)) {
            throw new \InvalidArgumentException('Artifact member must be a list.');
        }
        foreach ($value as $item) {
            $assertItem($item);
        }
    }
}
