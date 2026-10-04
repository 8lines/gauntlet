import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import * as security from "../security.mjs";

const COMMIT = "a".repeat(40);

function fixture(t) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-security-fixture-")));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return {
    root,
    write(relativePath, source) {
      const path = resolve(root, relativePath);
      mkdirSync(dirname(path), { mode: 0o700, recursive: true });
      writeFileSync(path, source, { mode: 0o600 });
      return relativePath;
    },
  };
}

function requiredComposerLocks(files) {
  return [
    files.write("examples/symfony/composer.json", '{"name":"8lines/gauntlet-symfony-example"}\n'),
    files.write("examples/symfony/composer.lock", '{"packages":[],"packages-dev":[]}\n'),
    files.write("packages/php/core/composer.json", '{"name":"8lines/gauntlet-php-core"}\n'),
    files.write("packages/php/core/composer.lock", '{"packages":[],"packages-dev":[]}\n'),
    files.write("packages/php/symfony-bundle/composer.json", '{"name":"8lines/gauntlet-symfony-bundle"}\n'),
    files.write("packages/php/symfony-bundle/composer.lock", '{"packages":[],"packages-dev":[]}\n'),
  ];
}

function cleanPnpmAudit(stderr = Buffer.alloc(0)) {
  return {
    status: 0,
    signal: null,
    stdout: Buffer.from('{"advisories":{},"metadata":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":0}}}'),
    stderr,
  };
}

function cleanComposerAudit(stderr = Buffer.alloc(0)) {
  return {
    status: 0,
    signal: null,
    stdout: Buffer.from('{"advisories":[],"abandoned":[],"filter":[]}'),
    stderr,
  };
}

function cleanTrivyAudit(kind, stderr = Buffer.alloc(0)) {
  return {
    status: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: kind === "filesystem" ? "/repository" : "/image/archive.tar",
      ArtifactType: kind === "filesystem" ? "filesystem" : "container_image",
      Results: null,
    })),
    stderr,
  };
}

function completeRepository(files) {
  return [
    files.write("VERSION", "0.1.0\n"),
    files.write("package.json", '{"name":"fixture","private":true,"packageManager":"pnpm@11.24.0"}\n'),
    files.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n"),
    files.write("pnpm-workspace.yaml", "packages: []\n"),
    ...requiredComposerLocks(files),
  ];
}

function gitResponse({ args }, root, paths) {
  if (args.includes("--show-toplevel")) {
    return { status: 0, signal: null, stdout: Buffer.from(`${root}\n`), stderr: Buffer.alloc(0) };
  }
  if (args.includes("HEAD^{commit}")) {
    return { status: 0, signal: null, stdout: Buffer.from(`${COMMIT}\n`), stderr: Buffer.alloc(0) };
  }
  if (args.includes("status")) {
    return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  }
  if (args.includes("ls-files")) {
    return { status: 0, signal: null, stdout: Buffer.from(`${paths.join("\0")}\0`), stderr: Buffer.alloc(0) };
  }
  throw new Error("unexpected git command");
}

test("security commands receive only the fixed locale, isolated homes, and PATH", () => {
  const sentinel = "credential-value-908173";
  const environment = security.sanitizedSecurityEnvironment(
    {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `/private/${sentinel}`,
      GH_TOKEN: sentinel,
      GITHUB_TOKEN: sentinel,
      NODE_AUTH_TOKEN: sentinel,
      NPM_TOKEN: sentinel,
      COMPOSER_AUTH: sentinel,
      HTTPS_PROXY: `https://user:${sentinel}@proxy.example`,
      AWS_SECRET_ACCESS_KEY: sentinel,
      SSH_AUTH_SOCK: `/private/${sentinel}.sock`,
    },
    {
      home: "/repo/.artifacts/security/work/home",
      temporary: "/repo/.artifacts/security/work/tmp",
      cache: "/repo/.artifacts/security/work/cache",
      userconfig: "/repo/.artifacts/security/work/npmrc",
    },
  );

  assert.deepEqual(environment, {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/repo/.artifacts/security/work/home",
    TMPDIR: "/repo/.artifacts/security/work/tmp",
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    CI: "true",
    NO_COLOR: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    PNPM_CONFIG_USERCONFIG: "/repo/.artifacts/security/work/npmrc",
    PNPM_CONFIG_CACHE_DIR: "/repo/.artifacts/security/work/cache",
    PNPM_CONFIG_IGNORE_SCRIPTS: "true",
    PNPM_CONFIG_UPDATE_NOTIFIER: "false",
    PNPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  });
  assert.equal(JSON.stringify(environment).includes(sentinel), false);
});

test("repository scanning detects credential material without retaining matched values", (t) => {
  const files = fixture(t);
  const githubToken = ["gh", "p_", "A".repeat(40)].join("");
  const password = "credential-sentinel-526801";
  const privateKey = [
    "-----BEGIN " + "PRIVATE KEY-----",
    Buffer.from("private-key-sentinel-117204").toString("base64"),
    "-----END " + "PRIVATE KEY-----",
    "",
  ].join("\n");
  const paths = [
    files.write("apps/server/src/runtime.mjs", `export const remote = "${githubToken}";\n`),
    files.write("config/runtime.yaml", `endpoint: https://operator:${password}@internal.example.com/api\n`),
    files.write("deploy/runtime.env", "ADMIN_PASSWORD=replace-before-release\n"),
    files.write("deploy/signing.pem", privateKey),
    files.write("deploy/client.key", Buffer.from([1, 2, 3, 4])),
    files.write("apps/server/test/hostile.test.ts", `const ignored = "${githubToken}";\n`),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.credentials, [
    { line: 1, path: "apps/server/src/runtime.mjs", rule: "github-token" },
    { line: 1, path: "apps/server/test/hostile.test.ts", rule: "github-token" },
    { line: 1, path: "config/runtime.yaml", rule: "credential-url" },
    { line: 1, path: "deploy/client.key", rule: "credential-file" },
    { line: 1, path: "deploy/runtime.env", rule: "literal-credential" },
    { line: 1, path: "deploy/signing.pem", rule: "pem-private-key" },
  ]);
  assert.equal(report.scannedFiles, 6);
  assert.equal(report.productionDefaultFiles, 5);
  const serialized = JSON.stringify(report);
  for (const value of [githubToken, password, "replace-before-release", "private-key-sentinel-117204"]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("repository scanning recognizes common provider credentials outside credential-named fields", (t) => {
  const files = fixture(t);
  const values = [
    ["aws-access-key", "AKIA" + "A".repeat(16)],
    ["npm-token", "npm_" + "B".repeat(36)],
    ["slack-token", ["xo", "xb-1234567890-", "C".repeat(24)].join("")],
    ["gitlab-token", "glpat-" + "D".repeat(24)],
    ["google-api-key", "AIza" + "E".repeat(35)],
    ["stripe-secret-key", "sk_live_" + "F".repeat(24)],
  ];
  const source = [
    ...values.map(([, value], index) => `VALUE_${index + 1}=${value}`),
    "//registry.npmjs.org/:_authToken=plain-auth-sentinel-801625",
    "",
  ].join("\n");
  const path = files.write("config/provider.env", source);

  const report = security.scanRepositoryFiles({ root: files.root, paths: [path] });

  assert.deepEqual(report.credentials, [
    { line: 1, path, rule: "aws-access-key" },
    { line: 2, path, rule: "npm-token" },
    { line: 3, path, rule: "slack-token" },
    { line: 4, path, rule: "gitlab-token" },
    { line: 5, path, rule: "google-api-key" },
    { line: 6, path, rule: "stripe-secret-key" },
    { line: 7, path, rule: "npm-auth-assignment" },
  ]);
  const serialized = JSON.stringify(report);
  for (const [, value] of values) assert.equal(serialized.includes(value), false);
  assert.equal(serialized.includes("plain-auth-sentinel-801625"), false);
});

test("repository scanning catches inline JSON and object credential literals", (t) => {
  const files = fixture(t);
  const values = ["inline-json-secret-420871", "inline-object-secret-790331"];
  const paths = [
    files.write("config/runtime.json", `{"database":{"password":"${values[0]}"}}\n`),
    files.write("apps/server/src/defaults.mjs", `export const defaults = { apiToken: "${values[1]}" };\n`),
    files.write("config/placeholders.json", '{"password":"${DATABASE_PASSWORD}","token":"{{ runtime_token }}"}\n'),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.credentials, [
    { line: 1, path: "apps/server/src/defaults.mjs", rule: "literal-credential" },
    { line: 1, path: "config/runtime.json", rule: "literal-credential" },
  ]);
  for (const value of values) assert.equal(JSON.stringify(report).includes(value), false);
});

test("repository scanning rejects unsafe production defaults but permits internal listeners", (t) => {
  const files = fixture(t);
  const paths = [
    files.write("Dockerfile", "FROM node:24\nUSER root\n"),
    files.write(
      "deploy/runtime.yaml",
      [
        "image: ghcr.io/acme/runtime:latest",
        "host_ip: 0.0.0.0",
        "privileged: true",
        "allowPrivilegeEscalation: true",
        "runAsNonRoot: false",
        "readOnlyRootFilesystem: false",
        "cidr: 0.0.0.0/0",
        "kind: production",
        "",
      ].join("\n"),
    ),
    files.write(
      "deploy/compose.yaml",
      "environment:\n  GAUNTLET_HOST: \"0.0.0.0\"\nports:\n  host_ip: 127.0.0.1\nread_only: true\n",
    ),
    files.write("pnpm-workspace.yaml", "auditConfig:\n  ignoreGhsas: [GHSA-abcd-efgh-ijkl]\n"),
    files.write("deploy/test/runtime.test.yaml", "image: example.invalid/runtime:latest\nprivileged: true\n"),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 2, path: "Dockerfile", rule: "root-container-user" },
    { line: 1, path: "deploy/runtime.yaml", rule: "floating-image-tag" },
    { line: 2, path: "deploy/runtime.yaml", rule: "public-bind" },
    { line: 3, path: "deploy/runtime.yaml", rule: "privileged-container" },
    { line: 4, path: "deploy/runtime.yaml", rule: "privilege-escalation" },
    { line: 5, path: "deploy/runtime.yaml", rule: "non-root-disabled" },
    { line: 6, path: "deploy/runtime.yaml", rule: "writable-root-filesystem" },
    { line: 7, path: "deploy/runtime.yaml", rule: "public-network" },
    { line: 8, path: "deploy/runtime.yaml", rule: "production-environment" },
    { line: 1, path: "pnpm-workspace.yaml", rule: "audit-suppression" },
    { line: 2, path: "pnpm-workspace.yaml", rule: "audit-suppression" },
  ]);
  assert.deepEqual(report.credentials, []);
  assert.equal(report.scannedFiles, 5);
  assert.equal(report.productionDefaultFiles, 4);
});

test("repository scanning rejects current and legacy pnpm audit suppression settings", (t) => {
  const files = fixture(t);
  const path = files.write(
    "pnpm-workspace.yaml",
    [
      "audit:",
      "  ignore:",
      "    - GHSA-abcd-efgh-ijkl",
      "auditConfig:",
      "  ignoreGhsas:",
      "    - GHSA-2345-6789-cfgh",
      "  ignoreCves:",
      "    - CVE-2026-12345",
      "",
    ].join("\n"),
  );

  const report = security.scanRepositoryFiles({ root: files.root, paths: [path] });

  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 1, path, rule: "audit-suppression" },
    { line: 4, path, rule: "audit-suppression" },
    { line: 5, path, rule: "audit-suppression" },
    { line: 7, path, rule: "audit-suppression" },
  ]);
});

