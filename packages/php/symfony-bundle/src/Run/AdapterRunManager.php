<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Run;

use EightLines\Gauntlet\Core\Contract\ExecutionCoordinator;
use EightLines\Gauntlet\Core\Contract\FileReferenceValidator;
use EightLines\Gauntlet\Core\Contract\RunDispatcher;
use EightLines\Gauntlet\Core\Contract\RunStore;
use EightLines\Gauntlet\Core\Json\JsonObject;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Run\CreateRunRequest;
use EightLines\Gauntlet\Core\Run\Run;
use EightLines\Gauntlet\Core\Run\RunCreationResult;
use EightLines\Gauntlet\Core\Run\RunManager;
use EightLines\Gauntlet\Core\Schema\SchemaValidator;
use EightLines\Gauntlet\SymfonyBundle\Capability\UploadEndpoint;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyInputMapper;
use EightLines\Gauntlet\SymfonyBundle\Registry\SymfonyOperationRegistry;
use EightLines\Gauntlet\SymfonyBundle\Support\AdapterConfiguration;

/** Symfony composition root for the framework-neutral Core run lifecycle. */
final readonly class AdapterRunManager
{
    private RunManager $inner;

    public function __construct(
        SymfonyOperationRegistry $operations,
        RunStore $store,
        SchemaValidator $schemaValidator,
        SymfonyInputMapper $inputMapper,
        AdapterConfiguration $configuration,
        ExecutionCoordinator $executionCoordinator,
        RunDispatcher $dispatcher,
        iterable $uploadEndpoints,
    ) {
        $fileValidators = [];
        foreach ($uploadEndpoints as $endpoint) {
            if ($endpoint instanceof UploadEndpoint) {
                $fileValidators[] = $endpoint;
            }
        }
        $fileValidator = count($fileValidators) === 1 ? $fileValidators[0] : null;
        $this->inner = new RunManager(
            operations: $operations->core(),
            store: $store,
            schemaValidator: $schemaValidator,
            fingerprintSecret: $configuration->idempotencySecret,
            inputMapper: $inputMapper,
            fileReferenceValidator: $fileValidator instanceof FileReferenceValidator
                ? $fileValidator
                : null,
            executionCoordinator: $executionCoordinator,
            dispatcher: $dispatcher,
        );
    }

    public function create(
        string $operationId,
        CreateRunRequest $request,
        ?JsonObject $rawContext = null,
    ): RunCreationResult {
        if (($rawContext === null) !== ($request->context === null)) {
            throw new \LogicException('Mapped invocation context drifted from its owned envelope.');
        }

        return $this->inner->create($operationId, $request);
    }

    public function get(string $runId): ?Run
    {
        return $this->inner->get($runId);
    }

    public function cancel(string $runId): Run|Problem
    {
        return $this->inner->cancel($runId);
    }
}
