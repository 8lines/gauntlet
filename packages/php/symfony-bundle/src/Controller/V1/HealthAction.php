<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use Symfony\Component\HttpFoundation\Response;

final readonly class HealthAction
{
    public function __construct(private ProtocolResponseFactory $responses)
    {
    }

    public function __invoke(): Response
    {
        return $this->responses->json([
            'status' => 'ok',
            'protocolVersion' => '1.0',
        ]);
    }
}
