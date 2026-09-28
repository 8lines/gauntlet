import assert from "node:assert/strict";
import test from "node:test";

import { read } from "./support.mjs";

test("security policy uses private reporting and states the deployment boundary", () => {
  const security = read("SECURITY.md");
  assert.match(security, /security\/advisories\/new/u);
  assert.match(security, /Do not open a public issue/iu);
  assert.match(security, /non-production/iu);
  assert.match(security, /authentication is deferred/iu);
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
});
