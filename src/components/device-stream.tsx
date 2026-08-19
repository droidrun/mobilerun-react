'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { RotateCw, Smartphone, WifiOff } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useMemo } from 'react';
import { cn } from '../lib/cn';
import { STREAM_RECONNECT_MAX_ATTEMPTS } from '../lib/stream-reconnect';
import { RemoteControl, type RemoteControlHandle } from './remote-control';
import { StreamStatusPill } from './stream-status-pill';
import { Button } from './ui/button';
import { useStreamReconnect } from '../hooks/use-stream-reconnect';

interface DeviceStreamProps {
  streamUrl?: string;
  streamToken?: string;
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
    retry,
  } = useStreamReconnect({
    onHeal: onStreamHealed,
    target,
    targetKey: `${streamUrl ?? ''}|${streamToken ?? ''}`,
    enabled: !!streamUrl,
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

  const reconnectLabel =
    attempt > 1 ? `reconnecting (${attempt}/${STREAM_RECONNECT_MAX_ATTEMPTS})` : 'reconnecting';

  return (
    <div
      className={cn(
        'relative w-full h-full flex items-center justify-center bg-background overflow-hidden',
        className,
      )}
    >
      {!streamUrl ? (
        <>
          <Smartphone className="w-12 h-12 text-muted-foreground/30" />
          <StreamStatusPill label={placeholderLabel ?? 'connecting'} />
        </>
      ) : status === 'unavailable' ? (
        <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <WifiOff className="h-10 w-10 opacity-50" />
          <span className="text-xs font-medium">device stream unavailable</span>
          <Button variant="outline" onClick={retry}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="device-stream-wrapper w-full h-full flex items-center justify-center relative">
            <RemoteControl
              ref={ref}
              key={streamKey}
              url={activeTarget.url ?? streamUrl}
              token={activeTarget.token}
              className="w-full h-full"
              onConnectionStateChange={handleConnectionStateChange}
              onConnectionFailed={onConnectionFailed}
              placeholderLabel={status === 'reconnecting' ? reconnectLabel : placeholderLabel}
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
