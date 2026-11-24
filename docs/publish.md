← [README](../README.md) · [Components and styling](default-ui.md)

# Publishing microphone and camera inputs

Publishing sends your local microphone and optionally camera into the remote device's virtual
inputs. It uses the existing viewer connection, independently of received device audio and its
`muted` prop. It does not create a preview or another connection.

Your authorized backend fetches `GET /v1/devices/{deviceId}/capabilities` and returns its
`.capabilities` snapshot to your app. Pass that as `publishCapabilities`; do not use a stream token
to call this endpoint or expose a privileged API key. The snapshot describes device support,
not the viewer's permission. Every start is admitted or refused by the server.

```tsx
import { useRef } from 'react';
import { DeviceStream, type DeviceStreamHandle, type DevicePublishCapabilities } from '@mobilerun/react';
import '@mobilerun/react/styles.css';

export function Phone({ streamUrl, tokenProvider, capabilities }: {
  streamUrl: string;
  tokenProvider: () => Promise<string>;
  capabilities: DevicePublishCapabilities;
}) {
  const stream = useRef<DeviceStreamHandle>(null);
  return <div style={{ width: 360, height: 780 }}>
    <DeviceStream ref={stream} streamUrl={streamUrl} tokenProvider={tokenProvider} hasControl
      publishCapabilities={capabilities}
      onPublishStateChange={state => console.info('Publish phase', state.phase)}
      onError={error => {
        if (error.operation === 'publish') console.info(error.reason, error.detail);
      }}
    />
  </div>;
}
```

The default pill floats at the bottom centre without changing the video layout. Microphone toggles
publication on/off. Camera starts microphone+camera; toggling it off restarts microphone-only.
Live inputs show red. Both controls are disabled during setup. The pill is hidden without a snapshot
with `microphoneInjection: true` and `mediaInjectionTransport: 'direct'`; camera also requires
`cameraInjection: true` and a compatible browser H.264 encoder. `hasControl` controls remote input
UI only and does not grant or revoke publishing authority.

Set `hidePublishControls` to hide the pill and call the ref methods from your own user actions:

- `startPublish({ audio: true })`: microphone only. `video: true` requests both inputs atomically.
  `audio` is required; false, missing audio and video-only requests reject before capture/signaling.
  The promise resolves with an `active` snapshot only after server activation and track attachment.
- `stopPublish()`: cancels setup or stops active capture, idempotently. It completes local teardown
  without waiting for a server acknowledgement. Cancellation rejects a pending start with
  `publish_cancelled` and emits a stopped snapshot, without `onError`.
- `getPublishState()`: current immutable snapshot, initially
  `{ phase: 'idle', mediaSessionId: null, kinds: [] }`.

`DeviceStreamHandle` extends `RemoteControlHandle`; existing ref operations remain supported.
`onPublishStateChange` observes `capturing → starting → accepted → active` and terminal
`stopped`/`error` states. Captured tracks stay detached until acceptance. Only one operation is
allowed; a concurrent start rejects without changing it. Explicitly stop then start to change kinds.
Capabilities are fixed for the first viewer offer: remount with a new `key` and fresh stream token
to apply a different snapshot. No publish-time SDP renegotiation or automatic resume occurs.
Browsers unable to produce compatible SSRC-bearing trackless sender reservations keep viewing
and reject publication with `publish_unsupported`.

## Permissions and cleanup

Use HTTPS or localhost and permit the required inputs in your site's Permissions Policy. For
cross-origin iframe embeds configure the parent policy and `allow="microphone; camera"` on the
iframe. Only explicit start requests capture permission; mounting, connecting and reconnecting
never prompt. Audio-only does not request camera permission. The default browser input devices
are used. The capture profile targets 720p at 24–30 fps with a 1 Mbps uplink cap where supported.

Capture is released on cancellation, failure, source loss, signaling/peer loss, pagehide and
unmount. A pending permission prompt may remain visible, but any later tracks are stopped without
attachment. Reconnection never resumes publication; start again explicitly. An ICE credential
refresh on the same socket/peer preserves publication. Stopping publish leaves viewing and
downstream mute unchanged.

## Failures

A rejected start throws `PublishError`, carrying `reason`, `message`, optional `detail` and
`serverReason`. Branch on structured fields, not display text. Terminal failures also update
publish state and emit one `onError` with `operation: 'publish'`, the current viewer attempt,
`final: true`, and an allocated `mediaSessionId` when available. `final` applies to publishing;
viewer reconnect and later explicit starts remain available. A publish refusal never marks the
viewer unavailable.

| Reason | Cause |
| --- | --- |
| `publish_not_allowed` | Explicit server `forbidden`; support never overrides this decision. |
| `publish_unsupported` | Missing/incompatible capabilities, codecs/reservations, or no acceptance within 5 s (`response_timeout`). Silence is not proof of denial. |
| `permission_denied` | Browser `NotAllowedError`/`SecurityError` (`capture_permission`). |
| `publish_busy` | Another publisher holds the device's lease. No stealing or retry. |
| `publish_failed` | Invalid options, concurrent start, missing/busy inputs, source loss, attachment/injection failure or unexpected terminal server response. |
| `publish_timeout` | Accepted but no server active within 15 s (`active_timeout`). |
| `publish_cancelled` | Pending start cancelled locally; no error callback. |
| `disconnected` | Viewer is not connected, is closed, or loses its socket/peer. |

Original string wire reasons are preserved as `serverReason`. Unknown reasons become
`publish_failed`; stale/malformed/foreign-session messages are ignored.

## Labels and styling

All pill text uses `labels` with English defaults:

| Key | Default |
| --- | --- |
| `publishMicrophone` | Microphone |
| `publishCamera` | Camera |
| `publishStarting` | Starting inputs |
| `publishPermissionDenied` | Microphone or camera permission denied |
| `publishNotAllowed` | Publishing is not allowed |
| `publishFailed` | Unable to publish inputs |

The pill uses the existing card, foreground, border and ring tokens. Override the red live state
with `--mr-publish-live` and `--mr-publish-live-foreground` on `.mobilerun-device-stream` or an
ancestor, keeping sufficient contrast.
