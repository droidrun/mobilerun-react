'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { useEffect, useRef } from 'react';

import {
  createKeyRouter,
  createPointerRouter,
  MOUSE_POINTER_ID,
  mapClientPoint,
  pasteMessages,
  routeScroll,
  wheelToTicks,
  type PointerInput,
  type RoutedMessage,
  type VideoPoint,
} from '../lib/input-routing';

declare global {
  interface Window {
    debugRemoteControl?: boolean;
  }
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

/**
 * Read the video element's current bounding rect and intrinsic dimensions and
 * map a client point into video pixels. Returns null when the video element
 * isn't ready; `point` is null when the point is outside the letterboxed area.
 */
function getVideoPoint(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): { point: VideoPoint | null; videoWidth: number; videoHeight: number } | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const point = mapClientPoint(
    video.getBoundingClientRect(),
    videoWidth,
    videoHeight,
    clientX,
    clientY,
  );
  return { point, videoWidth, videoHeight };
}

interface UseScrcpyInputOptions {
  containerRef: React.RefObject<HTMLDivElement | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  dataChannelRef: React.MutableRefObject<RTCDataChannel | null>;
  hoverChannelRef: React.MutableRefObject<RTCDataChannel | null>;
}

interface UseScrcpyInputResult {
  handleInteraction: (event: React.MouseEvent | React.TouchEvent) => void;
  handleKeyboard: (event: React.KeyboardEvent) => void;
}

/**
 * DOM wiring only: every routing decision lives in `lib/input-routing`.
 */
export function useScrcpyInput({
  containerRef,
  videoRef,
  dataChannelRef,
  hoverChannelRef,
}: UseScrcpyInputOptions): UseScrcpyInputResult {
  const pointerRouter = useRef(createPointerRouter());
  const keyRouter = useRef(createKeyRouter());

  const sendBinaryControlMessage = (data: ArrayBuffer) => {
    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      return;
    }
    dataChannelRef.current.send(data);
  };

  // Hover messages go on a separate unordered, lossy channel so a stale
  // cursor update never blocks newer ones behind retransmits. Drops the
  // event if id=2 isn't open yet — never falls back to the control
  // channel, because backends like Android scrcpy abort the control
  // stream on unknown message types (the type-21 hover byte is custom
  // and would poison their parser).
  const sendHoverMessage = (data: ArrayBuffer) => {
    if (hoverChannelRef.current?.readyState !== 'open') return;
    hoverChannelRef.current.send(data);
  };

  const send = (messages: RoutedMessage[]) => {
    for (const { channel, data } of messages) {
      if (channel === 'hover') sendHoverMessage(data);
      else sendBinaryControlMessage(data);
    }
  };

  // Unified handler for both mouse and touch interactions
  const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
    event.preventDefault();
    event.stopPropagation();

    // No channel check: the router must see every release, or a gesture ended
    // while the channel was closed would stay active. `send` drops while closed.
    const video = videoRef.current;
    if (!video) return;

    const route = (input: Omit<PointerInput, 'point'>, clientX: number, clientY: number) => {
      const mapped = getVideoPoint(video, clientX, clientY);
      if (!mapped) return;
      if (input.mouse && input.type === 'down' && input.button === 0 && mapped.point) {
        video.focus();
      }
      send(
        pointerRouter.current.route(
          { ...input, point: mapped.point },
          mapped.videoWidth,
          mapped.videoHeight,
        ),
      );
    };

    if ('touches' in event) {
      // Touch Events: changedTouches carries the points of start/end/cancel.
      let type: PointerInput['type'];
      switch (event.type) {
        case 'touchstart':
          type = 'down';
          break;
        case 'touchmove':
          type = 'move';
          break;
        case 'touchend':
          type = 'up';
          break;
        case 'touchcancel':
          type = 'cancel';
          break;
        default:
          return;
      }
      for (let i = 0; i < event.changedTouches.length; i++) {
        const touch = event.changedTouches[i];
        route(
          { type, id: touch.identifier, mouse: false, button: 0, buttons: 0 },
          touch.clientX,
          touch.clientY,
        );
      }
      return;
    }

    // Mouse Events
    let type: PointerInput['type'];
    let button = event.button;
    switch (event.type) {
      case 'mousedown':
        type = 'down';
        break;
      case 'mousemove':
        type = 'move';
        break;
      case 'mouseup':
        type = 'up';
        break;
      case 'mouseleave':
        // Leaving the video releases a held gesture like a primary release.
        type = 'up';
        button = 0;
        break;
      default:
        return;
    }
    route({ type, id: MOUSE_POINTER_ID, mouse: true, button, buttons: event.buttons }, event.clientX, event.clientY);
  };

  // Native wheel listener — attached with passive:false in an effect so we
  // can preventDefault and stop the page from scrolling. Mirrors the desktop
  // scrcpy client (sc_input_manager_process_mouse_wheel + mouse_sdk.c).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (!videoRef.current) return;

      const mapped = getVideoPoint(videoRef.current, event.clientX, event.clientY);
      if (!mapped) return;
      const { h, v } = wheelToTicks(event.deltaMode, event.deltaX, event.deltaY);
      send(routeScroll(mapped.videoWidth, mapped.videoHeight, mapped.point, h, v, event.buttons));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: refs are stable; re-attaching on every render would break passive:false contract
  }, []);

  const handleKeyboard = (event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    // Use the wrapper for conditional logging
    debugLog('Keyboard event:', {
      type: event.type,
      key: event.key,
      keyCode: event.keyCode,
      code: event.code,
      target: (event.target as HTMLElement).tagName,
      focused: document.activeElement === videoRef.current,
    });

    if (document.activeElement !== videoRef.current) {
      // Use the wrapper for conditional warning
      debugWarn('Video element not focused, skipping keyboard event');
      return;
    }

    if (!dataChannelRef.current || dataChannelRef.current.readyState !== 'open') {
      // Use the wrapper for conditional warning
      debugWarn('Data channel not ready for keyboard event:', dataChannelRef.current?.readyState);
      return;
    }

    const routed = keyRouter.current.route({
      type: event.type === 'keydown' ? 'keydown' : 'keyup',
      code: event.code,
      key: event.key,
      shift: event.shiftKey,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey, // Command on Mac, Windows key on Win
      capsLock: event.getModifierState('CapsLock'),
    });

    if (routed.kind === 'paste') {
      debugLog('Paste shortcut detected');
      navigator.clipboard
        .readText()
        .then((text) => send(pasteMessages(text)))
        .catch((err) => {
          console.error('Failed to read clipboard contents: ', err);
        });
      return;
    }
    send(routed.messages);
  };

  return { handleInteraction, handleKeyboard };
}
