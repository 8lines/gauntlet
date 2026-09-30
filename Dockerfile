# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=docker.io/library/node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json .npmrc ./
COPY apps/dashboard/package.json ./apps/dashboard/
COPY apps/server/package.json ./apps/server/
COPY packages/dashboard-client/package.json ./packages/dashboard-client/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/widget/package.json ./packages/widget/
COPY packages/widget-channel/package.json ./packages/widget-channel/
COPY packages/widget-loader/package.json ./packages/widget-loader/

RUN --mount=type=cache,id=gauntlet-pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter . \
         --filter @8lines/gauntlet-dashboard... \
         --filter @8lines/gauntlet-server... \
         install --frozen-lockfile

COPY apps/dashboard ./apps/dashboard
COPY apps/server ./apps/server
COPY packages/dashboard-client ./packages/dashboard-client
COPY packages/protocol ./packages/protocol
COPY packages/widget ./packages/widget
COPY packages/widget-channel ./packages/widget-channel
COPY packages/widget-loader ./packages/widget-loader

RUN pnpm --filter @8lines/gauntlet-dashboard... \
         --filter @8lines/gauntlet-server... \
         build
RUN pnpm --filter @8lines/gauntlet-server deploy --prod --legacy /out \
    && test -f /out/dist/main.js \
    && test ! -d /out/src \
    && test ! -d /out/test \
    && test ! -e /out/node_modules/typescript \
    && test ! -e /out/node_modules/tsx

RUN node --input-type=module <<'EOF'
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const declarationArtifact = /\.d\.(?:ts|cts|mts)$/;
const executableJavaScript = /\.(?:js|cjs|mjs)$/;
const terminalSourceMapComment = /(?:^|\r?\n)[\t ]*(?:\/\/[#@][\t ]*sourceMappingURL=[^\r\n"'`]*|\/\*[#@][\t ]*sourceMappingURL=[^*\r\n"'`]*\*\/)[\t ]*(?:\r?\n)?$/u;

function stripBuildMetadata(pathname) {
  const metadata = lstatSync(pathname);
  if (metadata.isSymbolicLink()) return;
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(pathname)) stripBuildMetadata(resolve(pathname, entry));
    return;
  }
  if (!metadata.isFile()) return;
  if (pathname.endsWith(".map") || declarationArtifact.test(pathname)) {
    rmSync(pathname);
    return;
  }
  if (!executableJavaScript.test(pathname)) return;
  const source = readFileSync(pathname, "utf8");
  const runtimeSource = source.replace(terminalSourceMapComment, "");
  if (runtimeSource !== source) writeFileSync(pathname, runtimeSource);
}

stripBuildMetadata("/out");
EOF

RUN node --input-type=module <<'EOF'
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

for (const pathname of [
  "/out/dist/main.js",
  "/app/apps/dashboard/dist/index.html",
  "/app/apps/dashboard/dist-widget/index.html",
  "/app/apps/dashboard/dist-widget/loader.js",
]) {
  assert.ok(statSync(pathname).isFile(), pathname);
}

function assertRuntimeArtifact(pathname) {
  const metadata = lstatSync(pathname);
  assert.equal(pathname.endsWith(".map"), false, `${pathname} must not be a source map`);
  assert.equal(/\.d\.(?:ts|cts|mts)$/.test(pathname), false, `${pathname} must not be a declaration`);
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
    for (const entry of readdirSync(pathname)) assertRuntimeArtifact(resolve(pathname, entry));
  } else if (metadata.isFile() && /\.(?:js|cjs|mjs)$/.test(pathname)) {
    assert.equal(readFileSync(pathname, "utf8").includes("sourceMappingURL"), false, pathname);
  }
}
assertRuntimeArtifact("/out");
assertRuntimeArtifact("/app/apps/dashboard/dist");
assertRuntimeArtifact("/app/apps/dashboard/dist-widget");

const dashboardRoot = "/app/apps/dashboard/dist";
const index = readFileSync(`${dashboardRoot}/index.html`, "utf8");
const references = [...index.matchAll(/\b(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
  .map((match) => match[1]);
assert.ok(references.some((reference) => reference.endsWith(".js")), "index.html must reference JavaScript");
assert.ok(references.some((reference) => reference.endsWith(".css")), "index.html must reference CSS");
for (const reference of references) {
  assert.match(reference, /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/);
  const artifact = resolve(dashboardRoot, `.${reference}`);
  assert.ok(artifact.startsWith(`${dashboardRoot}${sep}`), "asset must remain below dashboard root");
  assert.ok(statSync(artifact).isFile(), reference);
}

const widgetRoot = "/app/apps/dashboard/dist-widget";
const widgetIndex = readFileSync(`${widgetRoot}/index.html`, "utf8");
const widgetReferences = [...widgetIndex.matchAll(/\b(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)]
  .map((match) => match[1]);
assert.ok(widgetReferences.some((reference) => reference.endsWith(".js")), "widget index.html must reference JavaScript");
assert.ok(widgetReferences.some((reference) => reference.endsWith(".css")), "widget index.html must reference CSS");
for (const reference of widgetReferences) {
  assert.match(reference, /^\/widget\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:js|css)$/);
  const artifact = resolve(widgetRoot, `.${reference.slice("/widget".length)}`);
  assert.ok(artifact.startsWith(`${widgetRoot}${sep}`), "widget asset must remain below widget root");
  assert.ok(statSync(artifact).isFile(), reference);
}
const widgetAssetHtml = readdirSync(`${widgetRoot}/assets`, { recursive: true })
  .filter((entry) => String(entry).endsWith(".html"));
assert.deepEqual(widgetAssetHtml, [], "dist-widget/assets must not contain HTML");
EOF

RUN chmod -R go-w /out /app/apps/dashboard/dist /app/apps/dashboard/dist-widget

FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache --upgrade \
      libcrypto3=3.5.9-r0 \
      libssl3=3.5.9-r0 \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 \
    && rm -f \
      /usr/local/bin/corepack \
      /usr/local/bin/npm \
      /usr/local/bin/npx \
      /usr/local/bin/pnpm \
      /usr/local/bin/pnpx \
      /usr/local/bin/yarn \
      /usr/local/bin/yarnpkg

ARG GAUNTLET_VERSION
ARG GAUNTLET_REVISION
LABEL org.opencontainers.image.source="https://github.com/8lines/gauntlet" \
      org.opencontainers.image.version="$GAUNTLET_VERSION" \
      org.opencontainers.image.revision="$GAUNTLET_REVISION" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production
ENV GAUNTLET_CONFIG_FILE=/etc/gauntlet/config.yaml
ENV GAUNTLET_DASHBOARD_DIR=/app/dashboard
ENV GAUNTLET_WIDGET_DIR=/app/widget
WORKDIR /app
COPY --from=build /out/ ./
COPY --from=build /app/apps/dashboard/dist ./dashboard
COPY --from=build /app/apps/dashboard/dist-widget ./widget
USER node
EXPOSE 8080
STOPSIGNAL SIGTERM
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS smoke-adapter
ENV NODE_ENV=production
WORKDIR /app
COPY conformance/smoke/fake-adapter.mjs ./conformance/smoke/fake-adapter.mjs
COPY conformance/smoke/manifest.json ./conformance/smoke/manifest.json
COPY packages/protocol/fixtures/v1/health.valid.json ./packages/protocol/fixtures/v1/health.valid.json
USER node
EXPOSE 8081
STOPSIGNAL SIGTERM
CMD ["node", "conformance/smoke/fake-adapter.mjs"]
