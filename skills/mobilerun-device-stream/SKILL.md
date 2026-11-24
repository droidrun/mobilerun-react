---
name: mobilerun-device-stream
description: Use when integrating a live Mobilerun device into a React partner app with server-minted stream tokens, reconnect handling, labels and theming.
---

# Mobilerun device stream for React

## When to use

Use `@mobilerun/react` to embed live WebRTC video and device control in a React 18 or 19 app.
Install `@mobilerun/react`, its peer `@mobilerun/sdk`, `react` and `react-dom`.
Use a browser with WebRTC. Keep device authorization and token minting on your backend.

## Backend: mint one token per connect

Call `POST https://api.mobilerun.ai/v1/identity/stream-keys` with the server's API key from
`MOBILERUN_API_KEY`. The body is `{ deviceId, ttlSeconds, allowedOrigins? }` and the response is
`{ key, keyId, expiresAt }` (HTTP 201). `ttlSeconds` defaults to 120 seconds (range 60–300).
Tokens start with `dr_st_`; `dr_sk_` can appear during the prefix transition. Treat both as opaque.
Each token is single-use. `allowedOrigins` binds browser use to the listed sites, for example
`['https://partner.example']`; configure the list on the server.

The following server-only helper uses `MobilerunSDK` from `@mobilerun/sdk` 6.2+.
Register it behind your application's authenticated
`POST /api/v1/devices/:id/stream-key` route. **Before calling it, authorize the caller for that
device.** This helper is not an authentication implementation.

```ts
import { MobilerunSDK } from '@mobilerun/sdk';

const sdk = new MobilerunSDK({ logLevel: 'off' }); // reads MOBILERUN_API_KEY on the server

export async function mintStreamToken(deviceId: string): Promise<Response> {
  const { key, keyId, expiresAt } = await sdk.api.post<{
    key: string; keyId: string; expiresAt: string;
  }>('/identity/stream-keys', {
    body: {
      deviceId,
      ttlSeconds: 120,
      allowedOrigins: ['https://partner.example'], // replace with your browser app's origin
    },
    maxRetries: 0,
  });
  return Response.json({ key, keyId, expiresAt }, {
    status: 201,
    headers: { 'Cache-Control': 'no-store' },
  });
}
```

The SDK base URL already includes `/v1`; pass `/identity/stream-keys` to `sdk.api.post`.
The route and response fields still use the transitional `stream-keys`, `key` and `keyId` names.
Handle mint errors in your route without exposing upstream credential details.

## Client: a fresh token for every connection

Supply the device's `streamUrl` obtained through your authorized backend. Its usual form is
`wss://api.mobilerun.ai/v1/devices/{deviceId}/stream`; the component appends `?token=` itself.
The application route below is your own backend route, not a React SDK endpoint.

