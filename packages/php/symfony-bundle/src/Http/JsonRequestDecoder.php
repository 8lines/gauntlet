<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Json\CanonicalJsonException;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;
use Symfony\Component\HttpFoundation\Request;

final readonly class JsonRequestDecoder
{
    public function __construct(private AdapterConfiguration $configuration)
    {
    }

    public function decode(Request $request): JsonObject
    {
        $mediaType = strtolower(trim(explode(';', (string) $request->headers->get('Content-Type'), 2)[0]));
        if ($mediaType !== 'application/json') {
            throw new RequestProblemException(new Problem(
                type: 'urn:gauntlet:problem:unsupported-media-type',
                title: 'Content-Type must be application/json',
                status: 415,
            ));
        }

        $contentLength = $request->headers->get('Content-Length');
        if ($this->exceedsLimit($contentLength)) {
            throw new RequestProblemException(new Problem(
                type: 'urn:gauntlet:problem:request-too-large',
                title: 'Request body is too large',
                status: 413,
            ));
        }
        $content = $request->getContent();
        if (!is_string($content) || strlen($content) > $this->configuration->maxJsonBytes) {
            throw new RequestProblemException(new Problem(
                type: 'urn:gauntlet:problem:request-too-large',
                title: 'Request body is too large',
                status: 413,
            ));
        }

        try {
            $owned = JsonOwnership::fromJson($content);
        } catch (CanonicalJsonException) {
            throw new RequestProblemException(new Problem(
                type: 'urn:gauntlet:problem:invalid-json',
                title: 'Invalid JSON',
                status: 400,
            ));
        }
        if (!$owned instanceof JsonObject) {
            throw new RequestProblemException(new Problem(
                type: 'urn:gauntlet:problem:validation-failed',
                title: 'Validation failed',
                status: 422,
            ));
        }

        return $owned;
    }

    private function exceedsLimit(?string $contentLength): bool
    {
        if ($contentLength === null || preg_match('/^[0-9]+$/D', $contentLength) !== 1) {
            return false;
        }
        $normalized = ltrim($contentLength, '0');
        $normalized = $normalized === '' ? '0' : $normalized;
        $limit = (string) $this->configuration->maxJsonBytes;

        return strlen($normalized) > strlen($limit)
            || (strlen($normalized) === strlen($limit) && strcmp($normalized, $limit) > 0);
    }
}