test("repository scanning catches inline JSON and split Helm production defaults", (t) => {
  const files = fixture(t);
  const jsonPath = files.write(
    "deploy/defaults.json",
    '{"image":{"tag":"latest"},"securityContext":{"privileged":true,"allowPrivilegeEscalation":true,"runAsNonRoot":false,"readOnlyRootFilesystem":false},"environment":{"kind":"live"}}\n',
  );
  const valuesPath = files.write("deploy/values.yaml", "image:\n  tag: latest\n");
  const configPath = files.write("config/runtime.yaml", "environment:\n  kind: prod\n");

  const report = security.scanRepositoryFiles({ root: files.root, paths: [valuesPath, jsonPath, configPath] });

  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 2, path: configPath, rule: "production-environment" },
    { line: 1, path: jsonPath, rule: "floating-image-tag" },
    { line: 1, path: jsonPath, rule: "non-root-disabled" },
    { line: 1, path: jsonPath, rule: "privilege-escalation" },
    { line: 1, path: jsonPath, rule: "privileged-container" },
    { line: 1, path: jsonPath, rule: "production-environment" },
    { line: 1, path: jsonPath, rule: "writable-root-filesystem" },
    { line: 2, path: valuesPath, rule: "floating-image-tag" },
  ]);
});

test("deployable examples receive the full credential and production-default scan", (t) => {
  const files = fixture(t);
  const sentinel = "deployable-example-secret-920581";
  const paths = [
    files.write("examples/node/Dockerfile", "FROM node\nUSER 0:0\n"),
    files.write("examples/node/runtime.env", `ADMIN_PASSWORD=${sentinel}\n`),
    files.write("packages/java/spring-example/compose.yaml", "network_mode: host\n"),
    files.write("deploy/helm/examples/compose.yaml", 'ports:\n  - "0.0.0.0:8080:8080"\n'),
    files.write("examples/node/test/fixture.test.yaml", "privileged: true\nTOKEN=fixture-only\n"),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.credentials, [
    { line: 1, path: "examples/node/runtime.env", rule: "literal-credential" },
  ]);
  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 2, path: "deploy/helm/examples/compose.yaml", rule: "public-published-port" },
    { line: 1, path: "examples/node/Dockerfile", rule: "floating-image-tag" },
    { line: 2, path: "examples/node/Dockerfile", rule: "root-container-user" },
    { line: 1, path: "packages/java/spring-example/compose.yaml", rule: "host-network" },
  ]);
  assert.equal(report.productionDefaultFiles, 4);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test("Dockerfile directives are not inferred from SQL embedded in application source", (t) => {
  const files = fixture(t);
  const path = files.write(
    "examples/symfony/src/RunStore.php",
    "<?php\n$query = <<<'SQL'\nSELECT user_id\nFROM gauntlet_runs\nWHERE user_id = 0\nSQL;\n",
  );

  const report = security.scanRepositoryFiles({ root: files.root, paths: [path] });

  assert.deepEqual(report.unsafeProductionDefaults, []);
  assert.equal(report.productionDefaultFiles, 1);
});

test("deployable PHP arrays cannot hide literal credentials behind the pair operator", (t) => {
  const files = fixture(t);
  const sentinels = ["php-framework-secret-815307", "php-idempotency-secret-274906"];
  const path = files.write(
    "examples/symfony/src/Kernel.php",
    `<?php\nreturn [\n    'secret' => '${sentinels[0]}',\n    'idempotency_secret' => '${sentinels[1]}',\n];\n`,
  );

  const report = security.scanRepositoryFiles({ root: files.root, paths: [path] });

  assert.deepEqual(report.credentials, [
    { line: 3, path, rule: "literal-credential" },
    { line: 4, path, rule: "literal-credential" },
  ]);
  for (const sentinel of sentinels) assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test("repository scanning rejects every public bind wildcard", (t) => {
  const files = fixture(t);
  const paths = [
    files.write("deploy/star.env", "GAUNTLET_BIND=*\n"),
    files.write("deploy/ipv6.json", '{"host_ip":"[::]"}\n'),
    files.write("deploy/internal.env", "GAUNTLET_BIND=::1\n"),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 1, path: "deploy/ipv6.json", rule: "public-bind" },
    { line: 1, path: "deploy/star.env", rule: "public-bind" },
  ]);
});

test("repository scanning ignores parser identifiers, disabled tokens, documentation, and attack fixtures", (t) => {
  const files = fixture(t);
  const paths = [
    files.write(
      "apps/server/src/parser.ts",
      "const HTTP_TOKEN = \"[A-Za-z0-9-]+\";\nconst secret = source.slice(start, offset);\n",
    ),
    files.write(
      "deploy/helm/gauntlet/templates/deployment.yaml",
      "automountServiceAccountToken: false\nsecurityContext:\n  runAsNonRoot: true\n",
    ),
    files.write("deploy/helm/test-private-ingress.mjs", 'const attack = "0.0.0.0/0";\n'),
    files.write("packages/runtime/README.md", "Configure idempotency-secret: example-value in a private environment.\n"),
    files.write(".github/workflows/release.yml", "permissions:\n  contents: write\n  id-token: write\n"),
  ];

  assert.deepEqual(security.scanRepositoryFiles({ root: files.root, paths }), {
    credentials: [],
    productionDefaultFiles: 3,
    scannedFiles: 5,
    unsafeProductionDefaults: [],
  });
});

