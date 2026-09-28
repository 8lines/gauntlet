<?php

declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use EightLines\Gauntlet\SymfonyBundle\GauntletBundle;
use Symfony\Bundle\FrameworkBundle\FrameworkBundle;
use Symfony\Component\Config\Loader\LoaderInterface;
use Symfony\Component\DependencyInjection\ContainerBuilder;
use Symfony\Component\HttpKernel\Kernel;

final class DisabledGauntletKernel extends Kernel
{
    public function registerBundles(): iterable
    {
        yield new FrameworkBundle();
        yield new GauntletBundle();
    }

    public function registerContainerConfiguration(LoaderInterface $loader): void
    {
        $loader->load(static function (ContainerBuilder $container): void {
            $container->loadFromExtension('framework', [
                'secret' => 'consumer-kernel-secret',
                'test' => true,
            ]);
            $container->loadFromExtension('gauntlet', ['enabled' => false]);
        });
    }

    public function getCacheDir(): string
    {
        return sys_get_temp_dir() . '/gauntlet-consumer/cache';
    }

    public function getLogDir(): string
    {
        return sys_get_temp_dir() . '/gauntlet-consumer/log';
    }
}

$kernel = new DisabledGauntletKernel('test', false);
$kernel->boot();
if (!$kernel->getContainer()->has('kernel')) {
    throw new RuntimeException('Symfony bundle consumer check failed.');
}
$kernel->shutdown();
