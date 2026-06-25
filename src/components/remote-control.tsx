'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { clsx } from 'clsx';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StreamStatusPill } from './stream-status-pill';

import { ANDROID_KEYS, codeMap } from '../constants';
import { createInjectKeycodeMessage } from '../webrtc-messages';
import { useScrcpyInput } from '../hooks/use-scrcpy-input';
import { useWebRtcConnection } from '../hooks/use-webrtc-connection';

declare global {
  interface Window {
    debugRemoteControl?: boolean;
  }
}

interface RemoteControlProps {
  // url is the URL of the instance to connect to.
  url: string;

  // token is used to authenticate the connection to the instance.
  token?: string;

  // className is the class name to apply to the component
  // on top of the default styles.
  className?: string;

  // sessionId is a unique identifier for the WebRTC session
  // with the source to prevent conflicts between other
  // users connected to the same source.
  // If empty, the component will generate a random one.
  sessionId?: string;

  // openUrl is the URL to open in the instance when the
  // component is ready.
  //
  // If not provided, the component will not open any URL.
  openUrl?: string;

  // Fired when the WebRTC peer connection state changes.
  // Only driven by RTCPeerConnection.onconnectionstatechange,
  // NOT by intentional teardown (stop/unmount), so it is safe
  // to use for disconnect detection without false positives.
  onConnectionStateChange?: (connected: boolean) => void;

  // Override label for the corner pill shown while the WebRTC stream is
  // not yet connected. Defaults to "connecting". Pass a device-state-derived
  // label (e.g. "migrating", "resetting") when the underlying device isn't
  // ready, so the user sees the real reason the video isn't there yet.
  placeholderLabel?: string;

  // When false, the device's audio track (if the backend publishes one) is
  // played back. Defaults to true. Consumers must only flip this to false in
  // response to a user gesture; otherwise the browser will block autoplay.
  muted?: boolean;

  // Fired with the underlying RTCPeerConnection once it is created and with
  // null when it is torn down. Lets consumers observe the connection (e.g.
  // poll getStats() for debugging) without owning its lifecycle.
  onPeerConnectionChange?: (pc: RTCPeerConnection | null) => void;
}

interface ScreenshotData {
  dataUri: string;
}

