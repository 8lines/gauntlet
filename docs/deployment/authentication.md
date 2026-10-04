# Authentication

Gauntlet can require a password before anyone uses the dashboard, the widget
panel, the REST API or the MCP endpoint. Authentication is off unless the
configuration turns it on, so existing installations behave as before.

Authentication narrows who can reach Gauntlet inside your network. It does not
replace the private boundary: keep Gauntlet and every adapter on private
addresses, as the [decision guide](decision-guide.md) describes.

## Modes

| `auth.mode` | Who signs in | Recorded run actor |
| --- | --- | --- |
| `none` (default) | Nobody; every caller that reaches Gauntlet can use it. | The actor the caller declares, if any. |
| `password` with `shared` | Everyone uses one instance password. | `shared` |
| `password` with `users` | Each person has a username and password. | `user:<username>` |

Static API tokens (`auth.tokens`) work in password mode for callers without a
browser, such as CI jobs, scripts and MCP clients. Their runs record
`token:<name>`.

Every signed-in principal can use every target and operation. Gauntlet has no
roles; keep authorization and domain rules in the application.

## Turn it on

1. Generate the signing secret and keep it out of the configuration file:

   ```sh
   node dist/auth-cli.js generate-secret
   ```

   Set it as `GAUNTLET_AUTH_SECRET` (hex or base64url, at least 32 bytes).
   Gauntlet refuses to start in password mode without it.

2. Hash each password. The command reads the password from standard input and
   prints only the hash:

   ```sh
   node dist/auth-cli.js hash-password
   ```

3. Add the `auth` section to the configuration:

   ```yaml
   auth:
     mode: password
     publicUrl: https://gauntlet.qa.internal
     sessionTtl: 12h
     password:
       users:
         - username: anna
           hash: "scrypt$16384$8$1$..."
     tokens:
       - name: ci-nightly
         hash: "sha256$..."
   ```

   Use `password.shared.hash` instead of `password.users` for one shared
   password; the two are exclusive. `publicUrl` is the origin users open
   Gauntlet at, without a path. Gauntlet uses it to accept browser requests
   from its own pages only, and sets `Secure` cookies when it is `https`.
   `sessionTtl` is between `5m` and `30d`, `12h` by default.

4. Restart Gauntlet. `/health` and `/ready` stay open for probes.

With Docker Compose, run the commands inside the image, for example
`./gauntlet run --rm --no-deps gauntlet node dist/auth-cli.js generate-secret`,
and set `GAUNTLET_AUTH_SECRET` in the installation's `.env`. The Helm chart
does not pass `GAUNTLET_AUTH_SECRET` yet, so password mode is not available
through Helm in this release.

## API tokens

```sh
node dist/auth-cli.js create-token ci-nightly
```

prints the token once and the `auth.tokens` entry with its hash. Send the token
as `Authorization: Bearer gat_...`. Tokens do not expire; remove the entry to
revoke one. MCP clients that support custom headers use the same header:

```json
{ "mcpServers": { "gauntlet": { "url": "https://gauntlet.qa.internal/mcp", "headers": { "Authorization": "Bearer gat_..." } } } }
```

Signing in to MCP through the browser (OAuth) is not available yet.

## Sessions

- The dashboard keeps its session in an `HttpOnly`, `SameSite=Lax` cookie.
- The widget panel runs in a frame of another site. Over HTTPS it uses a
  partitioned `SameSite=None` cookie. When the browser refuses that cookie
  (plain HTTP, or browsers that block it), the panel keeps the session token in
  its own storage and sends it as a bearer credential. Either way the host
  application never sees it, and a tester signs in once per application.
- Sessions last `sessionTtl` and are not extended. Logging out clears the
  cookie and the panel's token; a token already copied elsewhere stays valid
  until it expires.
- Changing a user's password, removing the user, or switching between `shared`
  and `users` signs that principal out everywhere. Rotating
  `GAUNTLET_AUTH_SECRET` signs everyone out.
- After ten failed sign-ins within five minutes for one username (or the
  shared password) from one address, that address cannot sign in as that user
  for the rest of the window; other users and addresses are not affected.
  Behind a reverse proxy every request comes from the proxy's address, so the
  limit then applies per username, and repeated failures can lock that username
  out for five minutes.

[Documentation index](../README.md)
