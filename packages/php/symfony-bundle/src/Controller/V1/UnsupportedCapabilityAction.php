<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use Symfony\Component\HttpFoundation\Response;

final readonly class UnsupportedCapabilityAction
{
    public function __construct(private ProblemResponseFactory $problems)
    {
    }

    public function __invoke(string $capability): Response
    {
        return $this->problems->create(new Problem(
            type: 'urn:gauntlet:problem:unsupported-capability',
            title: 'Unsupported capability',
            status: 501,
            detail: 'The adapter does not advertise or implement this capability.',
            capability: $capability,
        ), expectedCapability: $capability);
    }
}
