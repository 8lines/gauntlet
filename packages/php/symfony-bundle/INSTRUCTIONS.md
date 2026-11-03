## Gauntlet Symfony Bundle

| Instead of...                                          | Use                |
|--------------------------------------------------------|--------------------|
| `bin/console debug:container --tag=gauntlet.operation` | `gauntlet-adapter` |
| `bin/console debug:config gauntlet`                    | `gauntlet-adapter` |

- One call answers "is my operation, feature or data source registered?" and
  "is the adapter enabled here?": features, operations, data sources and
  capability endpoints are grouped with their classes
- Reports `enabled_env` when `gauntlet.enabled` comes from an env var, so check
  that variable rather than the YAML
- Reads the debug container under `var/cache`; when it is missing, run
  `bin/console cache:warmup` and call the tool again
- The idempotency secret is never read