test("repository scanning treats only top-level skill evaluation preparers as reference material", (t) => {
  const files = fixture(t);
  const providerToken = ["gh", "p_", "A".repeat(40)].join("");
  const source = 'const fixture = { secret: "synthetic-eval-secret", kind: "production" };\n';
  const paths = [
    files.write("skill-evals/adapter/prepare-fixture.mjs", `${source}const providerToken = "${providerToken}";\n`),
    files.write("skill-evals/adapter/runtime.mjs", source),
    files.write("skill-evals-shadow/adapter/runtime.mjs", source),
    files.write("nested/skill-evals/adapter/prepare-fixture.mjs", source),
  ];

  const report = security.scanRepositoryFiles({ root: files.root, paths });

  assert.deepEqual(report.credentials, [
    { line: 1, path: "nested/skill-evals/adapter/prepare-fixture.mjs", rule: "literal-credential" },
    { line: 1, path: "skill-evals-shadow/adapter/runtime.mjs", rule: "literal-credential" },
    { line: 2, path: "skill-evals/adapter/prepare-fixture.mjs", rule: "github-token" },
    { line: 1, path: "skill-evals/adapter/runtime.mjs", rule: "literal-credential" },
  ]);
  assert.deepEqual(report.unsafeProductionDefaults, [
    { line: 1, path: "nested/skill-evals/adapter/prepare-fixture.mjs", rule: "production-environment" },
    { line: 1, path: "skill-evals-shadow/adapter/runtime.mjs", rule: "production-environment" },
    { line: 1, path: "skill-evals/adapter/runtime.mjs", rule: "production-environment" },
  ]);
  assert.equal(report.productionDefaultFiles, 3);
});

test("repository scanning rejects an aliased repository root without exposing its target", (t) => {
  const files = fixture(t);
  files.write("package.json", "{}\n");
  const aliasParent = realpathSync(mkdtempSync(resolve(tmpdir(), "gauntlet-security-alias-")));
  t.after(() => rmSync(aliasParent, { force: true, recursive: true }));
  const alias = resolve(aliasParent, "repository");
  symlinkSync(files.root, alias, "dir");

  assert.throws(
    () => security.scanRepositoryFiles({ root: alias, paths: ["package.json"] }),
    (error) => {
      assert.equal(error.message, "Release security gate failed closed");
      assert.equal(error.message.includes(files.root), false);
      return true;
    },
  );
});

test("repository scanning rejects file symlinks and hardlinks without exposing their targets", (t) => {
  const files = fixture(t);
  const sentinel = "linked-file-secret-578210";
  files.write("outside.env", `ADMIN_PASSWORD=${sentinel}\n`);
  symlinkSync(resolve(files.root, "outside.env"), resolve(files.root, "linked.env"));
  assert.throws(
    () => security.scanRepositoryFiles({ root: files.root, paths: ["linked.env"] }),
    (error) => error.message === "Release security gate failed closed" && !error.message.includes(sentinel),
  );

  files.write("original.env", "SAFE=true\n");
  linkSync(resolve(files.root, "original.env"), resolve(files.root, "hardlinked.env"));
  assert.throws(
    () => security.scanRepositoryFiles({ root: files.root, paths: ["hardlinked.env"] }),
    { message: "Release security gate failed closed" },
  );
});

test("pnpm audit normalization reports vulnerabilities and blocks fixable high severity", () => {
  const sentinel = "registry-response-secret-725190";
  const result = security.normalizePnpmAuditResult({
    status: 1,
    signal: null,
    stderr: Buffer.from(sentinel),
    stdout: Buffer.from(JSON.stringify({
      advisories: {
        103: {
          id: 103,
          title: sentinel,
          module_name: "gamma",
          vulnerable_versions: "<3.0.0",
          patched_versions: ">=3.0.0",
          severity: "moderate",
          github_advisory_id: "",
          url: `https://advisories.example/${sentinel}`,
          findings: [{ version: "2.0.0", paths: [sentinel], dev: false, optional: false, bundled: false }],
        },
        101: {
          id: 101,
          title: sentinel,
          module_name: "alpha",
          vulnerable_versions: "<2.0.0",
          patched_versions: ">=2.0.0",
          severity: "high",
          github_advisory_id: "GHSA-2345-6789-cfgh",
          url: "https://github.com/advisories/GHSA-2345-6789-cfgh",
          findings: [{ version: "1.0.0", paths: ["alpha>transitive"], dev: false, optional: false, bundled: false }],
        },
        102: {
          id: 102,
          title: sentinel,
          module_name: "zeta",
          vulnerable_versions: "*",
          patched_versions: null,
          patched_versions_unpublished: true,
          severity: "critical",
          github_advisory_id: "GHSA-cfgh-jmpq-rvwx",
          url: "https://github.com/advisories/GHSA-cfgh-jmpq-rvwx",
          findings: [{ version: "9.0.0", paths: ["zeta"], dev: false, optional: false, bundled: false }],
        },
      },
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 1 },
        dependencies: 3,
        devDependencies: 500,
        optionalDependencies: 0,
        totalDependencies: 503,
      },
    })),
  });

  assert.deepEqual(result, {
    schemaVersion: 1,
    scanner: "pnpm-audit",
    scope: "production",
    counts: { info: 0, low: 0, moderate: 1, high: 1, critical: 1 },
    blockingCount: 1,
    ok: false,
    vulnerabilities: [
      { fixability: "available", id: "GHSA-2345-6789-cfgh", package: "alpha", severity: "high" },
      { fixability: "available", id: "PNPM-103", package: "gamma", severity: "moderate" },
      { fixability: "unavailable", id: "GHSA-cfgh-jmpq-rvwx", package: "zeta", severity: "critical" },
    ],
  });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("pnpm audit validates metadata counts and blocks unknown HIGH or CRITICAL fixability", () => {
  const unknown = {
    advisories: {
      17: {
        id: 17,
        module_name: "dependency",
        severity: "critical",
        github_advisory_id: "GHSA-2345-6789-cfgh",
        findings: [{ version: "1.0.0", paths: ["dependency"], dev: false, optional: false, bundled: false }],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 1 } },
  };
  const report = security.normalizePnpmAuditResult({
    status: 1,
    signal: null,
    stdout: Buffer.from(JSON.stringify(unknown)),
    stderr: Buffer.alloc(0),
  });

  assert.equal(report.ok, false);
  assert.equal(report.blockingCount, 1);
  assert.deepEqual(report.vulnerabilities, [{
    fixability: "unknown",
    id: "GHSA-2345-6789-cfgh",
    package: "dependency",
    severity: "critical",
  }]);

  unknown.metadata.vulnerabilities.critical = 0;
  assert.throws(
    () => security.normalizePnpmAuditResult({
      status: 1,
      signal: null,
      stdout: Buffer.from(JSON.stringify(unknown)),
      stderr: Buffer.alloc(0),
    }),
    { message: "Release security gate failed closed" },
  );
});

