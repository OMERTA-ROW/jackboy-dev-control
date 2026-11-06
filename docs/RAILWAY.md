# Railway production startup

## Finding

The default `bun run build` uses the Lovable Vite wrapper's Cloudflare fallback.
On the inspected base `057c6afbef27f74a3f7df44b0c00a578835b072d` it emits
`.output/server/index.mjs`, but `.output/nitro.json` identifies the preset as
`cloudflare-module`. That entry exports a Worker fetch handler; it does not
start a Node HTTP server. Locally, `node .output/server/index.mjs` exits **0**
with no output or listening socket. Artifact existence alone is not sufficient.

The repository previously had no `start` script, Dockerfile, Railway/Nixpacks
configuration or Procfile. A build command can finish successfully without
starting a service. Running the Worker entry directly also explains a clean,
immediate exit and no application logs. These are reproduced repository failure
modes, not a claim about the inaccessible Railway deployment's actual settings.
Inspect its effective start command, process exit code and restart history.

## Minimal reviewed configuration (do not deploy as part of this repair)

Use the repository root and its committed Bun lockfile:

| Railway setting              | Value                                                            |
| ---------------------------- | ---------------------------------------------------------------- |
| Install                      | `bun install --frozen-lockfile` (include build/dev dependencies) |
| Build command                | `bun run build:railway`                                          |
| Start command                | `bun run start`                                                  |
| Equivalent direct start      | `NITRO_HOST=0.0.0.0 node .output/server/index.mjs`               |
| Runtime mode                 | `NODE_ENV=production`                                            |
| Port                         | Railway's supplied `PORT`; do not hardcode a different port      |
| Optional startup healthcheck | `/favicon.ico` (listener/static readiness only)                  |

`build:railway` selects Nitro's `node-server` preset **at build time** using
`NITRO_PRESET`; changing it only at runtime cannot convert a Worker artifact.
`start` binds all IPv4 interfaces, not loopback, and Nitro reads Railway's `PORT`.
Use an ordinary long-running web service, not a scheduled/one-shot service.
Railway terminates public TLS; do not set Nitro's development TLS/socket options.
Keep both `.output/server` and `.output/public` in the runtime image.

Do not set a conflicting `NITRO_PORT` (it takes precedence over `PORT`), an
`NITRO_UNIX_SOCKET`, or a conflicting service-domain target port. The installed
Lovable wrapper ignores `NITRO_PRESET` when `LOVABLE_SANDBOX=1` or
`DEV_SERVER__PROJECT_PATH` is present: these Lovable-only build markers must
not be copied into Railway. Check the generated metadata before publication.
Use a supported Node version for the locked Vite/runtime dependencies; CI
exercises this project with Node 24/26. This fix does not enable the separate
Node 26 OMNI bridge.

Default `build`, `dev` and `preview` remain unchanged for Lovable. Do not use
`vite dev`, `vite preview` or `scripts/omni-link-server.mjs` as the production
application start command. No deployment-specific config file or production
variables/secrets are changed by this PR; set the commands above in the reviewed
Railway service configuration when deployment is separately authorized.

## Local verification

```sh
bun install --frozen-lockfile
bun run test:railway
```

This builds the Node artifact and checks preset/entry metadata, a sustained
listener on an ephemeral `PORT`, actual favicon bytes, an HTML homepage, unauthenticated owner
manifest rejection (401), and disabled OMNI Link rejection (503), then terminates
the local process. No production credentials, database, provider calls or OMNI
enablement are required. `Verify` runs it after the unchanged default build.

For manual inspection, after building:

```sh
cat .output/nitro.json
NODE_ENV=production PORT=8080 bun run start
# In a second terminal:
curl --fail http://127.0.0.1:8080/favicon.ico -o /dev/null
curl -i http://127.0.0.1:8080/api/agent/manifest
```

Expect a listener message, HTTP 200 for the asset, and HTTP 401 without owner
sign-in. Stop the local process after inspection. A static healthcheck does not
prove authenticated database access, audit logging, deployment SHA, spending
safety or production readiness. If the listener remains alive but Railway has
no traffic metrics, verify the service's domain/target port and actual requests.
If it exits nonzero, inspect the first exception for missing artifacts, invalid
runtime configuration, unsupported Node or import errors rather than masking it
with a keepalive loop. Enable no schedules, autonomous CODE or OMNI flags.

References: [Railway start commands](https://docs.railway.com/deployments/start-command)
and [Nitro Node deployment](https://nitro.build/deploy/runtimes/node). The installed
Lovable wrapper and generated output, rather than artifact names alone, were
used to verify the two build targets.
