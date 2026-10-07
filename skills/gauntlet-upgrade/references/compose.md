# Docker Compose upgrades

The supported Compose distribution is the `gauntlet` wrapper directory. Its operator-owned files are the installed `.env` (mode `0600`) and `config.yaml` (or the file `GAUNTLET_CONFIG_PATH` selects). The wrapper pins the project, environment file, and base model; never replace them with your own Compose file or an override.

## Before the change

- Read the deployed version from `GAUNTLET_IMAGE` in `.env` and confirm it with `./gauntlet ps` and the running container's image.
- Copy `.env`, the configuration file, and any data directory to the private operator store. When `GAUNTLET_DATA_DIR` is set, the SQLite database `gauntlet.sqlite` lives there (or in the volume mounted there); copy it before the container is recreated and delete nothing. Never commit `.env` or copy its secrets into a repository, ticket, or log.
- Confirm the instance is still non-production and that `GAUNTLET_BIND` is `127.0.0.1` or one reviewed private interface.

## Editing

- Set `GAUNTLET_IMAGE` to the exact target, `ghcr.io/8lines/gauntlet:<target>` or the reviewed `ghcr.io/8lines/gauntlet@sha256:<digest>`. A tag such as `latest` or a minor tag changes what runs without a guide walk and is never acceptable, even to "stay current". A version tag is stable naming; a digest is content-immutable.
- Apply each guide step in the same `.env` or configuration file it names. A renamed variable keeps its value under the new name; remove the old name.
- For an optional new variable, either add it with a value you can justify or leave it unset and record why. Unset keeps the documented default.
- Do not change `GAUNTLET_BIND`, the port, targets, or environment identity unless a guide step requires it.

## Applying

Use the documented sequence from the wrapper directory:

```sh
./gauntlet pull
./gauntlet up -d --wait
./gauntlet ps
```

The service recreates as one container; the short interruption and the loss of in-memory run history are expected. Do not scale the service. After changing only `config.yaml`, `./gauntlet restart` is enough; any `.env` or image change needs `up -d --wait`.

## Rollback

Restore the backed-up `.env` (and configuration file if it changed), then run the same pull and recreate sequence. Rollback restores software and configuration, not in-memory run history. Never remove the data directory, the external `gauntlet` network, or run a daemon-wide prune as part of an upgrade or rollback.
