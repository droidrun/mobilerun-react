'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { Smartphone } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useMemo } from 'react';
import { cn } from '../lib/cn';
import {
  reconnectPillLabel,
  resolveDeviceStreamLabels,
  type DeviceStreamLabels,
  type StreamError,
} from '../lib/stream-error';
import { STREAM_RECONNECT_MAX_ATTEMPTS } from '../lib/stream-reconnect';
import { RemoteControl, type RemoteControlHandle } from './remote-control';
import { StreamStatusPill } from './stream-status-pill';
import { StreamUnavailable } from './stream-unavailable';
import { useStaticTokenWarning } from '../hooks/use-static-token-warning';
import { useStreamReconnect } from '../hooks/use-stream-reconnect';

export interface DeviceStreamProps {
  streamUrl?: string;
  /**
   * @deprecated A static key is single-use, so it cannot reconnect. Use `tokenProvider`,
   * which returns a fresh key for every connection attempt. Logs one console warning per mount.
   */
  streamToken?: string;
  /**
   * Called before every WebSocket attempt, the first connect and each reconnect, and returns
   * a fresh stream key minted by your backend (`POST /v1/identity/stream-keys`). A key is never
   * reused for a second connect. A throw, a rejection, an empty key or no answer within 10 s
   * fails the attempt with reason `credentials_unavailable`. Wins over `streamToken`.
   */
  tokenProvider?: () => Promise<string>;
  /**
   * Called once per failed connection attempt with the reason, the attempt number and whether
   * the SDK stopped retrying (`final`). The Retry button stays available after a final error.
   */
  onError?: (error: StreamError) => void;
  /** Replaces the built-in English texts. Every key is optional. */
  labels?: Partial<DeviceStreamLabels>;
  hasControl: boolean;
  onHasControlChange?: (hasControl: boolean) => void;
  onConnectionStateChange?: (connected: boolean) => void;
  /**
   * Fired when a reconnect cycle starts (first failure after a healthy
   * stretch) and on wake/manual retry. Use to refetch fresh stream
   * credentials in case the URL is stale. Not fired per retry attempt.
   */
  onStreamHealed?: () => void;
  className?: string;
  /**
   * Label for the corner pill shown while the stream isn't connected (no
   * URL yet, or WebRTC still negotiating). Drive this from the device's
   * state so the user sees what the device is actually doing. While the
   * stream is reconnecting after a drop, a "reconnecting" label takes
   * precedence — that is the actual status then.
   */
  placeholderLabel?: string;
  /**
   * Mutes the device's audio track. Defaults to true; only flip to false in
   * response to a user gesture, otherwise the browser blocks autoplay.
   */
  muted?: boolean;
  /**
   * Fired with the underlying RTCPeerConnection once it is created and with
   * null when it is torn down. Lets consumers observe the connection (e.g.
   * poll getStats() for debugging) without owning its lifecycle.
   */
  onPeerConnectionChange?: (pc: RTCPeerConnection | null) => void;
}

export const DeviceStream = forwardRef<RemoteControlHandle, DeviceStreamProps>(function DeviceStream(
  {
    streamUrl,
    streamToken,
    tokenProvider,
    onError,
    labels: labelOverrides,
    hasControl,
    onHasControlChange: setHasControl = () => {},
    onConnectionStateChange,
    onStreamHealed,
    className,
    placeholderLabel,
    muted,
    onPeerConnectionChange,
  }: DeviceStreamProps,
  ref,
) {
  // The reconnect manager pins which URL/token the mounted stream uses:
  // fresh credentials arriving mid-backoff must not restart the connection
  // early (RemoteControl reconnects in place on a url prop change), so
  // RemoteControl below renders from `activeTarget`, never the raw props.
  const target = useMemo(() => ({ url: streamUrl, token: streamToken }), [streamUrl, streamToken]);
  const {
    streamKey,
    activeTarget,
    status,
    attempt,
    onConnectionStateChange: onReconnectConnectionChange,
    onConnectionFailed,
    onConnectionAttemptStarted,
    retry,
  } = useStreamReconnect({
    onHeal: onStreamHealed,
    onError,
    target,
    targetKey: `${streamUrl ?? ''}|${streamToken ?? ''}`,
    enabled: !!streamUrl,
    watchdogFromSocket: true,
  });

  const handleConnectionStateChange = useCallback(
    (connected: boolean) => {
      onReconnectConnectionChange(connected);
      onConnectionStateChange?.(connected);
    },
    [onReconnectConnectionChange, onConnectionStateChange],
  );

  // Reset control when stream disconnects
  useEffect(() => {
    if (!streamUrl) {
      setHasControl(false);
    }
  }, [streamUrl, setHasControl]);

  const labels = resolveDeviceStreamLabels(labelOverrides);

  useStaticTokenWarning(!!streamToken && !tokenProvider);

  const reconnectLabel = reconnectPillLabel(labels.disconnected, attempt, STREAM_RECONNECT_MAX_ATTEMPTS);

  return (
    <div
      className={cn(
        'mobilerun-device-stream relative w-full h-full flex items-center justify-center bg-background overflow-hidden',
        className,
      )}
    >
      {!streamUrl ? (
        <>
          <Smartphone className="w-12 h-12 text-muted-foreground/30" />
          <StreamStatusPill label={placeholderLabel ?? labels.connecting} />
        </>
      ) : status === 'unavailable' ? (
        <StreamUnavailable labels={labels} onRetry={retry} />
      ) : (
        <>
          <div className="device-stream-wrapper w-full h-full flex items-center justify-center relative">
            <RemoteControl
              ref={ref}
              key={streamKey}
              url={activeTarget.url ?? streamUrl}
              token={activeTarget.token}
              tokenProvider={tokenProvider}
              className="w-full h-full"
              onConnectionStateChange={handleConnectionStateChange}
              onConnectionFailed={onConnectionFailed}
              onConnectionAttemptStarted={onConnectionAttemptStarted}
              placeholderLabel={status === 'reconnecting' ? reconnectLabel : (placeholderLabel ?? labels.connecting)}
              muted={muted}
              onPeerConnectionChange={onPeerConnectionChange}
            />
          </div>

          {/* Overlay block when controls are disabled (toggled via header switch) */}
          {!hasControl && (
            <div
              className="absolute inset-0 z-50 bg-transparent cursor-default"
              // stopPropagation blocks clicks but allows scrolling if needed
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />
          )}
        </>
      )}
    </div>
  );
});