```tsx
'use client';

import { useCallback } from 'react';
import { DeviceStream } from '@mobilerun/react';
import '@mobilerun/react/styles.css';

export function DevicePanel({ deviceId, streamUrl }: {
  deviceId: string;
  streamUrl: string;
}) {
  const tokenProvider = useCallback(async (): Promise<string> => {
    const res = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/stream-key`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Stream token request failed');
    const { key } = await res.json();
    if (typeof key !== 'string' || !key) throw new Error('Missing stream token');
    return key;
  }, [deviceId]);

  return (
    <div style={{ width: 360, height: 780 }}>
      <DeviceStream
        streamUrl={streamUrl}
        tokenProvider={tokenProvider}
        hasControl
        onError={({ reason, message, attempt, final }) => {
          // Fixed SDK text; never include tokens or connection URLs in diagnostics.
          console.warn('Device stream', { reason, message, attempt, final });
        }}
        labels={{ connecting: 'Starting…', disconnected: 'Reconnecting',
          unavailable: 'Phone unavailable', retry: 'Try again' }}
      />
    </div>
  );
}
```

`tokenProvider: () => Promise<string>` runs before every WebSocket connect attempt, including
reconnects. Never cache, memoize the returned token, or reuse it; memoizing the callback is fine.
A throw, rejection, empty result or 10-second timeout fails the attempt and uses normal backoff.
If both credentials are supplied, `tokenProvider` wins without falling back to `streamToken`.
The component handles bounded retries; do not mint through `onStreamHealed`, which is not per attempt.
While offline, automatic attempts pause; the Retry button can request a fresh attempt.

## Errors and recovery

`onError` receives the exported `StreamError` shape `{ reason, message, attempt, final }`.
`message` is fixed SDK text; `attempt` counts consecutive failures from 1.
`final: true` means automatic retries stopped; keep the component's Retry button available.

| `reason` (`StreamErrorReason`) | Meaning and action |
| --- | --- |
| `credentials_unavailable` | Provider threw, rejected, returned an empty token or exceeded 10 s. Check your backend route, caller session and mint response; let normal backoff run. |
| `connection_refused` | Socket closed before opening. Check fresh minting, device ID, expiry, revocation and allowed origin. React cannot inspect the upgrade HTTP status, so it does not report `token_rejected`. |
| `disconnected` | An open session dropped, including the 30-minute server session cap. Let the SDK reconnect with a newly minted token; check network/device state if persistent. |
| `device_unavailable` | Reserved for a server report of an offline/not-ready device. The current signaling protocol has no such message, so React does not emit it yet. Fetch device state through your backend when diagnosing availability. |
| `unknown` | Other failure, such as a handshake timeout. Check connectivity and device state, then retry. |

## Labels and theming

`labels?: Partial<DeviceStreamLabels>` accepts the following connection keys and the publish keys below, all optional:

| Key | English default |
| --- | --- |
| `connecting` | `connecting` |
| `disconnected` | `reconnecting` (retry counters such as ` (1/6)` are appended) |
| `unavailable` | `device stream unavailable` |
| `retry` | `Retry` |

`placeholderLabel` overrides `connecting` while waiting for a URL/connection; the reconnect label
takes precedence after a drop. Use `className` on `DeviceStream` for host styling and a parent with
explicit dimensions. Import `@mobilerun/react/styles.css` once.

Set variables on `.mobilerun-device-stream` or an ancestor:
`--mr-background`, `--mr-foreground`, `--mr-card`, `--mr-card-foreground`, `--mr-muted`,
`--mr-muted-foreground`, `--mr-border`, `--mr-ring`, `--mr-primary`, `--mr-primary-foreground`,
`--mr-accent`, `--mr-accent-foreground`, `--mr-destructive`.

```css
.mobilerun-device-stream {
  --mr-primary: oklch(0.55 0.18 268);
  --mr-primary-foreground: white;
  --mr-background: oklch(0.985 0.004 85);
}
```

Add `.dark` on an ancestor or the root for bundled dark defaults. Colors resolve from `--mr-*`,
then legacy unprefixed variables (supported for one more minor release), then bundled defaults.
The package does not define generic variables on `:root`. Keep retry text/button contrast at WCAG AA.

## Microphone and camera publishing

Get the specific device's `GET /v1/devices/{deviceId}/capabilities` response through the authorized
backend and pass its `.capabilities` as `publishCapabilities`. A stream token cannot call that API.
`microphoneInjection: true` and `mediaInjectionTransport: 'direct'` enable the floating publish pill;
camera additionally requires `cameraInjection: true` and a compatible local H.264 encoder.
Capabilities describe support; the server decides admission on every start, independently of `hasControl`.

Use a `DeviceStreamHandle` ref for `startPublish({ audio: true, video?: boolean })`,
`stopPublish()` and `getPublishState()`. Start resolves only after server `active` and successful
track attachment. Audio is required. To change camera mode, stop then start. Set
`hidePublishControls` to use your own controls. Observe `onPublishStateChange` separately from
connection state; `onError` publish events have `operation: 'publish'`, the viewer attempt index,
`final: true`, and optional `mediaSessionId`, `detail`, `serverReason`. Handle rejected starts with
`PublishError.reason`. `forbidden` → `publish_not_allowed`; silence after 5 s →
`publish_unsupported`; acceptance without active after 15 s → `publish_timeout`. There is no retry.

Use HTTPS (or localhost), permit microphone/camera in Permissions Policy and set iframe
`allow="microphone; camera"` when embedding. Capture only starts on explicit action and is stopped
on stop, pagehide, disconnection or unmount. Reconnect never resumes it. Receiving audio mute
is independent. Capability changes require a new viewer connection and fresh token (remount the
component with a new `key`). No privileged API key belongs in the browser.

Publish labels and English defaults: `publishMicrophone` (“Microphone”), `publishCamera` (“Camera”),
`publishStarting` (“Starting inputs”), `publishPermissionDenied` (“Microphone or camera permission denied”),
`publishNotAllowed` (“Publishing is not allowed”), `publishFailed` (“Unable to publish inputs”).
Style the pill with existing card/border tokens and `--mr-publish-live` / `--mr-publish-live-foreground`.
See [Publishing inputs](../../docs/publish.md) for the full API and failure details.

## Security rules

- Never ship `MOBILERUN_API_KEY` to a client or use it as a stream credential.
- Authenticate callers and authorize the device before minting or returning device metadata.
  Use a server-configured API target and origin list, never an arbitrary browser-provided upstream URL.
- A stream token grants view and control of one device. It can be redeemed until first connect or
  expiry; consuming it does not end the admitted session when the mint TTL elapses.
  `hasControl={false}` is only a UI input overlay, not a server-enforced view-only permission.
- Never log tokens, store them in local storage, cache mint responses or expose `?token=` URLs in logs.
  `expiresAt` is metadata, not a client-side authorization check.
- Static `streamToken` is deprecated, only for existing integrations until retired. It warns once
  per mount and reuses the same value on reconnect. A single-use token passed statically fails on
  reuse; migrate to `tokenProvider`.

## Troubleshooting

- **401 at connect:** the token may be used, expired, revoked or bound to the wrong origin/device.
  Mint a new token for every attempt and check the server-configured `allowedOrigins` against the
  browser origin. React surfaces this as `connection_refused`, not an HTTP status.
- **422 on mint:** read the response's `issues` on the server; correct the invalid request fields
  (including TTL/origin format) before retrying. Do not expose credential details to the browser.
- **Provider failures:** check the same-origin backend route, application authentication, response
  status and nonempty `key`; keep it within 10 seconds. Never return a previously minted token as
  a fallback. Look for `credentials_unavailable` and `final` in `onError`.

For full route/hook examples see [Stream tokens](../../docs/stream-tokens.md);
for styling see [Components and styling](../../docs/default-ui.md).
