'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { Smartphone } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { cn } from '../lib/cn';
import { RemoteControl } from './remote-control';
import { StreamStatusPill } from './stream-status-pill';
import { useStreamSelfHeal } from '../hooks/use-stream-self-heal';

interface DeviceStreamProps {
  streamUrl?: string;
  streamToken?: string;
  hasControl: boolean;
  onHasControlChange?: (hasControl: boolean) => void;
  onConnectionStateChange?: (connected: boolean) => void;
  /**
   * Fired whenever the stream self-heals after a stable disconnect — i.e. the
   * underlying WebRTC connection has been remounted. Use to refetch fresh
   * stream credentials in case the URL is stale.
   */
  onStreamHealed?: () => void;
  className?: string;
  /**
   * Label for the corner pill shown while the stream isn't connected (no
   * URL yet, or WebRTC still negotiating). Drive this from the device's
   * state so the user sees what the device is actually doing.
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

export function DeviceStream({
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
}: DeviceStreamProps) {
  const { onConnectionStateChange: onSelfHealConnectionChange, streamKey } = useStreamSelfHeal({
    onHeal: onStreamHealed,
    restartKey: `${streamUrl ?? ''}|${streamToken ?? ''}`,
  });

  const handleConnectionStateChange = useCallback(
    (connected: boolean) => {
      onSelfHealConnectionChange(connected);
      onConnectionStateChange?.(connected);
    },
    [onSelfHealConnectionChange, onConnectionStateChange],
  );

  // Reset control when stream disconnects
  useEffect(() => {
    if (!streamUrl) {
      setHasControl(false);
    }
  }, [streamUrl, setHasControl]);

  return (
    <div
      className={cn(
        'relative w-full h-full flex items-center justify-center bg-background overflow-hidden',
        className,
      )}
    >
      {streamUrl ? (
        <>
          <div className="device-stream-wrapper w-full h-full flex items-center justify-center relative">
            <RemoteControl
              key={streamKey}
              url={streamUrl}
              token={streamToken}
              className="w-full h-full"
              onConnectionStateChange={handleConnectionStateChange}
              placeholderLabel={placeholderLabel}
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
      ) : (
        <>
          <Smartphone className="w-12 h-12 text-muted-foreground/30" />
          <StreamStatusPill label={placeholderLabel ?? 'connecting'} />
        </>
      )}
    </div>
  );
}
