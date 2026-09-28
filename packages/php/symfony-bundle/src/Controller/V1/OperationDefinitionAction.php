<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final readonly class OperationDefinitionAction
{
    public function __construct(
        private SymfonyAdapterCatalog $catalog,
        private ProtocolResponseFactory $responses,
        private ProblemResponseFactory $problems,
    ) {
    }

    public function __invoke(Request $request, string $operationId): Response
    {
        $summary = $this->catalog->operationSummary($operationId);
        $definition = $this->catalog->operationDefinition($operationId);
        if ($summary === null || $definition === null) {
            return $this->problems->create(new Problem(
                type: 'urn:gauntlet:problem:operation-not-found',
                title: 'Operation not found',
                status: 404,
            ));
        }
        return $this->responses->json(
            $definition,
            revision: $definition->revision(),
            request: $request,
        );
    }
}
