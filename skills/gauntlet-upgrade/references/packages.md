# Source checkouts and application packages

## Application SDK packages

Application adapters use released packages: npm `@8lines/gauntlet-*`, Composer `8lines/gauntlet-*`, and Maven `dev.eightlines.gauntlet:*`. Each package is its own release unit with its own guides at `docs/upgrades/<unit>/` and tags `<unit>-v<version>`.

- Read the deployed package version from the application's lockfile, not from a manifest range.
- Walk the package unit's guides exactly like the `gauntlet` unit's.
- Upgrade the SDK first when a guide or the compatibility notes require it: change the application's dependency to the exact target version with its own package manager, run the framework tests and live conformance against the private adapter, and only then upgrade the control plane.
- Pin exact versions in the application manifest and commit the lockfile. Never copy package source from the Gauntlet monorepo into the application.
- An SDK upgrade is an application release. Follow the application's own deployment and database compatibility policy, and keep its adapter disabled if the final combination fails conformance.

## Source checkouts

A source checkout runs the server from the repository. Its deployed version is the tag the running checkout was built from.

- Back up the operator's configuration file, environment, and `GAUNTLET_DATA_DIR` before switching.
- Check out the exact target tag (`v<target>`), never a branch, and reinstall with the frozen lockfile before building.
- Apply each guide step to the environment variables or configuration file the server actually reads.
- Keep the listener on loopback or a reviewed private interface and keep one process.