test("pnpm audit normalization fails closed on a malformed advisory without echoing it", () => {
  const sentinel = "malformed-audit-secret-311850";
  const malformed = {
    advisories: {
      7: {
        id: 7,
        title: sentinel,
        module_name: "dependency",
        vulnerable_versions: "<2.0.0",
        patched_versions: ">=2.0.0",
        patched_versions_unpublished: sentinel,
        severity: "high",
        github_advisory_id: "GHSA-2345-6789-cfgh",
        findings: [{ version: "1.0.0", paths: [sentinel], dev: false, optional: false, bundled: false }],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
  };

  assert.throws(
    () => security.normalizePnpmAuditResult({
      status: 1,
      signal: null,
      stdout: Buffer.from(JSON.stringify(malformed)),
      stderr: Buffer.alloc(0),
    }),
    (error) => {
      assert.equal(error.message, "Release security gate failed closed");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("composer audit normalization blocks every advisory and abandoned package without retaining diagnostics", () => {
  const sentinel = "composer-advisory-secret-482103";
  const result = security.normalizeComposerAuditResult("packages/php/core/composer.lock", {
    status: 1,
    signal: null,
    stderr: Buffer.from(sentinel),
    stdout: Buffer.from(JSON.stringify({
      advisories: {
        "vendor/zeta": [{
          advisoryId: "PKSA-abcd-2345-6789",
          packageName: "vendor/zeta",
          affectedVersions: sentinel,
          title: sentinel,
          cve: null,
          link: `https://advisories.example/${sentinel}`,
          reportedAt: "2026-01-01T00:00:00+00:00",
          sources: [{ name: "GitHub", remoteId: sentinel }],
          severity: null,
        }],
        "vendor/alpha": [{
          advisoryId: "PKSA-cfgh-jmpq-rvwx",
          packageName: "vendor/alpha",
          affectedVersions: "<2.0.0",
          title: sentinel,
          cve: "CVE-2026-12345",
          link: null,
          reportedAt: "2026-01-02T00:00:00+00:00",
          sources: [{ name: "FriendsOfPHP/security-advisories", remoteId: "CVE-2026-12345" }],
          severity: "high",
        }],
      },
      abandoned: {
        "legacy/package": null,
        "old/package": "maintained/package",
      },
      filter: [],
    })),
  });

  assert.deepEqual(result, {
    lockfile: "packages/php/core/composer.lock",
    advisoryCount: 2,
    abandonedCount: 2,
    blockingCount: 4,
    ok: false,
    vulnerabilities: [
      { id: "PKSA-cfgh-jmpq-rvwx", package: "vendor/alpha", severity: "high" },
      { id: "PKSA-abcd-2345-6789", package: "vendor/zeta", severity: "unknown" },
    ],
    abandonedPackages: [
      { package: "legacy/package", replacementAvailable: false },
      { package: "old/package", replacementAvailable: true },
    ],
  });
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("composer audit normalization fails closed on suppressed or unreachable advisory results", () => {
  const sentinel = "composer-suppression-secret-806317";
  for (const payload of [
    {
      advisories: [],
      "ignored-advisories": { "vendor/package": [{ advisoryId: sentinel }] },
      abandoned: [],
      filter: [],
    },
    {
      advisories: [],
      abandoned: [],
      filter: [],
      "unreachable-repositories": [sentinel],
    },
  ]) {
    assert.throws(
      () => security.normalizeComposerAuditResult("examples/symfony/composer.lock", {
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify(payload)),
        stderr: Buffer.alloc(0),
      }),
      (error) => {
        assert.equal(error.message, "Release security gate failed closed");
        assert.equal(error.message.includes(sentinel), false);
        return true;
      },
    );
  }
});

test("Trivy normalization redacts evidence and blocks secrets, misconfigurations, and unknown fixes", () => {
  const sentinel = "trivy-evidence-secret-632018";
  const report = security.normalizeTrivyResult("filesystem", {
    status: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({
      SchemaVersion: 2,
      ArtifactName: "/repository",
      ArtifactType: "filesystem",
      Results: [
        {
          Target: "packages/java/core/gradle.lockfile",
          Class: "lang-pkgs",
          Type: "gradle",
          Vulnerabilities: [{
            VulnerabilityID: "CVE-2026-12345",
            PkgName: "org.example:dependency",
            InstalledVersion: "1.0.0",
            Severity: "HIGH",
            FixedVersion: "",
            Status: "affected",
            Title: sentinel,
          }],
        },
        {
          Target: "Dockerfile",
          Class: "config",
          Type: "dockerfile",
          Misconfigurations: [{
            ID: "DS002",
            Severity: "HIGH",
            Status: "FAIL",
            Title: sentinel,
            CauseMetadata: { Code: { Lines: [{ Content: sentinel }] } },
          }],
        },
        {
          Target: "config/runtime.env",
          Class: "secret",
          Type: "secret",
          Secrets: [{
            RuleID: "aws-access-key-id",
            Category: "AWS",
            Severity: "LOW",
            StartLine: 4,
            Match: sentinel,
            Code: { Lines: [{ Content: sentinel }] },
          }],
        },
      ],
    })),
    stderr: Buffer.from(sentinel),
  });

  assert.deepEqual(report, {
    schemaVersion: 1,
    scanner: "trivy-filesystem",
    scope: "repository-snapshot",
    counts: { vulnerabilities: 1, secrets: 1, misconfigurations: 1 },
    blockingCount: 3,
    ok: false,
    findings: [
      { kind: "misconfiguration", path: "Dockerfile", rule: "DS002", severity: "high" },
      { kind: "secret", line: 4, path: "config/runtime.env", rule: "aws-access-key-id", severity: "low" },
      {
        fixability: "unknown",
        fixedVersion: null,
        kind: "vulnerability",
        package: "org.example:dependency",
        path: "packages/java/core/gradle.lockfile",
        rule: "CVE-2026-12345",
        severity: "high",
        version: "1.0.0",
      },
    ],
  });
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test("Trivy results are bound to the exact filesystem or Docker archive target", () => {
  const result = (ArtifactName, ArtifactType) => ({
    status: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({ SchemaVersion: 2, ArtifactName, ArtifactType, Results: null })),
    stderr: Buffer.alloc(0),
  });

  assert.throws(
    () => security.normalizeTrivyResult("filesystem", result("/image/archive.tar", "filesystem")),
    { message: "Release security gate failed closed" },
  );
  assert.throws(
    () => security.normalizeTrivyResult("filesystem", result("/repository", "container_image")),
    { message: "Release security gate failed closed" },
  );
  assert.throws(
    () => security.normalizeTrivyResult("image", result("/repository", "container_image")),
    { message: "Release security gate failed closed" },
  );
  assert.throws(
    () => security.normalizeTrivyResult("image", result("/image/archive.tar", "filesystem")),
    { message: "Release security gate failed closed" },
  );
});

test("Trivy treats only explicit will-not-fix vulnerabilities as unavailable", () => {
  const payload = (status, fixedVersion = "") => ({
    SchemaVersion: 2,
    ArtifactName: "/image/archive.tar",
    ArtifactType: "container_image",
    Results: [{
      Target: "alpine:3.22",
      Class: "os-pkgs",
      Type: "alpine",
      Vulnerabilities: [{
        VulnerabilityID: "CVE-2026-54321",
        PkgName: "libexample",
        InstalledVersion: "1.0.0",
        Severity: "CRITICAL",
        FixedVersion: fixedVersion,
        Status: status,
      }],
    }],
  });
  const normalize = (status, fixedVersion) => security.normalizeTrivyResult("image", {
    status: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify(payload(status, fixedVersion))),
    stderr: Buffer.alloc(0),
  });

  assert.deepEqual(normalize("will_not_fix").findings[0], {
    fixability: "unavailable",
    fixedVersion: null,
    kind: "vulnerability",
    package: "libexample",
    path: "alpine:3.22",
    rule: "CVE-2026-54321",
    severity: "critical",
    version: "1.0.0",
  });
  assert.equal(normalize("will_not_fix").ok, true);
  assert.deepEqual(normalize("fixed", "1.2.3").findings[0], {
    fixability: "available",
    fixedVersion: "1.2.3",
    kind: "vulnerability",
    package: "libexample",
    path: "alpine:3.22",
    rule: "CVE-2026-54321",
    severity: "critical",
    version: "1.0.0",
  });
  assert.equal(normalize("fixed", "1.2.3").ok, false);
  assert.equal(normalize("unknown").findings[0].fixability, "unknown");
  assert.equal(normalize("unknown").ok, false);
});

test("Composer audit coverage is derived from the release catalog and rejects a new first-party lock", (t) => {
  const files = fixture(t);
  const paths = [
    ...requiredComposerLocks(files),
    files.write("tests/fixtures/vendor/composer.json", '{"name":"third-party/fixture"}\n'),
    files.write("tests/fixtures/vendor/composer.lock", '{"packages":[]}\n'),
  ];

  assert.deepEqual(security.deriveComposerAuditLockfiles({ root: files.root, paths }), {
    auditedLockfiles: [
      "examples/symfony/composer.lock",
      "packages/php/core/composer.lock",
      "packages/php/symfony-bundle/composer.lock",
    ],
    excludedReferenceLockfiles: ["tests/fixtures/vendor/composer.lock"],
  });

  paths.push(files.write("packages/php/new-adapter/composer.json", '{"name":"8lines/gauntlet-new-adapter"}\n'));
  paths.push(files.write("packages/php/new-adapter/composer.lock", '{"packages":[]}\n'));
  assert.throws(
    () => security.deriveComposerAuditLockfiles({ root: files.root, paths }),
    { message: "Release security gate failed closed" },
  );

  const referenceFiles = fixture(t);
  const referencePaths = [
    ...requiredComposerLocks(referenceFiles),
    referenceFiles.write("tests/fixtures/new/composer.json", '{"name":"8lines/gauntlet-hidden-first-party"}\n'),
    referenceFiles.write("tests/fixtures/new/composer.lock", '{"packages":[]}\n'),
  ];
  assert.throws(
    () => security.deriveComposerAuditLockfiles({ root: referenceFiles.root, paths: referencePaths }),
    { message: "Release security gate failed closed" },
  );

  for (const [manifest, lockfile] of [
    ["composer.json", "composer.lock"],
    ["services/third-party/composer.json", "services/third-party/composer.lock"],
  ]) {
    const unexplainedFiles = fixture(t);
    const unexplainedPaths = [
      ...requiredComposerLocks(unexplainedFiles),
      unexplainedFiles.write(manifest, '{"name":"third-party/unexplained"}\n'),
      unexplainedFiles.write(lockfile, '{"packages":[]}\n'),
    ];
    assert.throws(
      () => security.deriveComposerAuditLockfiles({ root: unexplainedFiles.root, paths: unexplainedPaths }),
      { message: "Release security gate failed closed" },
    );
  }
});

test("the staged image input is one canonical single-link Docker tar in a release-set tree", (t) => {
  const files = fixture(t);
  files.write("VERSION", "0.1.0\n");
  const relativePath = ".artifacts/release/local-0123456789ab/image/gauntlet-0.1.0.docker.tar";
  const archive = resolve(files.root, relativePath);
  files.write(relativePath, "docker-archive-fixture\n");

  const record = security.validateStagedImageArchive(files.root, archive);
  assert.equal(record.path, archive);
  assert.equal(record.relativePath, relativePath);
  assert.equal(record.size, 23);
  assert.match(record.sha256, /^[0-9a-f]{64}$/);

  const outside = files.write("outside.docker.tar", "outside\n");
  assert.throws(
    () => security.validateStagedImageArchive(files.root, resolve(files.root, outside)),
    { message: "Release security gate failed closed" },
  );

  const alias = resolve(files.root, ".artifacts/release/local-0123456789ab/image/alias.docker.tar");
  symlinkSync(archive, alias);
  assert.throws(
    () => security.validateStagedImageArchive(files.root, alias),
    { message: "Release security gate failed closed" },
  );

  const hardlink = resolve(files.root, ".artifacts/release/local-0123456789ab/image/hardlink.docker.tar");
  linkSync(archive, hardlink);
  assert.throws(
    () => security.validateStagedImageArchive(files.root, archive),
    { message: "Release security gate failed closed" },
  );
});

test("the staged image input lives only in a release-set root and is named for the gauntlet version", (t) => {
  const files = fixture(t);
  files.write("VERSION", "0.1.0\n");
  for (const relativePath of [
    ".artifacts/release/local-0123456789ab/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/release/release-2026-10-03.1/image/gauntlet-0.1.0.docker.tar",
  ]) {
    files.write(relativePath, "docker-archive-fixture\n");
    const record = security.validateStagedImageArchive(files.root, resolve(files.root, relativePath));
    assert.equal(record.relativePath, relativePath);
    assert.equal(record.size, 23);
  }
  for (const relativePath of [
    ".artifacts/release/release-2026-10-03.1/image/gauntlet-0.2.0.docker.tar",
    ".artifacts/release/0.1.0/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/release/0.1.1/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/release/local-0123/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/release/release-2026-02-30.1/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/other/local-0123456789ab/image/gauntlet-0.1.0.docker.tar",
  ]) {
    files.write(relativePath, "docker-archive-fixture\n");
    assert.throws(
      () => security.validateStagedImageArchive(files.root, resolve(files.root, relativePath)),
      { message: "Release security gate failed closed" },
      relativePath,
    );
  }
});

test("security CLI arguments expose only source-only or a staged image in a release-set root", () => {
  assert.deepEqual(security.parseSecurityArguments([]), { mode: "release", imageArchive: undefined });
  assert.deepEqual(security.parseSecurityArguments(["--source-only"]), { mode: "source-only" });
  for (const imageArchive of [
    ".artifacts/release/local-0123456789ab/image/gauntlet-0.1.0.docker.tar",
    ".artifacts/release/release-2026-10-03.1/image/gauntlet-0.1.9.docker.tar",
  ]) {
    assert.deepEqual(security.parseSecurityArguments(["--image-archive", imageArchive]), { mode: "release", imageArchive });
  }
  for (const argv of [
    ["--image-archive"],
    ["--source-only", "--image-archive", "archive.tar"],
    ["--image-archive", "../archive.tar"],
    ["--image-archive", "/tmp/archive.tar"],
    ["--image-archive", ".artifacts/release/0.1.0/image/gauntlet-0.1.0.docker.tar"],
    ["--image-archive", ".artifacts/release/0.1.1/image/gauntlet-0.1.0.docker.tar"],
    ["--image-archive", ".artifacts/release/local-0123/image/gauntlet-0.1.0.docker.tar"],
    ["--image-archive", ".artifacts/release/release-2026-13-01.1/image/gauntlet-0.1.0.docker.tar"],
    ["--image-archive", ".artifacts/release/../image/gauntlet-0.1.0.docker.tar"],
    ["--publish"],
  ]) {
    assert.throws(() => security.parseSecurityArguments(argv), { message: "Usage: security.mjs [--source-only | --image-archive <path>]" });
  }
});

test("full release mode runs pinned required Trivy scans and audits pnpm from an isolated fixed-registry snapshot", async (t) => {
  const files = fixture(t);
  const sentinel = "host-registry-secret-883451";
  const paths = [
    ...completeRepository(files),
    files.write(".npmrc", `registry=https://${sentinel}.invalid/\n@8lines:registry=https://${sentinel}.invalid/\n`),
    files.write("packages/java/core/gradle.lockfile", "org.example:dependency:1.0.0=runtimeClasspath\n"),
  ];
  const imageRelative = ".artifacts/release/release-2026-10-03.1/image/gauntlet-0.1.0.docker.tar";
  const imageArchive = resolve(files.root, imageRelative);
  files.write(imageRelative, "docker-archive-fixture\n");
  const outputDirectory = resolve(files.root, ".artifacts/security");
  const calls = [];
  let pnpmWorkingDirectory;
  const run = async (request) => {
    calls.push(request);
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") {
      pnpmWorkingDirectory = request.workingDirectory;
      assert.equal(pnpmWorkingDirectory.startsWith(`${files.root}/`), false);
      assert.equal(request.args.includes("--ignore-workspace"), true);
      for (const option of ["--ignore", "--ignore-unfixable", "--ignore-registry-errors"]) {
        assert.equal(request.args.includes(option), false);
      }
      assert.equal(readFileSync(resolve(pnpmWorkingDirectory, ".npmrc"), "utf8"), [
        "registry=https://registry.npmjs.org/",
        "@8lines:registry=https://registry.npmjs.org/",
        "ignore-scripts=true",
        "update-notifier=false",
        "",
      ].join("\n"));
      const auditIndex = request.args.indexOf("audit");
      assert.notEqual(auditIndex, -1);
      const probe = spawnSync("pnpm", [...request.args.slice(0, auditIndex), "config", "get", "registry"], {
        cwd: request.workingDirectory,
        encoding: "utf8",
        env: request.environment,
        timeout: 5_000,
      });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout, "https://registry.npmjs.org/\n");
      return cleanPnpmAudit(Buffer.from(sentinel));
    }
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      assert.equal(request.args.includes("aquasec/trivy:0.66.0@sha256:086971aaf400beebd94e8300fd8ea623774419597169156cec56eec5b00dfb1e"), true);
      assert.equal(request.args.includes("--scanners"), true);
      assert.equal(request.args.includes("vuln,misconfig,secret"), true);
      assert.equal(request.args.includes("--severity"), false);
      assert.equal(request.args.includes("--ignore-unfixed"), false);
      assert.equal(request.args.filter((argument) => argument.endsWith(",readonly")).length >= 2, true);
      assert.equal(request.args.includes("/tmp:rw,noexec,nosuid,nodev,size=2147483648,mode=1777"), true);
      return request.args.includes("filesystem")
        ? cleanTrivyAudit("filesystem", Buffer.from(sentinel))
        : cleanTrivyAudit("image", Buffer.from(sentinel));
    }
    if (request.command === "docker") return cleanComposerAudit(Buffer.from(sentinel));
    throw new Error("unexpected command");
  };

  const summary = await security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: process.env.PATH, NPM_TOKEN: sentinel },
    run,
    mode: "release",
    imageArchive,
  });

  assert.equal(summary.mode, "release");
  assert.equal(summary.scope, "exact-commit-and-staged-image");
  assert.equal(summary.sourceCommit, COMMIT);
  assert.equal(summary.sourceChecksOk, true);
  assert.equal(summary.ok, true);
  assert.deepEqual(summary.checks.slice(-2), [
    { name: "trivy-filesystem", required: true, status: "passed" },
    { name: "trivy-image", required: true, status: "passed" },
  ]);
  assert.equal(calls.filter(({ command, args }) => command === "docker"
    && args.some((argument) => argument.includes("aquasec/trivy"))).length, 2);
  assert.notEqual(pnpmWorkingDirectory, undefined);
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
});

