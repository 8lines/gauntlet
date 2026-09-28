<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\SymfonyBundle\Http\EnvelopeMapper;
use EightLines\Gauntlet\SymfonyBundle\Http\CapabilityResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\JsonRequestDecoder;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\RequestProblemException;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyAdapterCatalog;
use EightLines\Gauntlet\SymfonyBundle\Run\AdapterRunManager;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final readonly class CreateRunAction
{
    public function __construct(
        private SymfonyAdapterCatalog $catalog,
        private JsonRequestDecoder $decoder,
        private EnvelopeMapper $envelopes,
        private AdapterRunManager $runs,
        private CapabilityResponseValidator $responseValidator,
        private ProtocolResponseFactory $responses,
        private ProblemResponseFactory $problems,
    ) {
    }

    public function __invoke(Request $request, string $operationId): Response
    {
        $summary = $this->catalog->operationSummary($operationId);
        if ($summary === null) {
            return $this->problems->create(new Problem(
                type: 'urn:gauntlet:problem:operation-not-found',
                title: 'Operation not found',
                status: 404,
            ));
        }
        if (!$summary->isAvailable()) {
            return $this->problems->create(
                $summary->problem ?? throw new \LogicException('Unavailable summary has no Problem.'),
            );
        }

        try {
            $envelope = $this->envelopes->createRun($this->decoder->decode($request));
            $result = $this->runs->create(
                operationId: $operationId,
                request: $envelope['request'],
                rawContext: $envelope['rawContext'],
            );
            if (!$result->isSuccess()) {
                return $this->problems->create(
                    $result->problem ?? throw new \LogicException('Failed run creation has no Problem.'),
                );
            }
            $run = $result->run ?? throw new \LogicException('Successful run creation has no Run.');
            $document = $this->responseValidator->run($run, expectedOperationId: $operationId);
        } catch (RequestProblemException $exception) {
            return $this->problems->create($exception->problem);
        } catch (\Throwable) {
            return $this->problems->internal();
        }

        return $this->responses->json(
            $document,
            $run->state->terminal() ? 201 : 202,
        );
    }
}
