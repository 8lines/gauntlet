import assert from "node:assert/strict";
import test from "node:test";

import { read } from "./support.mjs";

test("security policy uses private reporting and states the deployment boundary", () => {
  const security = read("SECURITY.md");
  assert.match(security, /security\/advisories\/new/u);
  assert.match(security, /Do not open a public issue/iu);
  assert.match(security, /non-production/iu);
  assert.match(security, /Built-in authentication is optional and off by default/u);
  assert.match(security, /does not replace the private boundary/u);
  assert.match(security, /public adapter/iu);
});

test("changelog describes the exact first release and its limitations", () => {
  const changelog = read("CHANGELOG.md");
  assert.match(changelog, /^## \[0\.1\.0\] - 2026-09-28$/mu);
  assert.match(changelog, /dashboard and Fastify control plane/iu);
  assert.match(changelog, /Docker Compose and Helm/iu);
  assert.match(changelog, /authentication is deferred/iu);
  assert.match(changelog, /one replica/iu);
});

test("contribution policy requires protocol-first tests and every supported runtime", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /RED.*GREEN.*REFACTOR/isu);
  assert.match(contributing, /OpenAPI.*schemas.*fixtures.*SDKs.*conformance/isu);
  assert.match(contributing, /Node\.js 24–26/u);
  assert.match(contributing, /PHP 8\.3.*Symfony 7\.4/isu);
  assert.match(contributing, /Java 21/u);
  assert.match(contributing, /pnpm release:verify/u);
  assert.match(contributing, /arbitrary SQL.*shell.*URL/isu);
  assert.match(contributing, /## Change files/u);
  assert.match(contributing, /\.changes\/<name>\.md/u);
  assert.match(contributing, /`none`/u);
  assert.match(contributing, /pnpm release:changes --check/u);
  assert.match(contributing, /breaking change is `minor`/u);
  assert.match(contributing, /commit your change files and run\s+`git fetch origin main`/u);
  assert.match(contributing, /does not see uncommitted change\s+files/u);
  assert.match(contributing, /Dependabot/u);
  assert.match(contributing, /`patch` when the dependency change ships[^.]*`none` with the reason/su);
});

test("contribution policy says when and how to re-bind skill evaluation receipts", () => {
  const contributing = read("CONTRIBUTING.md");
  assert.match(contributing, /## Skill evaluation receipts/u);
  assert.match(contributing, /skill-evals\/\*\/external-inputs\.json/u);
  assert.match(contributing, /skill\s+text under `skills\/`/u);
  assert.match(contributing, /pnpm skills:rebind --reason "/u);
  assert.match(contributing, /commit them with the change/u);
});
