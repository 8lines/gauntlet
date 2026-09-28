<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Problem;

use EightLines\Gauntlet\Core\Json\JsonOwnership;
use EightLines\Gauntlet\Core\Problem\Problem;
use EightLines\Gauntlet\Core\Problem\ValidationError;
use PHPUnit\Framework\TestCase;

final class ProblemTest extends TestCase
{
    public function testItSerializesOnlyTheClosedSafeShape(): void
    {
        $problem = new Problem(
            'urn:gauntlet:problem:validation-failed',
            'Validation failed',
            422,
            correlationId: 'request-1',
            errors: [new ValidationError('', '#/required', 'required', 'Required value is missing.', JsonOwnership::object([]))],
        );

        self::assertSame([
            'type', 'title', 'status', 'correlationId', 'errors',
        ], array_keys($problem->toProtocolArray()));
        self::assertStringNotContainsString('Throwable', json_encode($problem->toProtocolArray(), JSON_THROW_ON_ERROR));
    }

    public function testItRejectsBlankTitlesAndInvalidProblemTypeSuffixes(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Problem('urn:gauntlet:problem:contains/slash', '', 500);
    }

    public function testValidationErrorsCannotBeArbitraryArrays(): void
    {
        $this->expectException(\InvalidArgumentException::class);
        new Problem('urn:gauntlet:problem:validation-failed', 'Validation failed', 422, errors: [['secret' => true]]);
    }
}
