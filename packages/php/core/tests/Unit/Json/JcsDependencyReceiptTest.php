<?php

declare(strict_types=1);

namespace EightLines\Gauntlet\Core\Tests\Unit\Json;

use Composer\InstalledVersions;
use PHPUnit\Framework\TestCase;
use Tracing\Sdk\Canonicalize\JsonCanonicalizer;

final class JcsDependencyReceiptTest extends TestCase
{
    private const REFERENCE = 'a1592326fd45cb3e0f0aa8295cfbb2338de9855b';

    public function testPinnedOneMatrixCoordinateMetadataRequirementsAndImportsMatchTheApprovedReceipt(): void
    {
        $root = dirname(__DIR__, 3);
        $lockBytes = file_get_contents($root . '/composer.lock');
        $composerBytes = file_get_contents($root . '/composer.json');
        self::assertIsString($lockBytes);
        self::assertIsString($composerBytes);
        $lock = json_decode($lockBytes, true, 512, JSON_THROW_ON_ERROR);
        $composer = json_decode($composerBytes, true, 512, JSON_THROW_ON_ERROR);
        $packages = array_column($lock['packages'], null, 'name');
        $receipt = $packages['onematrix/tracing-sdk'];

        self::assertSame('1.1.0', $receipt['version']);
        self::assertSame(self::REFERENCE, $receipt['source']['reference']);
        self::assertSame(self::REFERENCE, $receipt['dist']['reference']);
        self::assertSame('', $receipt['dist']['shasum']);
        self::assertSame(['MIT'], $receipt['license']);
        self::assertSame(
            ['ext-curl', 'ext-dom', 'ext-json', 'ext-libxml', 'ext-mbstring'],
            array_values(array_filter(
                array_keys($receipt['require']),
                static fn (string $requirement): bool => str_starts_with($requirement, 'ext-'),
            )),
        );
        self::assertSame('1.1.0', $composer['require']['onematrix/tracing-sdk']);
        self::assertFalse($composer['config']['allow-plugins']);
        self::assertSame('1.1.0.0', InstalledVersions::getVersion('onematrix/tracing-sdk'));
        self::assertSame(self::REFERENCE, InstalledVersions::getReference('onematrix/tracing-sdk'));
        self::assertSame([
            'Tracing\Sdk\Canonicalize\JsonCanonicalizer',
            'Tracing\Sdk\Exception\CanonicalizationException',
        ], self::tracingImports($root));
    }

    public function testRawEngineIsExactlyFifteenOfSixteenBeforeTheOwnedScalarGuard(): void
    {
        $path = dirname(__DIR__, 6) . '/packages/protocol/fixtures/v1/jcs-revision-vectors.json';
        $bytes = file_get_contents($path);
        self::assertIsString($bytes);
        $fixture = json_decode($bytes, true, 512, JSON_THROW_ON_ERROR);
        $matches = 0;
        $mismatches = [];

        foreach ($fixture['vectors'] as $row) {
            $accepted = true;
            try {
                (new JsonCanonicalizer())->canonicalize($row['inputJson']);
            } catch (\Throwable) {
                $accepted = false;
            }
            $expectedAcceptance = !isset($row['expectedError']);
            if ($accepted === $expectedAcceptance) {
                ++$matches;
            } else {
                $mismatches[] = $row['name'];
            }
        }

        self::assertSame(15, $matches);
        self::assertSame(['non-exponential-unsafe-integer'], $mismatches);
    }

    /** @return list<string> */
    private static function tracingImports(string $root): array
    {
        $imports = [];
        foreach (['src', 'tests'] as $directory) {
            $files = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($root . '/' . $directory));
            foreach ($files as $file) {
                if (!$file->isFile() || $file->getExtension() !== 'php') {
                    continue;
                }
                $bytes = file_get_contents($file->getPathname());
                if (!is_string($bytes)) {
                    throw new \RuntimeException('Unable to inspect PHP imports.');
                }
                preg_match_all('/^use (Tracing\\\\Sdk\\\\[^;]+);$/m', $bytes, $matches);
                foreach ($matches[1] as $import) {
                    $imports[$import] = true;
                }
            }
        }
        $imports = array_keys($imports);
        sort($imports, SORT_STRING);

        return $imports;
    }
}
