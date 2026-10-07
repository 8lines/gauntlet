---
type: added
units:
  gauntlet: patch
upgrade: optional
---
You can pin the operations you use often so they appear in a Pinned section at the top of the dashboard sidebar and the widget, stored per user and target in Gauntlet's SQLite database under `GAUNTLET_DATA_DIR` (in memory when it is not set).

## Upgrade

Pins work without any change: with `GAUNTLET_DATA_DIR` unset, Gauntlet keeps
its SQLite database in memory, pins are lost on every restart and startup logs
a `GAUNTLET_DATA_EPHEMERAL` warning.

To keep pins across restarts, give Gauntlet a persistent directory:

- Helm: set `persistence.enabled: true` in the values file. The chart creates a
  `ReadWriteOnce` PersistentVolumeClaim (`persistence.size`, default `1Gi`;
  `persistence.storageClass`, default the cluster default), or mounts
  `persistence.existingClaim`, at `/var/lib/gauntlet` and sets
  `GAUNTLET_DATA_DIR=/var/lib/gauntlet`. Keep `replicaCount: 1`: the volume is
  `ReadWriteOnce` and the deployment strategy stays `Recreate`.
- Source or a custom container: set `GAUNTLET_DATA_DIR` to an existing
  directory writable by the server user (UID 1000 in the image). A missing or
  read-only directory fails startup. The database file is `gauntlet.sqlite`.
- Compose: the distribution does not set `GAUNTLET_DATA_DIR`; pins stay in
  memory.

The database holds only pins, no credentials. Nothing needs to be migrated by
hand; Gauntlet creates and migrates the database at startup.
