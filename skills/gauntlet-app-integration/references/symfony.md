# Symfony

Support PHP 8.3+ with Symfony 7.4, or PHP 8.4+ with Symfony 8.x. From Packagist, install exact release `0.1.2` of `8lines/gauntlet-php-core` and `8lines/gauntlet-symfony-bundle`; do not add custom `repositories` entries, `auth.json`, tokens, or credential-bearing URLs.

Register `EightLines\Gauntlet\SymfonyBundle\GauntletBundle` only for explicit non-production environments in `config/bundles.php`. Put its configuration and route import in environment-scoped directories such as `config/packages/staging/` and `config/routes/staging/`. Import `@GauntletBundle/config/routes.php` exactly once with `type: php` and no extra prefix; the bundle already owns `/_gauntlet/v1`.

Configure `enabled`, application `id`, `label`, and a structured environment object with exact `name` and non-production `kind`. Reference `%env(GAUNTLET_IDEMPOTENCY_SECRET)%`; do not inspect its value. The enabled container must fail compilation/startup for missing metadata, production-like environment identity, or a secret shorter than the package contract.

Map the deployment's organization-specific production aliases and infrastructure identities before registration or enablement; passing the built-in token check is only a minimum and an ambiguous identity blocks enablement.

The built-in `InMemoryRunStore` and `InMemoryExecutionCoordinator` are only for kernel tests or a genuinely single-process development runtime. Multiple PHP workers or pods require application-owned shared implementations for both, including atomic idempotency reservation, compare-and-set run updates, distributed admission/FIFO leases, and cancellation publication. A shared store with an in-memory coordinator is not enough.

A dispatcher may schedule only the supplied non-serializable task in its current PHP process; never send it through Messenger, a database, or an external queue. Shared components provide distributed admission and cancellation visibility, but cannot replay or resume that task after process loss. Use a verified singleton execution process with no durability claim, or leases/heartbeats that terminalize orphaned/stale runs and recover through a newly created application execution. Never claim durable execution replay.

When SSE is advertised, add shared durable event history and a live event backplane without conflating event durability with execution durability.

Configure one Gauntlet target at the internal service URL with exact `expectedEnvironment`. Keep the adapter prefix private and explicitly denied on every public ingress.

Run Composer install/audit, container compilation, package tests, disabled-prefix and production-like startup tests, mismatch tests on every proxy path, one-route inspection, application-specific live Adapter v1 checks, and public encoded/duplicate-slash denial. A synthetic fixture probe or parsed YAML is not customer-deployment proof. Prefer the released bundle configuration/source metadata and `examples/symfony` from the matching release; reject any stale scalar-environment example.