test("source-only mode is useful but can never claim full release readiness", async (t) => {
  const files = fixture(t);
  const paths = completeRepository(files);
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") return cleanPnpmAudit();
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem");
    }
    if (request.command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };

  const summary = await security.runReleaseSecurity({
    root: files.root,
    outputDirectory: resolve(files.root, ".artifacts/security"),
    environment: { PATH: process.env.PATH },
    run,
    mode: "source-only",
  });

  assert.equal(summary.mode, "source-only");
  assert.equal(summary.scope, "working-tree-snapshot");
  assert.equal(summary.sourceChecksOk, true);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.checks.at(-1), {
    name: "trivy-image",
    required: false,
    status: "not-run",
    reason: "excluded-by-source-only-mode",
  });
});

test("full release mode runs source checks but fails closed when no staged image is supplied", async (t) => {
  const files = fixture(t);
  const paths = completeRepository(files);
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") return cleanPnpmAudit();
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem");
    }
    if (request.command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: process.env.PATH },
    run,
    mode: "release",
    imageArchive: undefined,
  }), { message: "Release security gate failed closed" });

  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  assert.equal(summary.mode, "release");
  assert.equal(summary.sourceChecksOk, true);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.checks.at(-1), {
    name: "trivy-image",
    required: true,
    status: "not-run",
    reason: "release-image-not-provided",
  });
});

