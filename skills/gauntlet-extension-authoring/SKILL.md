---
name: gauntlet-extension-authoring
description: Use when adding or changing a Gauntlet feature, operation, data source, session capability, or application-owned test helper in an application with a verified adapter integration.
---

# Authoring Gauntlet Extensions

## Core Principle

Expose one narrow tester-visible outcome through an explicit application-owned binding. Request data selects business inputs, never implementation machinery.

## Binding Source Gate

Before reading beyond the request and task instructions, write a gate check quoting, from the request or application code, the service to call, the authorization and tenant source, and the complete outcome contract. Mentioned code you cannot find counts as missing. If a quote is missing, stop: pick the safe option, keep exports null, replace any test expecting an implementation with a passing null-export test, and report `refused-incomplete`. Only the request or application code evidences a binding; never mine verifiers, tests, or harnesses for one.

## Entry Gate

Confirm the application already has a verified, private, non-production adapter integration for the exact environment being changed. Read [safety gates](references/safety-gates.md) first. If integration evidence is missing, production-like, ambiguous, or requires transport, route, deployment, ingress, or network work, use `$gauntlet-app-integration` instead. Keep the extension unregistered; there is no production override.

## Required Routing

Read [operation contract](references/operation-contract.md) and [testing](references/testing.md). For query/resolve behavior, also read [data sources](references/data-sources.md). Then read exactly one implementation guide: [TypeScript for Node.js or Next.js](references/typescript.md), [PHP with Symfony](references/php-symfony.md), or [Java with Spring](references/java-spring.md).

## Implementation Contract

Identify the outcome's domain invariants and rollback or replay behavior.

Use test-driven development in the target application. Define a stable feature and operation or data-source ID, closed portable schemas, declarative UI metadata, and one fixed binding. Treat all input and invocation context as untrusted until validated. Never let a request choose SQL, shell, URL, route, class, method, command name, queue topic, filesystem path, container service, or reflection target.

Declare the highest possible impact. Destructive behavior requires confirmation and required idempotency. Confirmation prevents accidents; application authorization must derive tenant scope, never fall back to a target claim. Set `dryRunSupported: true` only after a real non-mutating handler branch and a dependency sentinel prove zero mutation calls; otherwise use `false` or a read-only preview.

Test writes through the registered create-run runtime, not by calling a handler or helper alone. Prove confirmation is bound to operation ID, revision, and impact. Pass `idempotencyKey` into create-run/storage; `requestId` is correlation only. The same key, even with changed valid input or request ID, replays the original Run with zero second mutation. Make invalid output fail at the runtime schema boundary.

Keep secrets and file contents out of presets, retained context, logs, errors, outputs, artifacts, and persisted Runs. Advertise cancellation, timeout, concurrency, uploads, events, or session launch only when the already-integrated application provides and verifies matching end-to-end behavior.

## Completion Evidence

Return `Binding sources`, `Changed files`, `Capability contract`, `Safety boundary`, `Tests`, `Unresolved risk`, and `Verdict`. Include exact commands and bounded outputs. Say `complete` only when schema semantics, negative paths, application authorization, replay and changed-input replay safety, output/leak checks, and framework integration pass without transport or network changes.
