<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Unit\Input;

use EightLines\Gauntlet\Core\Contract\InputMapper;
use EightLines\Gauntlet\Core\Contract\InputMappingException;
use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyInputMapper;
use PHPUnit\Framework\TestCase;
use Symfony\Component\PropertyInfo\Extractor\ReflectionExtractor;
use Symfony\Component\Serializer\Normalizer\ObjectNormalizer;
use Symfony\Component\Serializer\Serializer;
use Symfony\Component\Validator\Validation;

final class SymfonyInputMapperTest extends TestCase
{
    public function testItMapsAnOwnedObjectToAValidatedReadonlyDto(): void
    {
        $mapped = $this->mapper()->map(
            JsonOwnership::object([
                'applicationId' => '11111111-1111-4111-8111-111111111111',
                'reason' => null,
                'state' => 'open',
            ]),
            InputFixture::class,
        );

        self::assertInstanceOf(InputFixture::class, $mapped);
        self::assertInstanceOf(InputMapper::class, $this->mapper());
        self::assertSame('11111111-1111-4111-8111-111111111111', $mapped->applicationId);
        self::assertNull($mapped->reason);
    }

    public function testItRejectsUnknownKeysBeforeDeserialization(): void
    {
        try {
            $this->mapper()->map(
                JsonOwnership::object([
                    'applicationId' => '11111111-1111-4111-8111-111111111111',
                    'unexpected' => 'must-not-be-ignored',
                ]),
                InputFixture::class,
            );
            self::fail('Unknown input key was accepted.');
        } catch (InputMappingException $exception) {
            self::assertSame('/unexpected', $exception->errors[0]->instancePath);
            self::assertStringNotContainsString('must-not-be-ignored', $exception->getMessage());
        }
    }

    public function testItNormalizesValidatorViolationsWithoutInputValues(): void
    {
        try {
            $this->mapper()->map(
                JsonOwnership::object(['applicationId' => 'not-a-uuid']),
                InputFixture::class,
            );
            self::fail('Invalid UUID was accepted.');
        } catch (InputMappingException $exception) {
            self::assertSame('/applicationId', $exception->errors[0]->instancePath);
            self::assertSame('validation', $exception->errors[0]->keyword);
            self::assertStringNotContainsString('not-a-uuid', $exception->getMessage());
            self::assertStringNotContainsString('not-a-uuid', json_encode(
                array_map(static fn ($error): array => $error->toProtocolArray(), $exception->errors),
                JSON_THROW_ON_ERROR,
            ));
        }
    }

    private function mapper(): SymfonyInputMapper
    {
        $serializer = new Serializer([
            new ObjectNormalizer(propertyTypeExtractor: new ReflectionExtractor()),
        ]);

        return new SymfonyInputMapper(
            serializer: $serializer,
            validator: Validation::createValidatorBuilder()->enableAttributeMapping()->getValidator(),
        );
    }
}
