<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\SymfonyBundle\Tests\Integration;

use EightLines\Gauntlet\SymfonyBundle\Http\RawAdapterTargetGuard;
use EightLines\Gauntlet\SymfonyBundle\Tests\Fixture\App\FixtureKernel;
use PHPUnit\Framework\Attributes\DataProvider;
use Symfony\Component\HttpFoundation\Request;

final class AdapterRawBoundaryTest extends BundleWebTestCase
{
    #[DataProvider('invalidTargetProvider')]
    public function testRawGuardRejectsAmbiguousTargetsBeforeRouting(string $method, string $target): void
    {
        $problem = (new RawAdapterTargetGuard())->inspect($target, $method);

        self::assertNotNull($problem);
        self::assertSame(400, $problem->status);
        self::assertSame('urn:gauntlet:problem:invalid-path', $problem->type);
    }

    /** @return iterable<string, array{string, string}> */
    public static function invalidTargetProvider(): iterable
    {
        yield 'query' => ['GET', '/_gauntlet/v1/manifest?x=1'];
        yield 'fragment' => ['GET', '/_gauntlet/v1/manifest#x'];
        yield 'percent' => ['GET', '/_gauntlet/v1/operations/unsafe%2Fid'];
        yield 'space' => ['GET', '/_gauntlet/v1/operations/unsafe id'];
        yield 'horizontal tab' => ['GET', "/_gauntlet/v1/operations/unsafe\tid"];
        yield 'backslash' => ['GET', '/_gauntlet/v1/operations/unsafe\\id'];
        yield 'dot segment' => ['GET', '/_gauntlet/v1/operations/./runs'];
        yield 'parent segment' => ['GET', '/_gauntlet/v1/operations/../runs'];
        yield 'trailing slash' => ['GET', '/_gauntlet/v1/manifest/'];
        yield 'extra segment' => ['GET', '/_gauntlet/v1/manifest/extra'];
        yield 'empty segment' => ['GET', '/_gauntlet/v1//manifest'];
    }

    public function testKnownWrongMethodAndUnknownSafePathAreDistinct(): void
    {
        $guard = new RawAdapterTargetGuard();

        self::assertSame(405, $guard->inspect('/_gauntlet/v1/manifest', 'POST')?->status);
        self::assertSame(404, $guard->inspect('/_gauntlet/v1/unknown', 'GET')?->status);
        self::assertNull($guard->inspect('/host-route', 'GET'));
        self::assertNull($guard->inspect('/_gauntlet/v1/manifest', 'GET'));
    }

    #[DataProvider('rawNormalizedMismatchProvider')]
    public function testNormalizedAdapterTargetsCannotBypassTheRawGate(
        string $environment,
        string $uri,
        string $rawTarget,
        int $expectedStatus,
        string $expectedType,
    ): void {
        $kernel = new FixtureKernel($environment, true);
        $request = Request::create(
            $uri,
            'GET',
            server: [
                'REQUEST_URI' => $rawTarget,
                'UNENCODED_URL' => $rawTarget,
            ],
        );

        if (str_starts_with($rawTarget, 'http://')) {
            self::assertSame('/_gauntlet/v1/manifest', $request->getPathInfo());
            self::assertNotSame($request->getPathInfo(), $rawTarget);
        }

        try {
            $response = $kernel->handle($request);
            self::assertSame($expectedStatus, $response->getStatusCode());
            self::assertSame($expectedType, $this->responseJson($response)['type']);
        } finally {
            $kernel->shutdown();
        }
    }

    /** @return iterable<string, array{string, string, string, int, string}> */
    public static function rawNormalizedMismatchProvider(): iterable
    {
        yield 'enabled encoded prefix' => [
            'test',
            '/_g%61untlet/v1/manifest',
            '/_g%61untlet/v1/manifest',
            400,
            'urn:gauntlet:problem:invalid-path',
        ];
        yield 'disabled encoded prefix' => [
            'disabled',
            '/_g%61untlet/v1/manifest',
            '/_g%61untlet/v1/manifest',
            503,
            'urn:gauntlet:problem:adapter-disabled',
        ];
        yield 'enabled absolute form' => [
            'test',
            'http://example.test/_gauntlet/v1/manifest',
            'http://example.test/_gauntlet/v1/manifest',
            400,
            'urn:gauntlet:problem:invalid-path',
        ];
        yield 'disabled absolute form' => [
            'disabled',
            'http://example.test/_gauntlet/v1/manifest',
            'http://example.test/_gauntlet/v1/manifest',
            503,
            'urn:gauntlet:problem:adapter-disabled',
        ];
    }
}
