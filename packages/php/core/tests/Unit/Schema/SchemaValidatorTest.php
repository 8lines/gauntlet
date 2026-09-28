<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Schema;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Schema\OpisSchemaValidator;
use EightLines\Gauntlet\Core\Schema\TcSchemaCore;
use PHPUnit\Framework\TestCase;

final class SchemaValidatorTest extends TestCase
{
    public function testItUsesDraft202012WithLocalReferencesAndNormalizedSafeErrors(): void
    {
        $schema = JsonOwnership::object([
            '$schema' => TcSchemaCore::DIALECT,
            'type' => 'object',
            'required' => ['profile'],
            'properties' => [
                'profile' => ['$ref' => '#/$defs/profile'],
            ],
            '$defs' => [
                'profile' => [
                    'type' => 'object',
                    'required' => ['email', 'slug'],
                    'properties' => [
                        'email' => ['type' => 'string', 'format' => 'email'],
                        'slug' => ['type' => 'string', 'pattern' => '^[a-z]+$'],
                    ],
                    'additionalProperties' => false,
                ],
            ],
            'additionalProperties' => false,
        ]);

        $errors = (new OpisSchemaValidator())->validate($schema, JsonOwnership::object([
            'profile' => [
                'email' => 'secret-at-invalid',
                'slug' => 'INVALID',
                'unexpected' => 'must-not-leak',
            ],
        ]));

        self::assertNotEmpty($errors);
        self::assertContains('format', array_column($errors, 'keyword'));
        self::assertContains('pattern', array_column($errors, 'keyword'));
        self::assertContains('additionalProperties', array_column($errors, 'keyword'));
        foreach ($errors as $error) {
            $wire = json_encode($error->toProtocolArray(), JSON_THROW_ON_ERROR);
            self::assertStringNotContainsString('secret-at-invalid', $wire);
            self::assertStringNotContainsString('must-not-leak', $wire);
            self::assertStringStartsWith('#/', $error->schemaPath);
        }
    }

    public function testItRejectsRemoteReferencesBeforeOpisCanRetrieveThem(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        (new OpisSchemaValidator())->validate(
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                '$ref' => 'https://example.invalid/schema.json',
            ]),
            JsonOwnership::object([]),
        );
    }

    public function testCompleteRawObjectIsValidatedRatherThanAProjection(): void
    {
        $errors = (new OpisSchemaValidator())->validate(
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'properties' => ['requestId' => ['type' => 'string']],
                'additionalProperties' => false,
            ]),
            JsonOwnership::object(['requestId' => 'request-1', 'extra' => true]),
        );

        self::assertContains('additionalProperties', array_column($errors, 'keyword'));
    }

    public function testAggregatePropertyErrorsDoNotPrecedeTheExactInvalidUuidLeaf(): void
    {
        $errors = (new OpisSchemaValidator())->validate(
            JsonOwnership::object([
                '$schema' => TcSchemaCore::DIALECT,
                'type' => 'object',
                'required' => ['applicationId'],
                'properties' => [
                    'applicationId' => ['type' => 'string', 'format' => 'uuid'],
                ],
                'additionalProperties' => false,
            ]),
            JsonOwnership::object(['applicationId' => 'not-a-uuid']),
        );

        self::assertNotEmpty($errors);
        self::assertSame('/applicationId', $errors[0]->instancePath);
        self::assertSame('format', $errors[0]->keyword);
    }
}