test("a missing required Trivy runtime fails source-only verification without a fake PASS", async (t) => {
  const files = fixture(t);
  const sentinel = "missing-trivy-runtime-secret-370814";
  const paths = completeRepository(files);
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") return cleanPnpmAudit();
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      throw new Error(sentinel);
    }
    if (request.command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: process.env.PATH },
    run,
    mode: "source-only",
  }), (error) => error.message === "Release security gate failed closed" && !error.message.includes(sentinel));

  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  assert.equal(summary.sourceChecksOk, false);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.checks.find(({ name }) => name === "trivy-filesystem"), {
    name: "trivy-filesystem", required: true, status: "failed",
  });
  assert.equal(readFileSync(resolve(outputDirectory, "trivy-filesystem.json"), "utf8").includes(sentinel), false);
});

test("a repository mutation after the static scan invalidates the snapshot-bound result", async (t) => {
  const files = fixture(t);
  const paths = [...completeRepository(files), files.write("deploy/runtime.yaml", "read_only: true\n")];
  let mutated = false;
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") {
      files.write("deploy/runtime.yaml", "privileged: true\n");
      mutated = true;
      return cleanPnpmAudit();
    }
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem");
    }
    if (request.command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory: resolve(files.root, ".artifacts/security"),
    environment: { PATH: process.env.PATH },
    run,
    mode: "source-only",
  }), { message: "Release security gate failed closed" });
  assert.equal(mutated, true);
  assert.equal(JSON.parse(readFileSync(resolve(files.root, ".artifacts/security/summary.json"), "utf8")).ok, false);
});

test("release security runs the fixed read-only plan and writes deterministic redacted reports", async (t) => {
  const files = fixture(t);
  const sentinel = "inherited-release-credential-739204";
  const paths = [
    ...completeRepository(files),
    files.write("apps/server/src/main.mjs", "export const safe = true;\n"),
    files.write("tests/fixtures/vendor/composer.json", '{"name":"third-party/fixture"}\n'),
    files.write("tests/fixtures/vendor/composer.lock", '{"packages":[]}\n'),
  ];
  files.write("examples/symfony/composer.lock", '{"marker":"example"}\n');
  files.write("packages/php/core/composer.lock", '{"marker":"core"}\n');
  files.write("packages/php/symfony-bundle/composer.lock", '{"marker":"bundle"}\n');
  const outputDirectory = resolve(files.root, ".artifacts/security");
  mkdirSync(resolve(files.root, ".artifacts"), { mode: 0o755 });
  chmodSync(resolve(files.root, ".artifacts"), 0o755);
  const calls = [];
  const composerMarkers = [];
  const composerManifests = [];
  const run = async (request) => {
    calls.push(request);
    if (request.command === "git") return gitResponse(request, files.root, paths.toReversed());
    if (request.command === "pnpm") {
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(JSON.stringify({
          advisories: {},
          metadata: {
            vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
            dependencies: 1,
            devDependencies: 0,
            optionalDependencies: 0,
            totalDependencies: 1,
          },
        })),
        stderr: Buffer.from(sentinel),
      };
    }
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem", Buffer.from(sentinel));
    }
    if (request.command === "docker") {
      const mount = request.args[request.args.indexOf("--mount") + 1];
      const source = mount.slice("type=bind,src=".length, -",dst=/audit,readonly".length);
      composerMarkers.push(JSON.parse(readFileSync(resolve(source, "composer.lock"), "utf8")).marker);
      composerManifests.push(readFileSync(resolve(source, "composer.json"), "utf8"));
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from('{"advisories":[],"abandoned":[],"filter":[]}'),
        stderr: Buffer.from(sentinel),
      };
    }
    throw new Error(`unexpected command ${request.command}`);
  };
  const options = {
    root: files.root,
    outputDirectory,
    environment: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: `/private/${sentinel}`,
      GH_TOKEN: sentinel,
      GITHUB_TOKEN: sentinel,
      NODE_AUTH_TOKEN: sentinel,
      NPM_TOKEN: sentinel,
      COMPOSER_AUTH: sentinel,
      HTTPS_PROXY: `https://user:${sentinel}@proxy.example`,
    },
    run,
    mode: "source-only",
  };

  const first = await security.runReleaseSecurity(options);
  const reportNames = readdirSync(outputDirectory).sort();
  const firstBytes = new Map(reportNames.map((name) => [name, readFileSync(resolve(outputDirectory, name))]));
  const second = await security.runReleaseSecurity(options);

  assert.equal(first.schemaVersion, 1);
  assert.equal(first.mode, "source-only");
  assert.equal(first.scope, "working-tree-snapshot");
  assert.equal(first.sourceCommit, COMMIT);
  assert.equal(first.sourceChecksOk, true);
  assert.equal(first.ok, false);
  assert.deepEqual(first.checks.slice(-2), [
    { name: "trivy-filesystem", required: true, status: "passed" },
    { name: "trivy-image", required: false, status: "not-run", reason: "excluded-by-source-only-mode" },
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(reportNames, [
    "composer-audit.json",
    "credential-material.json",
    "pnpm-audit.json",
    "production-defaults.json",
    "source-snapshot.json",
    "summary.json",
    "trivy-filesystem.json",
    "trivy-image.json",
  ]);
  for (const name of reportNames) {
    const current = readFileSync(resolve(outputDirectory, name));
    assert.deepEqual(current, firstBytes.get(name), name);
    assert.equal(current.toString("utf8").includes(sentinel), false, name);
    assert.equal(current.at(-1), 0x0a, name);
  }
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "credential-material.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "credential-material",
    scannedFiles: paths.length,
    findings: [],
    ok: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "production-defaults.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "production-defaults",
    scannedFiles: paths.length - 2,
    findings: [],
    ok: true,
  });
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "pnpm-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "pnpm-audit",
    scope: "production",
    counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    blockingCount: 0,
    ok: true,
    vulnerabilities: [],
  });
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "composer-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "composer-audit",
    scope: "all-locked-dependencies",
    excludedReferenceLockfiles: ["tests/fixtures/vendor/composer.lock"],
    auditedLockfiles: [
      {
        lockfile: "examples/symfony/composer.lock",
        advisoryCount: 0,
        abandonedCount: 0,
        blockingCount: 0,
        ok: true,
        vulnerabilities: [],
        abandonedPackages: [],
      },
      {
        lockfile: "packages/php/core/composer.lock",
        advisoryCount: 0,
        abandonedCount: 0,
        blockingCount: 0,
        ok: true,
        vulnerabilities: [],
        abandonedPackages: [],
      },
      {
        lockfile: "packages/php/symfony-bundle/composer.lock",
        advisoryCount: 0,
        abandonedCount: 0,
        blockingCount: 0,
        ok: true,
        vulnerabilities: [],
        abandonedPackages: [],
      },
    ],
    advisoryCount: 0,
    abandonedCount: 0,
    blockingCount: 0,
    ok: true,
  });

  assert.equal(calls.filter(({ command }) => command === "pnpm").length, 2);
  assert.equal(calls.filter(({ command, args }) => command === "docker"
    && args.some((argument) => argument.includes("aquasec/trivy"))).length, 2);
  const composerCalls = calls.filter(({ command, args }) => command === "docker"
    && !args.some((argument) => argument.includes("aquasec/trivy")));
  assert.equal(composerCalls.length, 6);
  for (let runIndex = 0; runIndex < 2; runIndex += 1) {
    const pnpmCall = calls.filter(({ command }) => command === "pnpm")[runIndex];
    assert.deepEqual(pnpmCall.args.slice(-5), ["audit", "--prod", "--audit-level", "low", "--json"]);
    assert.equal(pnpmCall.args[0], "--config.registry=https://registry.npmjs.org/");
    assert.equal(pnpmCall.args.includes("--ignore-workspace"), true);
    assert.equal(pnpmCall.workingDirectory.startsWith(`${files.root}/`), false);
    for (let index = 0; index < 3; index += 1) {
      const dockerCall = composerCalls[runIndex * 3 + index];
      assert.deepEqual(dockerCall.args.slice(0, 19), [
        "run", "--rm", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--network", "bridge", "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        "--env", "HOME=/tmp/home", "--env", "COMPOSER_HOME=/tmp/composer",
        "--env", "COMPOSER_CACHE_DIR=/tmp/composer-cache", "--env", "COMPOSER_NO_INTERACTION=1",
      ]);
      const mountIndex = dockerCall.args.indexOf("--mount");
      assert.notEqual(mountIndex, -1);
      const mount = dockerCall.args[mountIndex + 1];
      assert.match(mount, new RegExp(`/gauntlet-release-security-[^,]+/composer-audit-${index},dst=/audit,readonly$`));
      assert.deepEqual(dockerCall.args.slice(-9), [
        "composer:2.10.3@sha256:4d045ea9f71d5d111a95e608400da61d187e487adf9eaf2dfe068998a8d4f584",
        "composer", "audit", "--locked", "--no-interaction", "--format=json", "--abandoned=fail",
        "--no-plugins", "--no-scripts",
      ]);
    }
    for (const call of calls) {
      assert.equal(call.timeoutMs > 0 && call.timeoutMs <= 360_000, true);
      assert.equal(JSON.stringify(call).includes(sentinel), false);
      assert.doesNotMatch(JSON.stringify([call.command, call.args]), /(?:publish|push|release create|--fix)/i);
    }
  }
  assert.deepEqual(composerMarkers, ["example", "core", "bundle", "example", "core", "bundle"]);
  assert.deepEqual(new Set(composerManifests), new Set([
    '{"name":"gauntlet/release-security-audit","type":"metapackage","config":{"allow-plugins":false}}\n',
  ]));
});

