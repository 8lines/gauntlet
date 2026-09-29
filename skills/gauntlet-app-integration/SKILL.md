---
name: gauntlet-app-integration
description: Use when connecting an existing Node.js, Next.js, Symfony, or Spring application or deployment to Gauntlet, or when deciding whether a Gauntlet adapter may be enabled, exposed, or reported complete, especially when environment identity, ingress or adapter routing, replica count, package installation, or conformance evidence must be established.
---

# Integrating Gauntlet

## Core Principle

Complete an integration only when code, deployment, and negative-path evidence agree that one explicit adapter is private and non-production. Metadata alone cannot prove physical infrastructure identity.

## Required Routing

Read [safety gates](references/safety-gates.md) first. Then read exactly one stack guide: [Node](references/node.md), [Next.js](references/nextjs.md), [Symfony](references/symfony.md), or [Spring](references/spring.md). Read [deployment](references/deployment.md) when connecting Compose or Kubernetes, and always finish with [verification](references/verification.md).

## Scope

Use released packages to connect an existing application and its deployment. The application owns its finite catalog and domain-service bindings; Gauntlet owns discovery and UI. This skill does not design operations, data sources, schemas, arbitrary executors, or production access. Use `$gauntlet-extension-authoring` when installed, or the repository's `docs/extensions/authoring.md`, for application capabilities.

Inspect real application and deployment configuration before editing. Prefer the application's existing package manager, framework conventions, secret manager, shared state, network policy, tests, and manifests. Consume exact `0.1.2` artifacts; never copy package source from this monorepo into the target application.

Keep the adapter absent or disabled while any gate is unresolved. There is no production override: a production or production-aliased deployment never gets the adapter, whatever route, identity map, or evidence is added; only a separate non-production deployment can be integrated. Built-in production tokens are only a minimum denylist: map the organization's aliases and infrastructure identities before enablement, and treat ambiguity as a blocker. Do not expose an adapter through a public wildcard, rely on an obscure path, generate a secret per process, or infer application runtime safety from the control plane's replica count. Shared state never makes a process-local operation durably replayable. For a non-production deployment, only a verified private route or ingress block unblocks a publicly reachable adapter. Name it as the only exposure unblock; never offer adapter authentication, sign-off, risk acceptance, an exception, or a banner, even conditionally.

## Completion Contract

Make the smallest application and deployment changes that establish:

- one released runtime and one stack transport;
- one structured application environment, one matching explicit target, and a resolved organization-specific production identity map;
- one normalized `/_gauntlet/v1` mount;
- disabled-by-default behavior with production-like startup denial;
- a stable secret reference and runtime, dispatch, cancellation, process-loss recovery, and event components truthful for the process/pod count;
- a private adapter path, public-prefix denial, and a private dashboard path;
- live application-specific Adapter v1 contract evidence against the deployed private route.

A fixture verifier, rendered manifest, decoded framework route test, or successful configuration parse is not live network evidence. Report configuration completion separately and keep the overall verdict incomplete until the required deployed probes actually ran.

Return these sections: `Changed files`, `Environment evidence`, `Network evidence`, `Runtime evidence`, `Tests`, `Unresolved risk`, and `Verdict`. Include commands and bounded outputs, redact values of secrets, and say `complete` only when `Unresolved risk` is empty.
