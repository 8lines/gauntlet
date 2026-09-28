<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Controller\V1;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\DataSourceResponseValidator;
use EightLines\Gauntlet\SymfonyBundle\Http\EnvelopeMapper;
use EightLines\Gauntlet\SymfonyBundle\Http\JsonRequestDecoder;
use EightLines\Gauntlet\SymfonyBundle\Http\ProblemResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\ProtocolResponseFactory;
use EightLines\Gauntlet\SymfonyBundle\Http\RequestProblemException;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyDataSourceRegistry;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\HttpFoundation\Response;

final readonly class QueryDataSourceAction
{
    public function __construct(
        private SymfonyDataSourceRegistry $sources,
        private JsonRequestDecoder $decoder,
        private EnvelopeMapper $envelopes,
        private DataSourceResponseValidator $responseValidator,
        private SchemaValidator $schemaValidator,
        private ProtocolResponseFactory $responses,
        private ProblemResponseFactory $problems,
    ) {
    }

    public function __invoke(Request $request, string $dataSourceId): Response
    {
        $source = $this->sources->find($dataSourceId);
        if ($source === null) {
            return $this->notFound();
        }

        try {
            $query = $this->envelopes->dataSourceQuery($this->decoder->decode($request));
            $definition = $source->definition();
            if (
                (!$definition->search && $query->search !== null)
                || ($definition->pagination === 'none' && $query->cursor !== null)
                || ($query->limit !== null && $query->limit > $definition->maxLimit)
            ) {
                throw new RequestProblemException(Problem::validation([]));
            }
            if ($definition->dependencySchema !== null) {
                $errors = $this->schemaValidator->validate($definition->dependencySchema, $query->dependencies);
                if ($errors !== []) {
                    throw new RequestProblemException(Problem::validation($errors));
                }
            }
            if ($definition->contextSchema !== null) {
                $errors = $this->schemaValidator->validate(
                    $definition->contextSchema,
                    JsonOwnership::object($query->context?->toProtocolArray() ?? []),
                );
                if ($errors !== []) {
                    throw new RequestProblemException(Problem::validation($errors));
                }
            }

            return $this->responses->json(
                $this->responseValidator->page($source->query($query), $definition),
            );
        } catch (RequestProblemException $exception) {
            return $this->problems->create($exception->problem);
        } catch (\Throwable) {
            return $this->problems->internal('Data source query failed');
        }
    }

    private function notFound(): Response
    {
        return $this->problems->create(new Problem(
            type: 'urn:gauntlet:problem:data-source-not-found',
            title: 'Data source not found',
            status: 404,
        ));
    }
}