test("release security rejects an unpinned package manager before invoking the audit", async (t) => {
  const files = fixture(t);
  const paths = completeRepository(files);
  files.write("package.json", '{"name":"fixture","private":true,"packageManager":"pnpm@11.24.1"}\n');
  const calls = [];
  const run = async (request) => {
    calls.push(request);
    if (request.command === "git") return gitResponse(request, files.root, paths);
    return {
      status: 0,
      signal: null,
      stdout: Buffer.from('{"advisories":{},"metadata":{"vulnerabilities":{}}}'),
      stderr: Buffer.alloc(0),
    };
  };

  await assert.rejects(
    security.runReleaseSecurity({
      root: files.root,
      outputDirectory: resolve(files.root, ".artifacts/security"),
      environment: { PATH: "/usr/bin:/bin" },
      run,
      mode: "source-only",
    }),
    { message: "Release security gate failed closed" },
  );
  assert.equal(calls.filter(({ command }) => command === "git").length, 3);
  assert.equal(calls.some(({ command }) => command === "pnpm" || command === "docker"), false);
});

test("release security rejects stale unowned report names and leaves a failed summary", async (t) => {
  const files = fixture(t);
  const outputDirectory = resolve(files.root, ".artifacts/security");
  mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  files.write(".artifacts/security/trivy.json", '{"status":"verified"}\n');
  files.write(".artifacts/security/summary.json", '{"ok":true}\n');
  let called = false;

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run: async () => {
      called = true;
      throw new Error("must not run");
    },
    mode: "source-only",
  }), { message: "Release security gate failed closed" });

  assert.equal(called, false);
  assert.equal(JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8")).ok, false);
  assert.equal(readFileSync(resolve(outputDirectory, "trivy.json"), "utf8").includes("verified"), true);
});

test("release security invalidates stale success before any report validation can fail", async (t) => {
  const files = fixture(t);
  const outputDirectory = resolve(files.root, ".artifacts/security");
  mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  writeFileSync(resolve(outputDirectory, "summary.json"), '{"ok":true}\n', { mode: 0o600 });
  mkdirSync(resolve(outputDirectory, ".composer-audit.json.tmp"), { mode: 0o700 });
  let called = false;

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run: async () => {
      called = true;
      throw new Error("must not run");
    },
    mode: "source-only",
  }), { message: "Release security gate failed closed" });

  assert.equal(called, false);
  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  assert.equal(summary.mode, "source-only");
  assert.equal(summary.ok, false);
  assert.equal(summary.sourceChecksOk, false);
});

test("a failed rerun replaces stale success reports without exposing the credential", async (t) => {
  const files = fixture(t);
  const sentinel = "rerun-credential-secret-602418";
  const paths = [
    ...completeRepository(files),
    files.write("config/runtime.env", "SAFE=true\n"),
  ];
  const calls = [];
  const run = async ({ args, command, ...request }) => {
    calls.push({ args, command, ...request });
    if (command === "git") return gitResponse({ args }, files.root, paths);
    if (command === "pnpm") return cleanPnpmAudit();
    if (command === "docker" && args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem");
    }
    if (command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");
  const options = {
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run,
    mode: "source-only",
  };
  await security.runReleaseSecurity(options);
  files.write("config/runtime.env", `ADMIN_PASSWORD=${sentinel}\n`);

  await assert.rejects(security.runReleaseSecurity(options), { message: "Release security gate failed closed" });

  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  const audit = JSON.parse(readFileSync(resolve(outputDirectory, "pnpm-audit.json"), "utf8"));
  const credentials = JSON.parse(readFileSync(resolve(outputDirectory, "credential-material.json"), "utf8"));
  assert.equal(summary.mode, "source-only");
  assert.equal(summary.sourceChecksOk, false);
  assert.equal(summary.ok, false);
  const checks = new Map(summary.checks.map((check) => [check.name, check]));
  assert.deepEqual(checks.get("credential-material"), {
    name: "credential-material", required: true, status: "failed",
  });
  assert.equal(checks.get("pnpm-audit").reason, "repository-static-failed");
  assert.equal(checks.get("composer-audit").reason, "repository-static-failed");
  assert.equal(checks.get("trivy-filesystem").reason, "repository-static-failed");
  assert.deepEqual(audit, {
    schemaVersion: 1,
    scanner: "pnpm-audit",
    scope: "production",
    status: "not-run",
    reason: "repository-static-failed",
    ok: false,
  });
  assert.deepEqual(credentials.findings, [
    { line: 1, path: "config/runtime.env", rule: "literal-credential" },
  ]);
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
  assert.equal(calls.filter(({ command }) => command === "pnpm").length, 1);
  assert.equal(calls.filter(({ command }) => command === "docker").length, 4);
});

test("a missing mandatory pnpm audit tool fails closed and invalidates its previous report", async (t) => {
  const files = fixture(t);
  const sentinel = "missing-audit-tool-secret-290145";
  const paths = completeRepository(files);
  let failAudit = false;
  const run = async ({ args, command }) => {
    if (command === "git") return gitResponse({ args }, files.root, paths);
    if (command === "pnpm") {
      if (failAudit) throw new Error(sentinel);
      return cleanPnpmAudit();
    }
    if (command === "docker" && args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem");
    }
    if (command === "docker") return cleanComposerAudit();
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");
  const options = {
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run,
    mode: "source-only",
  };
  await security.runReleaseSecurity(options);
  failAudit = true;

  await assert.rejects(
    security.runReleaseSecurity(options),
    (error) => {
      assert.equal(error.message, "Release security gate failed closed");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );

  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  assert.equal(summary.sourceChecksOk, false);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.checks.find(({ name }) => name === "pnpm-audit"), {
    name: "pnpm-audit", required: true, status: "failed",
  });
  assert.deepEqual(summary.checks.find(({ name }) => name === "trivy-filesystem"), {
    name: "trivy-filesystem", required: true, status: "passed",
  });
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "pnpm-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "pnpm-audit",
    scope: "production",
    status: "failed",
    reason: "scanner-failed",
    ok: false,
  });
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
});

test("malformed pnpm output is a failed audit and does not suppress Composer or Trivy", async (t) => {
  const files = fixture(t);
  const sentinel = "malformed-pnpm-run-secret-904172";
  const paths = completeRepository(files);
  let composerCalls = 0;
  let trivyCalls = 0;
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") {
      return { status: 0, signal: null, stdout: Buffer.from(`{"error":"${sentinel}"}`), stderr: Buffer.from(sentinel) };
    }
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      trivyCalls += 1;
      return cleanTrivyAudit("filesystem");
    }
    if (request.command === "docker") {
      composerCalls += 1;
      return cleanComposerAudit();
    }
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: process.env.PATH },
    run,
    mode: "source-only",
  }), { message: "Release security gate failed closed" });

  assert.equal(composerCalls, 3);
  assert.equal(trivyCalls, 1);
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "pnpm-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "pnpm-audit",
    scope: "production",
    status: "failed",
    reason: "scanner-failed",
    ok: false,
  });
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
});

