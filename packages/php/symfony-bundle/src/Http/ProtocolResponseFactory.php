<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Json\JsonValue;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final class ProtocolResponseFactory
{
    public function json(
        mixed $document,
        int $status = 200,
        ?string $revision = null,
        ?Request $request = null,
    ): Response {
        $headers = ['Content-Type' => 'application/json'];
        if ($revision !== null) {
            $etag = '"' . $revision . '"';
            if ($request?->headers->get('If-None-Match') === $etag) {
                return new Response('', 304, ['ETag' => $etag]);
            }
            $headers['ETag'] = $etag;
        }

        return new JsonResponse(
            data: $this->normalize($document),
            status: $status,
            headers: $headers,
        );
    }

    public function normalize(mixed $value): mixed
    {
        if ($value === null || is_scalar($value)) {
            return $value;
        }
        if (is_array($value)) {
            $normalized = [];
            foreach ($value as $key => $item) {
                $normalized[$key] = $this->normalize($item);
            }

            return $normalized;
        }
        if ($value instanceof \BackedEnum) {
            return $value->value;
        }
        if ($value instanceof JsonValue || $value instanceof \JsonSerializable) {
            return $this->normalize($value->jsonSerialize());
        }
        if ($value instanceof \stdClass) {
            $normalized = new \stdClass();
            foreach (get_object_vars($value) as $key => $item) {
                $normalized->{$key} = $this->normalize($item);
            }

            return $normalized;
        }
        if (method_exists($value, 'toProtocolArray')) {
            return $this->normalize($value->toProtocolArray());
        }

        throw new \LogicException('Non-protocol value reached the response boundary.');
    }
}
