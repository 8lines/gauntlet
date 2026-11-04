---
type: changed
units:
  java-core: minor
  spring-boot-starter: minor
  skills: patch
upgrade: required
---
The Java packages moved to Maven Central under the group `dev.8lines.gauntlet`, so they need no token and no extra repository.

## Upgrade

Change the dependency group from `dev.eightlines.gauntlet` to
`dev.8lines.gauntlet`. The Java package names stay `dev.eightlines.gauntlet`, so
no import changes.

Remove the `https://maven.pkg.github.com/8lines/gauntlet` repository and its
credentials from the build. `mavenCentral()` is enough.
