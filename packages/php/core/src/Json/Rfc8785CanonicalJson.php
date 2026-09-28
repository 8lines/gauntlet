<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Json;

use Tracing\Sdk\Canonicalize\JsonCanonicalizer;
use Tracing\Sdk\Exception\CanonicalizationException;

/** RFC 8785 canonical bytes backed by the exact pinned OneMatrix engine. */
final class Rfc8785CanonicalJson
{
    public static function encode(JsonValue $value): string
    {
        $owned = JsonOwnership::own($value);
        if (!$owned instanceof JsonValue) {
            throw CanonicalJsonException::invalidValue();
        }

        $previousPrecision = ini_get('serialize_precision');
        if ($previousPrecision === false || ini_set('serialize_precision', '-1') === false) {
            throw new CanonicalJsonException('Unable to establish deterministic JSON transport.');
        }

        try {
            $raw = json_encode(
                JsonOwnership::transport($owned),
                JSON_THROW_ON_ERROR
                    | JSON_UNESCAPED_SLASHES
                    | JSON_UNESCAPED_UNICODE
                    | JSON_PRESERVE_ZERO_FRACTION,
                512,
            );
        } catch (\JsonException) {
            throw CanonicalJsonException::invalidValue();
        } finally {
            ini_set('serialize_precision', (string) $previousPrecision);
        }

        try {
            // No trim, normalization, decode/re-encode, or exponent repair.
            return (new JsonCanonicalizer())->canonicalize($raw);
        } catch (CanonicalizationException) {
            throw new CanonicalJsonException('Canonical JSON encoding failed.');
        }
    }

    public static function revision(JsonObject $document, string $revisionField = 'revision'): string
    {
        return 'sha256:' . hash('sha256', self::encode($document->without($revisionField)));
    }
}
