<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Unit\Input;

use EightLines\Gauntlet\SymfonyBundle\Input\SymfonyJsonSchemaFactory;
use EightLines\Gauntlet\SymfonyBundle\Input\UnsupportedInputShapeException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;
use Symfony\Component\Validator\Constraints as Assert;

final class SymfonyJsonSchemaFactoryTest extends TestCase
{
    public function testItGeneratesRequiredNullableAndConstraintKeywords(): void
    {
        $schema = $this->wire((new SymfonyJsonSchemaFactory())->forClass(InputFixture::class));

        self::assertSame('https://json-schema.org/draft/2020-12/schema', $schema['$schema']);
        self::assertSame('object', $schema['type']);
        self::assertSame(['applicationId'], $schema['required']);
        self::assertSame(false, $schema['additionalProperties']);
        self::assertSame('string', $schema['properties']['applicationId']['type']);
        self::assertSame('uuid', $schema['properties']['applicationId']['format']);
        self::assertSame(['string', 'null'], $schema['properties']['reason']['type']);
        self::assertSame(1000, $schema['properties']['reason']['maxLength']);
        self::assertSame(['open', 'closed'], $schema['properties']['state']['enum']);
    }

    public function testListItemTypeMustBeExplicitAndIsEmitted(): void
    {
        $factory = new SymfonyJsonSchemaFactory();

        $schema = $this->wire($factory->forClass(ListInputFixture::class, ['tags' => 'string']));
        self::assertSame(['type' => 'string'], $schema['properties']['tags']['items']);

        $this->expectException(UnsupportedInputShapeException::class);
        $factory->forClass(ListInputFixture::class);
    }

    #[DataProvider('unsupportedDtoProvider')]
    public function testUnsupportedDtoShapesAndNonPortableRegexRequireExplicitSchema(string $class): void
    {
        $this->expectException(UnsupportedInputShapeException::class);

        (new SymfonyJsonSchemaFactory())->forClass($class);
    }

    /** @return iterable<string, array{class-string}> */
    public static function unsupportedDtoProvider(): iterable
    {
        yield 'nested object' => [NestedInputFixture::class];
        yield 'lookbehind regex' => [NonPortableRegexInputFixture::class];
    }

    /** @return array<string, mixed> */
    private function wire(\JsonSerializable $schema): array
    {
        return json_decode(
            json_encode($schema, JSON_THROW_ON_ERROR),
            true,
            flags: JSON_THROW_ON_ERROR,
        );
    }
}

final readonly class InputFixture
{
    public function __construct(
        #[Assert\NotBlank]
        #[Assert\Uuid]
        public string $applicationId,
        #[Assert\Length(max: 1000)]
        public ?string $reason = null,
        #[Assert\Choice(choices: ['open', 'closed'])]
        public string $state = 'open',
    ) {
    }
}

final readonly class ListInputFixture
{
    /** @param list<string> $tags */
    public function __construct(public array $tags)
    {
    }
}

final readonly class NestedInputFixture
{
    public function __construct(public \stdClass $nested)
    {
    }
}

final readonly class NonPortableRegexInputFixture
{
    public function __construct(
        #[Assert\Regex('/(?<=a)b/')]
        public string $value,
    ) {
    }
}
