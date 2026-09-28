<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Registry;

use EightLines\Gauntlet\Core\Contract\OperationHandler;
use EightLines\Gauntlet\Core\Contract\RunContext;
use EightLines\Gauntlet\Core\Definition\ExecutionPolicy;
use EightLines\Gauntlet\Core\Definition\OperationDefinition;
use EightLines\Gauntlet\Core\Definition\OperationImpact;
use EightLines\Gauntlet\Core\Definition\OperationOutput;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Registry\OperationRegistry;
use EightLines\Gauntlet\Core\Result\OperationResult;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class OperationRegistryTest extends TestCase
{
    public function testDuplicateOperationKeepsFirstAndRecordsSafeDiagnostic(): void
    {
        $first = new RegistryHandler('same');
        $registry = new OperationRegistry([$first, new RegistryHandler('same')]);
        self::assertSame($first, $registry->find('same'));
        self::assertSame('duplicate_operation_id', $registry->diagnostics()[0]->code);
    }
}
final class RegistryHandler implements OperationHandler
{
    public function __construct(private string $id)
    {
    }

    public function definition(): OperationDefinition
    {
        return new OperationDefinition(
            $this->id,
            'feature',
            'Label',
            null,
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
            ]),
            null,
            null,
            null,
            [],
            [],
            new ExecutionPolicy(OperationImpact::READ, false, false, 'optional', false),
            new OperationOutput(JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
            ])),
        );
    }

    public function execute(object $input, RunContext $context): OperationResult
    {
        return new OperationResult(JsonOwnership::object([]));
    }
}
