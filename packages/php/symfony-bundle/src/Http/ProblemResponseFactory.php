<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Http;

use EightLines\Gauntlet\Core\Problem\Problem;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Response;

final class ProblemResponseFactory
{
    public function __construct(private readonly ProblemSanitizer $sanitizer)
    {
    }

    public function create(
        Problem $problem,
        array $headers = [],
        ?string $expectedCapability = null,
    ): Response
    {
        try {
            $safe = $this->sanitizer->sanitize($problem, $expectedCapability);
        } catch (\Throwable) {
            $safe = new Problem(
                type: 'urn:gauntlet:problem:adapter-internal-error',
                title: 'Adapter internal error',
                status: 500,
                correlationId: self::correlationId(),
            );
        }

        return new JsonResponse(
            data: $safe->toProtocolArray(),
            status: $safe->status,
            headers: ['Content-Type' => 'application/problem+json', ...$headers],
        );
    }

    public function internal(string $title = 'Adapter request failed'): Response
    {
        return $this->create(new Problem(
            type: 'urn:gauntlet:problem:adapter-internal-error',
            title: $title,
            status: 500,
            correlationId: self::correlationId(),
        ));
    }

    public static function correlationId(): string
    {
        return 'tc-' . bin2hex(random_bytes(12));
    }
}
