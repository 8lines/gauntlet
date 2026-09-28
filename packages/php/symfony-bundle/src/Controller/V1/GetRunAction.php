<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Http\CapabilityResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager;
use Symfony\Component\HttpFoundation\Response;

final readonly class GetRunAction
{
    public function __construct(
        private AdapterRunManager $runs,
        private CapabilityResponseValidator $responseValidator,
        private ProtocolResponseFactory $responses,
        private ProblemResponseFactory $problems,
    ) {
    }

    public function __invoke(string $runId): Response
    {
        $run = $this->runs->get($runId);
        if ($run === null) {
            return $this->problems->create(new Problem(
                type: 'urn:gauntlet:problem:run-not-found',
                title: 'Run not found',
                status: 404,
            ));
        }

        try {
            return $this->responses->json($this->responseValidator->run($run, $runId));
        } catch (\Throwable) {
            return $this->problems->internal();
        }
    }
}
