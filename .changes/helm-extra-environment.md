---
type: added
units:
  gauntlet: patch
upgrade: optional
---
The Helm chart can take the authentication signing secret from an existing Secret with `auth.existingSecret`, accepts `config.auth` for password sign-in, and adds container environment variables with `extraEnv` and `envFrom`.

## Upgrade

Helm only. The new top-level values default to the previous behaviour, so an
existing values file keeps working unchanged:

- `auth.existingSecret` (default `""`): the name of a Secret in the release
  namespace with the key `GAUNTLET_AUTH_SECRET`, generated with
  `node dist/auth-cli.js generate-secret`. The chart reads it with
  `secretKeyRef` and never renders it. Together with `config.auth` (the same
  object as `auth` in the configuration file, for example `mode: password`,
  `publicUrl` and `password.shared.hash`) it enables password sign-in through
  Helm. A render with `config.auth.mode: password` fails when no
  `auth.existingSecret`, `extraEnv` entry named `GAUNTLET_AUTH_SECRET` or
  `envFrom` source can supply the secret.
- `extraEnv` (default `[]`): extra container environment variables, each with
  a `name` and either a literal `value` or a `valueFrom` reference. Names must
  be unique; the variables the chart sets itself, such as `GAUNTLET_HOST` and
  `GAUNTLET_BASE_PATH`, are rejected.
- `envFrom` (default `[]`): Secrets (`secretRef`) or ConfigMaps
  (`configMapRef`) whose keys become environment variables, with an optional
  `prefix`. The chart's own variables take precedence over them.

Create the Secret with the platform's approved secret manager before the
upgrade, for example a Secret named `gauntlet-auth`, and set
`auth.existingSecret: gauntlet-auth`.
