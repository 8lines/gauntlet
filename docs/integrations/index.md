# Application integrations

An application integrates by installing the framework-neutral runtime plus one
transport package, defining a finite catalog in application code, and exposing
the normalized `/_gauntlet/v1` API only on its private environment path.
Gauntlet then adds one explicit target with a matching environment identity.

## Supported stacks

| Application | Packages | Guide |
| --- | --- | --- |
| Native Node.js 24–26 | `@8lines/gauntlet-typescript-core@0.1.9` and `@8lines/gauntlet-typescript-node@0.1.9` | [Node transport](../../packages/typescript/node/README.md) |
| Next.js App Router on Node.js 24–26 | `@8lines/gauntlet-typescript-core@0.1.9` and `@8lines/gauntlet-next-adapter@0.1.9` | [Next.js bridge](../../packages/typescript/next/README.md) |
| PHP 8.3+ without a framework transport | `8lines/gauntlet-php-core` at `0.1.8` | [PHP Core](../../packages/php/core/README.md) |
| Symfony 7.4 on PHP 8.3+, or Symfony 8.x on PHP 8.4+ | PHP Core and `8lines/gauntlet-symfony-bundle` at `0.1.8` | [Symfony bundle](../../packages/php/symfony-bundle/README.md) |
| Java 21 | `dev.eightlines.gauntlet:core:0.1.8` | [Java SDK](../../packages/java/README.md) |
| Spring Boot on Java 21 | Core and `dev.eightlines.gauntlet:spring-boot-starter:0.1.8` | [Spring starter](../../packages/java/spring-boot-starter/README.md) |

npm and Composer packages are public on npmjs.org and Packagist; the Java
packages come from GitHub Packages, which requires a GitHub token to read.
[Installing packages](../releases/installing-packages.md) covers every
ecosystem. Do not copy SDK source directories into an application; consume the
immutable released artifact.

## Integration sequence

1. Prove the deployment is non-production from infrastructure evidence; do
   not infer this from a requested label.
2. Install the exact package versions listed above for one supported stack.
3. Configure adapter enablement, structured environment identity, and one
   stable secret reference. There is no production override.
4. Register application-owned features, operations, and optional data sources.
5. Mount exactly one normalized transport at `/_gauntlet/v1`.
6. Keep that prefix private and add explicit public-ingress denial.
7. Configure one control-plane target with the adapter's internal origin and
   exact `expectedEnvironment`.
8. Verify disabled, production-like, mismatch, conformance, public-route, and
   private-dashboard behavior before reporting completion.

The control plane does not need a framework plugin. The plugin or starter lives
inside the target application because only that application can safely bind an
operation to its domain services.

## Framework notes

Symfony uses bundle configuration and dependency injection attributes to
assemble the catalog. The bundle remains disabled unless explicitly enabled in
the selected environment. Spring uses starter configuration and annotated or
typed beans; verify multi-replica runtime state rather than assuming the
control plane's one-replica setting constrains the application.

The Node transport owns raw HTTP routing. The Next.js bridge must sit behind a
trusted ingress that rejects hostile raw request targets before framework path
normalization. Route-handler tests using only a decoded pathname are not enough
to claim raw-path hardening.

## Dashboard and AI access

Once the adapter is connected, both the dashboard and the optional [MCP
endpoint](../mcp.md) use its registered catalog. No separate MCP server belongs
in the application. Use [getting started](../getting-started.md) to configure
the control plane and [authoring](../extensions/authoring.md) to add operations.

## Embeddable widget

An application can also embed a floating button and panel on its own pages so
testers can run placed operations without leaving the page under test. This is
a separate, optional integration on top of the adapter above. See the
[embeddable widget guide](widget.md).

## What to return from an integration change

Record exact changed files, package versions, commands and outputs, deployed
environment/network evidence, conformance results, public-route probes,
remaining risks, and a truthful complete/incomplete verdict. Redact secrets but
do not replace missing evidence with an assertion.

The installable `$gauntlet-app-integration` Codex skill turns this sequence
into a fail-closed implementation workflow; see [AI skills](../ai-skills.md).
