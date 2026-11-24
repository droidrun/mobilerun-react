← [README](../README.md) · [Partner guide](https://docs.mobilerun.ai/partners)

# Stream tokens

The object API helpers (`MobilerunSDK`, `devices.fromId`, `verifyWebhook`) require `@mobilerun/sdk` 6.2 or later. The backend stream-token helpers below require `@mobilerun/sdk` 6.3.0 or later on Node. The `{ client, deviceId }` hook form works with older SDKs; the peer dependency range remains `>=2.0.0`.

Keep the API key on your backend. Use `useDeviceStream` for the URL and device state, and supply a
`tokenProvider` that calls your backend for a fresh single-use stream token before every WebSocket
attempt, including retries.

> **`MOBILERUN_API_KEY` is a secret API key — never ship it to the browser.** Only the server reads it.
> The device endpoint returns only `id`, `state`, and `streamUrl`, with missing values set to `null`.
> A separate POST endpoint returns a short-lived stream token scoped to that device; the browser SDK
> uses a placeholder key to call your backend.

On your backend, register this handler for `GET /api/v1/devices/:id`, passing the routed device ID:

```ts
import { MobilerunSDK } from '@mobilerun/sdk';

const client = new MobilerunSDK({ logLevel: 'off' }); // reads MOBILERUN_API_KEY on the Node server

export async function getDevice(id: string): Promise<Response> {
  // Authenticate the caller and check the device belongs to them before returning device metadata.
  const device = await client.devices.get(id);
  return Response.json({
    id: device.info?.id ?? null,
    state: device.info?.state ?? null,
    streamUrl: device.info?.streamUrl ?? null,
  });
}

// Register for POST /api/v1/devices/:id/stream-key.
export async function mintStreamToken(deviceId: string): Promise<Response> {
  // Authenticate the caller and authorize this device in your application first.
  try {
    const { key, keyId, expiresAt } = await client.streamTokens.create({
      deviceId,
      ttlSeconds: 120,
      allowedOrigins: ['https://partner.example'], // replace with your browser app's origin
    }, { maxRetries: 0 });
    return Response.json({ key, keyId, expiresAt }, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    const { status } = err as { status?: number };
    const isUpstreamError = typeof status === 'number' && status >= 400 && status < 600;
    return Response.json({ error: 'stream_key_mint_failed' }, {
      status: isUpstreamError ? status : 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
```

`client.streamTokens.create({ deviceId, ttlSeconds, allowedOrigins })` returns
`{ key, keyId, expiresAt }`. TTL is 60–300 seconds, default 120. Configure `allowedOrigins` on
the server with your browser app's exact origins. Each stream token is single-use and device-scoped.
Revoke it on the server with `await client.streamTokens.delete(keyId)`. `expiresAt` is diagnostic
metadata, not a browser permission or validity check. Do not log or cache stream tokens.

REST fallback: `POST /v1/identity/stream-keys` with the same body, or `DELETE /v1/identity/stream-keys/{keyId}`, authenticated with your server-held API key.

Your backend must authenticate callers and authorize the requested device; never accept an arbitrary
target URL or owner from the browser. Propagate mint refusal without returning upstream credential details.

In your client component, point the SDK at that backend route, as in the example app:

```tsx
'use client';

import { useCallback, useMemo } from 'react';
import { MobilerunSDK } from '@mobilerun/sdk';
import { DeviceStream, useDeviceStream } from '@mobilerun/react';
import '@mobilerun/react/styles.css';

export function DevicePanel({ deviceId }: { deviceId: string }) {
  const sdk = useMemo(() => new MobilerunSDK({
    apiKey: 'example-sdk-helper', // placeholder, not a Mobilerun API key
    baseURL: typeof window === 'undefined' ? '/api/v1' : `${window.location.origin}/api/v1`, // SSR placeholder; the hook only fetches in the browser
  }), []);
  const { streamUrl, state, refetch } = useDeviceStream({
    device: sdk.devices.fromId(deviceId), // no request yet
  });
  const getFreshStreamToken = useCallback(async () => {
    const response = await fetch(`/api/v1/devices/${encodeURIComponent(deviceId)}/stream-key`, {
      method: 'POST',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Stream token request failed');
    const { key } = await response.json();
    return key;
  }, [deviceId]);

  return (
    <div style={{ width: 360, height: 780 }}>
      <DeviceStream
        streamUrl={streamUrl}
        tokenProvider={getFreshStreamToken}
        hasControl
        placeholderLabel={state}
        onStreamHealed={refetch}
      />
    </div>
  );
}
```

### Without the hook

Supply an existing stream URL and the same server-backed callback:

```tsx
<DeviceStream streamUrl={streamUrl} tokenProvider={getFreshStreamToken} hasControl />
```

`tokenProvider?: () => Promise<string>` is supported by `DeviceStream` and `RemoteControl`.
It is awaited once immediately before each socket allocation. It takes precedence over static
`streamToken`/`token`; a rejection or empty stream token fails that attempt with no fallback. Pending results
after stop, device switch or unmount are ignored. Changing callback identity does not reconnect a
healthy stream. An ICE credential refresh on an existing socket does not call it again.
A server signaling close with code 1001 ends media/control in every mode and triggers the existing
bounded reconnect policy. Other signaling closes keep a connected media path running. Provider mode
mints a fresh stream token for each new socket. `onStreamHealed` can refresh URL/state; it is not per retry
and must not be used to cache a stream token.

## Device token (legacy)

Static `DeviceStream.streamToken`, `RemoteControl.token`, and the hook's returned `streamToken` are
**deprecated**, retained for existing consumers. `DeviceStream` logs one console warning per mount
when it runs on a static token; `tokenProvider` wins when both are given.

**Exception to the no-reuse rule:** with a static token the SDK does not fetch anything new; it sends
the same value on the first connect and on every reconnect, until the device token (legacy) is removed. Stream
tokens are single-use, so a stream token passed statically that was already admitted or rejected fails the retry attempts
(`connection_refused`) and ends in the Retry state. A long-lived device token (legacy) keeps reconnecting.
`tokenProvider` is the recommended path and the only one that works with single-use stream tokens. Manual
URL/token mode is a device token (legacy) diagnostic path; a pasted single-use stream token cannot reconnect after admission. `useDeviceStream` also still accepts
`{ client, deviceId }` with a plain `Mobilerun` client.

## Network recovery

While the browser reports offline (`navigator.onLine === false` or an `offline` event), no new
`tokenProvider` call or socket allocation starts. Pending acquisition, retry waits and connect
watchdogs are cancelled; late provider results are ignored without an error. An explicit Retry overrides
this hint for one fresh attempt (direct `useStreamReconnect` consumers forward its `allowOffline`
value to the socket hook/component); if it fails offline, the failure is reported once and automatic
retries, visibility wake and target changes remain gated until online. An advisory offline notification preserves
healthy media until its transport actually fails. Retry is ignored while connected or while an explicit
attempt is still live; otherwise an offline pause shows `unavailable` with the default Retry action.

A false-to-true network transition starts one immediate fresh attempt when a connection is needed,
resets backoff to attempt 0, and calls the latest provider for a new stream token. Duplicate online
events do nothing; a healthy stream is not remounted. Connectivity is only a scheduling hint,
not proof that the server is reachable. A forced attempt with an allocated socket continues when online
returns, while a forced provider wait is discarded for a fresh attempt. Existing labels and bounded
retries still apply.

`DeviceStream` manages this through `useStreamReconnect`. Direct `RemoteControl` or
`useWebRtcConnection` consumers get offline gating and cancellation, but must own remounting and
recovery (for example, with `useStreamReconnect`); the low-level socket hook does not retry on its
own. Observers detach on unmount. Custom lifecycle owners that remove an observer while a session
continues must replace that network source or forward availability to the controller themselves.

## Errors

`DeviceStream` calls `onError` once per failed connection attempt:

```ts
onError?: (error: {
  reason: 'credentials_unavailable' | 'connection_refused' | 'disconnected' | 'device_unavailable' | 'unknown';
  message: string; // fixed SDK text for logs, never exception text from your provider or the socket
  attempt: number; // consecutive failed attempts in this cycle, from 1; the pill shows the same n as "(n/6)"
  final: boolean;  // true when the SDK stops retrying; the Retry button stays available
}) => void;
```

| `reason` | Meaning |
| --- | --- |
| `credentials_unavailable` | `tokenProvider` threw, rejected, returned an empty stream token or took longer than 10 s. Normal backoff applies. |
| `connection_refused` | The signaling socket closed before it opened. A browser cannot read the HTTP status, so a used, expired or revoked stream token, a wrong device and a refused origin all land here. Check the mint call first. |
| `disconnected` | An open session dropped, including the 30-minute server session cap. |
| `device_unavailable` | Reserved for a server message that the device is offline or not ready. The current signaling protocol has none, so React does not report it yet. |
| `unknown` | Anything else, for example a handshake that never finished. |

## Labels

Every text the component renders comes from `labels`, with English defaults:

```tsx
<DeviceStream
  labels={{
    connecting: 'connecting', // pill before the stream is up
    disconnected: 'reconnecting', // pill while reconnecting; " (1/6)" is appended from the first retry
    unavailable: 'device stream unavailable', // after the last retry
    retry: 'Retry', // button text
  }}
/>
```

A `placeholderLabel` (for example the device state) still takes precedence over `labels.connecting`.