export interface ImperativeKeyboardEvent {
  type: 'keydown' | 'keyup';
  code: string; // e.g., "KeyA", "Enter", "ShiftLeft"
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

// Android system navigation buttons → keycodes. These have no browser
// KeyboardEvent.code, so they can't ride the codeMap path used by sendKeyEvent;
// they're addressed by name and injected as a down+up keycode pair instead.
const SYSTEM_KEYCODES = {
  BACK: ANDROID_KEYS.KEYCODE_BACK,
  HOME: ANDROID_KEYS.KEYCODE_HOME,
  RECENT: ANDROID_KEYS.KEYCODE_APP_SWITCH,
} as const;

export type SystemButton = keyof typeof SYSTEM_KEYCODES;

export interface RemoteControlHandle {
  openUrl: (url: string) => void;
  sendKeyEvent: (event: ImperativeKeyboardEvent) => void;
  // Press an Android system navigation button (Back / Home / Recents).
  sendSystemKey: (button: SystemButton) => void;
  screenshot: () => Promise<ScreenshotData>;
}

const debugLog = (...args: any[]) => {
  if (window.debugRemoteControl) {
    // eslint-disable-next-line no-console -- opt-in debug channel (window.debugRemoteControl)
    console.log(...args);
  }
};

const debugWarn = (...args: any[]) => {
  if (window.debugRemoteControl) {
    console.warn(...args);
  }
};

export const RemoteControl = forwardRef<RemoteControlHandle, RemoteControlProps>(
  (
    {
      className,
      url,
      token,
      sessionId: propSessionId,
      openUrl,
      onConnectionStateChange,
      placeholderLabel,
      muted = true,
      onPeerConnectionChange,
    }: RemoteControlProps,
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const videoRef = useRef<HTMLVideoElement>(null);

    const sessionId = useMemo(
      () =>
        propSessionId ||
        Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
      [propSessionId],
    );

    const {
      wsRef,
      dataChannelRef,
      hoverChannelRef,
      isConnected,
      pendingScreenshotResolversRef,
      pendingScreenshotRejectersRef,
    } = useWebRtcConnection({
      url,
      token,
      sessionId,
      openUrl,
      videoRef,
      onConnectionStateChange,
      onPeerConnectionChange,
    });

    const { handleInteraction, handleKeyboard } = useScrcpyInput({
      containerRef,
      videoRef,
      dataChannelRef,
      hoverChannelRef,
    });

    // Reflect the `muted` prop onto the video element. Done via the property
    // (not the attribute) because React doesn't always re-render attribute
    // changes on muted, and because consumers may toggle this after the
    // element has already started playing.
    useEffect(() => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = muted;
      if (!muted) {
        // Unmuting requires a user gesture per browser autoplay policy. If
        // play() rejects, the video element just pauses; surface the reason
        // in debug mode so consumers can spot a missing gesture.
        video.play().catch((err) => debugWarn('Unmute play() rejected:', err));
      }
    }, [muted]);

    const handleVideoClick = () => {
      if (videoRef.current) {
        videoRef.current.focus();
      }
    };

    // Expose sendOpenUrlCommand via ref
    useImperativeHandle(ref, () => ({
      openUrl: (newUrl: string) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          debugWarn('WebSocket not open, cannot send open_url command via ref.');
          return;
        }
        try {
          const decodedUrl = decodeURIComponent(newUrl);
          debugLog('Opening URL');
          wsRef.current.send(
            JSON.stringify({
              type: 'openUrl',
              url: decodedUrl,
              sessionId: sessionId,
            }),
          );
        } catch (error) {
          debugWarn('Error decoding or sending URL via ref:', { error, url: newUrl });
          wsRef.current.send(
            JSON.stringify({
              type: 'openUrl',
              url: newUrl,
              sessionId: sessionId,
            }),
          );
        }
      },

      sendKeyEvent: (event: ImperativeKeyboardEvent) => {
        if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
          debugWarn(
            'Data channel not ready for imperative key command:',
            dataChannelRef.current?.readyState,
          );
          return;
        }

        const keycode = codeMap[event.code];
        if (!keycode) {
          debugWarn(`Unknown event.code for imperative command: ${event.code}`);
          return;
        }

        let metaState = ANDROID_KEYS.META_NONE;
        if (event.shiftKey) metaState |= ANDROID_KEYS.META_SHIFT_ON;
        if (event.altKey) metaState |= ANDROID_KEYS.META_ALT_ON;
        if (event.ctrlKey) metaState |= ANDROID_KEYS.META_CTRL_ON;
        if (event.metaKey) metaState |= ANDROID_KEYS.META_META_ON;

        const action = event.type === 'keydown' ? ANDROID_KEYS.ACTION_DOWN : ANDROID_KEYS.ACTION_UP;

        debugLog(
          `Sending Imperative Key Command: code=${event.code}, keycode=${keycode}, action=${action}, meta=${metaState}`,
        );

        const message = createInjectKeycodeMessage(
          action,
          keycode,
          0, // repeat count, typically 0 for single presses
          metaState,
        );
        if (message) {
          dataChannelRef.current.send(message);
        }
      },

      sendSystemKey: (button: SystemButton) => {
        if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
          debugWarn(
            'Data channel not ready for system key command:',
            dataChannelRef.current?.readyState,
          );
          return;
        }

        const keycode = SYSTEM_KEYCODES[button];
        debugLog(`Sending System Key Command: button=${button}, keycode=${keycode}`);

        // A button press is a full down + up cycle.
        const down = createInjectKeycodeMessage(ANDROID_KEYS.ACTION_DOWN, keycode);
        const up = createInjectKeycodeMessage(ANDROID_KEYS.ACTION_UP, keycode);
        if (down) dataChannelRef.current.send(down);
        if (up) dataChannelRef.current.send(up);
      },
      screenshot: (): Promise<ScreenshotData> => {
        return new Promise<ScreenshotData>((resolve, reject) => {
          if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
            debugWarn('WebSocket not open, cannot send screenshot command.');
            return reject(new Error('WebSocket is not connected or connection is not open.'));
          }

          const id = `ui-ss-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
          const request = {
            type: 'screenshot', // Matches the type expected by instance API
            id: id,
          };

          pendingScreenshotResolversRef.current.set(id, resolve);
          pendingScreenshotRejectersRef.current.set(id, reject);

          debugLog('Sending screenshot request:', request);
          try {
            wsRef.current.send(JSON.stringify(request));
          } catch (err) {
            debugWarn('Failed to send screenshot request immediately:', err);
            pendingScreenshotResolversRef.current.delete(id);
            pendingScreenshotRejectersRef.current.delete(id);
            reject(err);
            return; // Important to return here if send failed synchronously
          }

          setTimeout(() => {
            if (pendingScreenshotResolversRef.current.has(id)) {
              debugWarn(`Screenshot request timed out for id ${id}`);
              pendingScreenshotRejectersRef.current.get(id)?.(
                new Error('Screenshot request timed out'),
              );
              pendingScreenshotResolversRef.current.delete(id);
              pendingScreenshotRejectersRef.current.delete(id);
            }
          }, 30000); // 30-second timeout
        });
      },
    }));

    return (
      <div
        ref={containerRef}
        className={clsx(
          'rc-container', // Use custom CSS class instead of Tailwind
          className,
        )}
        style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
        // Attach unified handler to all interaction events on the container
        // This helps capture mouseleave correctly even if the video element itself isn't hovered
        onMouseDown={handleInteraction}
        onMouseMove={handleInteraction}
        onMouseUp={handleInteraction}
        onMouseLeave={handleInteraction} // Handle mouse leaving the container
        onTouchStart={handleInteraction}
        onTouchMove={handleInteraction}
        onTouchEnd={handleInteraction}
        onTouchCancel={handleInteraction}
      >
        <video
          ref={videoRef}
          className="rc-video" // Use custom CSS class
          autoPlay
          playsInline
          muted={muted}
          tabIndex={0} // Make it focusable
          style={{ outline: 'none', pointerEvents: 'none' }}
          onKeyDown={handleKeyboard}
          onKeyUp={handleKeyboard}
          onClick={handleVideoClick}
          onFocus={() => {
            if (videoRef.current) {
              videoRef.current.style.outline = 'none';
            }
          }}
          onBlur={() => {
            if (videoRef.current) {
              videoRef.current.style.outline = 'none';
            }
          }}
        />
        {!isConnected && <StreamStatusPill label={placeholderLabel ?? 'connecting'} />}
      </div>
    );
  },
);

RemoteControl.displayName = 'RemoteControl';
