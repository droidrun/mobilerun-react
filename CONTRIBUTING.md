# Contributing

## Build and test

For source builds: Bun 1.4.4 and TypeScript 6.0.3 (the CI toolchain).

```sh
bun install
bun run build       # tsup (JS + d.ts) + Tailwind (styles.css) → dist/
bun run typecheck
bun test
```

## Conformance

The control messages, signalling frames, reconnect policy and input routing are replayed against the shared [conformance fixtures](https://github.com/droidrun/mobilerun-sdk-conformance) that the native SDKs also pass. The vendored copy lives in `conformance/fixtures` (release tag in `conformance/VERSION`) and runs with `bun test`. To move to another release, run `scripts/sync-conformance.sh TAG`.

## Example app

The repo ships the playground shown in the [README](README.md). Set the API key server-side and enter a device id;
manual URL/token mode remains available for legacy diagnostics:

```sh
bun install
bun run example     # serves the playground at http://localhost:3000
```

In SDK mode the example server returns only `id`, `state`, and `streamUrl` from
`GET /api/v1/devices/:id`. Its `POST /api/v1/devices/:id/stream-key` helper calls the public mint
API through `sdk.api.post('/identity/stream-keys', ...)`, returning only `{ key, keyId, expiresAt }`
with `Cache-Control: no-store`. The browser's provider calls it for each connection attempt; the
API key stays server-side. The stream WebSocket connects directly with the fresh key in `?token=`.
The same server also demonstrates [task approvals](docs/task-approvals.md) (set `MOBILERUN_WEBHOOK_SECRET`
for the webhook route). All example helpers are unauthenticated and **local-only**, bound to
`127.0.0.1`. Before adapting them for production, add application authentication and device
authorization. If you need webhook delivery, expose only `/webhooks/mobilerun`, never the whole server.
The helper routes only answer loopback Host headers and same-origin requests.

## Pull requests

Use commit messages in the form `type(scope): message` and open pull requests against `main`.
Run the build, type check and tests before submitting.

For security reports, follow [SECURITY.md](SECURITY.md).