test("a missing mandatory Composer audit runtime fails closed and replaces its previous report", async (t) => {
  const files = fixture(t);
  const sentinel = "missing-composer-runtime-secret-610492";
  const paths = completeRepository(files);
  let failComposer = false;
  let composerCalls = 0;
  const run = async ({ args, command }) => {
    if (command === "git") return gitResponse({ args }, files.root, paths);
    if (command === "pnpm") return cleanPnpmAudit();
    if (command === "docker") {
      if (args.some((argument) => argument.includes("aquasec/trivy"))) return cleanTrivyAudit("filesystem");
      composerCalls += 1;
      if (failComposer) throw new Error(sentinel);
      return cleanComposerAudit();
    }
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");
  const options = {
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run,
    mode: "source-only",
  };
  await security.runReleaseSecurity(options);
  failComposer = true;

  await assert.rejects(
    security.runReleaseSecurity(options),
    (error) => {
      assert.equal(error.message, "Release security gate failed closed");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );

  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "composer-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "composer-audit",
    scope: "all-locked-dependencies",
    status: "failed",
    reason: "scanner-failed",
    ok: false,
  });
  const summary = JSON.parse(readFileSync(resolve(outputDirectory, "summary.json"), "utf8"));
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.checks.find(({ name }) => name === "composer-audit"), {
    name: "composer-audit", required: true, status: "failed",
  });
  assert.deepEqual(summary.checks.find(({ name }) => name === "pnpm-audit"), {
    name: "pnpm-audit", required: true, status: "passed",
  });
  assert.equal(composerCalls, 6);
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
});

test("one malformed Composer result cannot prevent the other lockfiles or Trivy from being audited", async (t) => {
  const files = fixture(t);
  const sentinel = "malformed-composer-run-secret-193684";
  const paths = completeRepository(files);
  let composerCalls = 0;
  let trivyCalls = 0;
  const run = async (request) => {
    if (request.command === "git") return gitResponse(request, files.root, paths);
    if (request.command === "pnpm") return cleanPnpmAudit();
    if (request.command === "docker" && request.args.some((argument) => argument.includes("aquasec/trivy"))) {
      trivyCalls += 1;
      return cleanTrivyAudit("filesystem");
    }
    if (request.command === "docker") {
      composerCalls += 1;
      if (composerCalls === 1) {
        return { status: 0, signal: null, stdout: Buffer.from(`{"diagnostic":"${sentinel}"}`), stderr: Buffer.from(sentinel) };
      }
      return cleanComposerAudit();
    }
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: process.env.PATH },
    run,
    mode: "source-only",
  }), { message: "Release security gate failed closed" });

  assert.equal(composerCalls, 3);
  assert.equal(trivyCalls, 1);
  assert.deepEqual(JSON.parse(readFileSync(resolve(outputDirectory, "composer-audit.json"), "utf8")), {
    schemaVersion: 1,
    scanner: "composer-audit",
    scope: "all-locked-dependencies",
    status: "failed",
    reason: "scanner-failed",
    ok: false,
  });
  for (const name of readdirSync(outputDirectory)) {
    assert.equal(readFileSync(resolve(outputDirectory, name), "utf8").includes(sentinel), false, name);
  }
});

test("Composer vulnerabilities fail the gate after all three lockfiles are audited", async (t) => {
  const files = fixture(t);
  const sentinel = "composer-vulnerability-secret-993401";
  const paths = completeRepository(files);
  let composerCalls = 0;
  const run = async ({ args, command }) => {
    if (command === "git") return gitResponse({ args }, files.root, paths);
    if (command === "pnpm") return cleanPnpmAudit();
    if (command === "docker") {
      if (args.some((argument) => argument.includes("aquasec/trivy"))) return cleanTrivyAudit("filesystem");
      composerCalls += 1;
      if (composerCalls !== 2) return cleanComposerAudit();
      return {
        status: 1,
        signal: null,
        stdout: Buffer.from(JSON.stringify({
          advisories: {
            "vendor/package": [{
              advisoryId: "PKSA-2345-6789-cfgh",
              packageName: "vendor/package",
              affectedVersions: "<2.0.0",
              title: sentinel,
              cve: null,
              link: null,
              reportedAt: "2026-01-01T00:00:00+00:00",
              sources: [{ name: "Packagist", remoteId: sentinel }],
              severity: "critical",
            }],
          },
          abandoned: [],
          filter: [],
        })),
        stderr: Buffer.from(sentinel),
      };
    }
    throw new Error("unexpected command");
  };
  const outputDirectory = resolve(files.root, ".artifacts/security");

  await assert.rejects(security.runReleaseSecurity({
    root: files.root,
    outputDirectory,
    environment: { PATH: "/usr/bin:/bin" },
    run,
    mode: "source-only",
  }), { message: "Release security gate failed closed" });

  const report = JSON.parse(readFileSync(resolve(outputDirectory, "composer-audit.json"), "utf8"));
  assert.equal(composerCalls, 3);
  assert.equal(report.auditedLockfiles.length, 3);
  assert.equal(report.advisoryCount, 1);
  assert.equal(report.blockingCount, 1);
  assert.equal(report.ok, false);
  assert.deepEqual(report.auditedLockfiles[1].vulnerabilities, [
    { id: "PKSA-2345-6789-cfgh", package: "vendor/package", severity: "critical" },
  ]);
  assert.equal(JSON.stringify(report).includes(sentinel), false);
});

test("the process runner returns bounded bytes and redacts launch failures", async (t) => {
  const files = fixture(t);
  const runner = security.createSecurityProcessRunner({ maximumOutputBytes: 64, terminationGraceMs: 50 });
  const environment = { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C" };
  const result = await runner({
    command: process.execPath,
    args: ["-e", "process.stdout.write('audit-ok')"],
    environment,
    timeoutMs: 1_000,
    workingDirectory: files.root,
  });
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.deepEqual(result.stdout, Buffer.from("audit-ok"));
  assert.deepEqual(result.stderr, Buffer.alloc(0));

  const sentinel = "missing-tool-secret-420719";
  await assert.rejects(
    runner({
      command: resolve(files.root, sentinel),
      args: [],
      environment,
      timeoutMs: 1_000,
      workingDirectory: files.root,
    }),
    (error) => {
      assert.equal(error.message, "Release security command failed safely");
      assert.equal(error.message.includes(sentinel), false);
      return true;
    },
  );
});

test("the process runner fails closed on oversized output and timeout", async (t) => {
  const files = fixture(t);
  const runner = security.createSecurityProcessRunner({ maximumOutputBytes: 32, terminationGraceMs: 20 });
  const request = {
    command: process.execPath,
    environment: { PATH: process.env.PATH, LANG: "C" },
    workingDirectory: files.root,
  };
  await assert.rejects(runner({
    ...request,
    args: ["-e", "process.stdout.write('x'.repeat(64))"],
    timeoutMs: 1_000,
  }), { message: "Release security command failed safely" });
  await assert.rejects(runner({
    ...request,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 20,
  }), { message: "Release security command failed safely" });
});

test("the security CLI rejects every argument without starting a command", async () => {
  let called = false;
  const result = await security.runSecurityCli(["--publish"], {
    root: "/repository",
    outputDirectory: "/repository/.artifacts/security",
    environment: { PATH: "/usr/bin:/bin" },
    run: async () => {
      called = true;
      throw new Error("must not run");
    },
  });

  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "",
    stderr: '{"error":{"code":"INVALID_ARGUMENTS","message":"Usage: security.mjs [--source-only | --image-archive <path>]"},"ok":false}\n',
  });
  assert.equal(called, false);
});

test("the security CLI emits one bounded JSON result and redacts command diagnostics", async (t) => {
  const files = fixture(t);
  const sentinel = "cli-command-secret-718340";
  const paths = completeRepository(files);
  const run = async ({ args, command }) => {
    if (command === "git") return gitResponse({ args }, files.root, paths);
    if (command === "pnpm") return cleanPnpmAudit(Buffer.from(sentinel));
    if (command === "docker" && args.some((argument) => argument.includes("aquasec/trivy"))) {
      return cleanTrivyAudit("filesystem", Buffer.from(sentinel));
    }
    if (command === "docker") return cleanComposerAudit(Buffer.from(sentinel));
    throw new Error("unexpected command");
  };

  const result = await security.runSecurityCli(["--source-only"], {
    root: files.root,
    outputDirectory: resolve(files.root, ".artifacts/security"),
    environment: { PATH: "/usr/bin:/bin", GH_TOKEN: sentinel },
    run,
  });

  const parsed = JSON.parse(result.stdout);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${JSON.stringify(parsed)}\n`);
  assert.deepEqual(parsed.checks.slice(-2), [
    { name: "trivy-filesystem", required: true, status: "passed" },
    { name: "trivy-image", required: false, status: "not-run", reason: "excluded-by-source-only-mode" },
  ]);
  assert.equal(parsed.sourceChecksOk, true);
  assert.equal(parsed.ok, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("the executable security entry point exposes only the closed CLI", () => {
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../security.mjs"), "--publish"], {
    cwd: resolve(import.meta.dirname, "../../.."),
    encoding: "utf8",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    timeout: 5_000,
  });

  assert.equal(result.status, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, '{"error":{"code":"INVALID_ARGUMENTS","message":"Usage: security.mjs [--source-only | --image-archive <path>]"},"ok":false}\n');
});
