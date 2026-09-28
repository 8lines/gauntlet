# Gauntlet dashboard client

`@8lines/gauntlet-dashboard-client` is the validated server-to-adapter HTTP
and Server-Sent Events client used by the Gauntlet control plane. It validates
Adapter v1 responses before they reach control-plane code and exposes run-event
streaming primitives.

This package is server-side infrastructure. Do not import it into browser code
and do not use it to bypass the control plane or expose an adapter directly to a
public frontend.

[Documentation index](../../docs/README.md)
