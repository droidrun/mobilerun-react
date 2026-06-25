'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import type React from 'react';
import { useEffect, useRef } from 'react';

import { AMOTION_EVENT, ANDROID_KEYS, codeMap } from '../constants';
import {
  createInjectKeycodeMessage,
  createInjectMouseHoverMessage,
  createInjectScrollEventMessage,
  createInjectTextMessage,
  createSetClipboardMessage,
  createTouchControlMessage,
} from '../webrtc-messages';

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
 * Map a client-coordinate point onto the video's pixel space, accounting for
 * the letterboxing object-fit:contain introduces. Returns null when the point
 * falls outside the rendered video area.
 */
function computeVideoCoords(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  videoWidth: number,
  videoHeight: number,
): { videoX: number; videoY: number } | null {
  const displayWidth = rect.width;
  const displayHeight = rect.height;
  const videoAspectRatio = videoWidth / videoHeight;
  const containerAspectRatio = displayWidth / displayHeight;
  let actualWidth = displayWidth;
  let actualHeight = displayHeight;
  if (videoAspectRatio > containerAspectRatio) {
    actualHeight = displayWidth / videoAspectRatio;
  } else {
    actualWidth = displayHeight * videoAspectRatio;
  }
  const offsetX = (displayWidth - actualWidth) / 2;
  const offsetY = (displayHeight - actualHeight) / 2;
  const relativeX = clientX - rect.left - offsetX;
  const relativeY = clientY - rect.top - offsetY;
  if (relativeX < 0 || relativeX > actualWidth || relativeY < 0 || relativeY > actualHeight) {
    return null;
  }
  return {
    videoX: Math.max(0, Math.min(videoWidth, (relativeX / actualWidth) * videoWidth)),
    videoY: Math.max(0, Math.min(videoHeight, (relativeY / actualHeight) * videoHeight)),
  };
}

/**
 * Read the video element's current bounding rect and intrinsic dimensions,
 * then delegate to `computeVideoCoords`. Collapses the repeated boilerplate
 * (getBoundingClientRect + videoWidth/videoHeight guard + coord mapping)
 * that appears in every input-handler path.
 *
 * Returns null when the video element isn't ready or the point is outside
 * the letterboxed area.
 */
function getVideoCoords(
  video: HTMLVideoElement,
  clientX: number,
  clientY: number,
): { videoX: number; videoY: number; videoWidth: number; videoHeight: number } | null {
  const { videoWidth, videoHeight } = video;
  if (!videoWidth || !videoHeight) return null;
  const rect = video.getBoundingClientRect();
  const coords = computeVideoCoords(clientX, clientY, rect, videoWidth, videoHeight);
  if (!coords) return null;
  return { ...coords, videoWidth, videoHeight };
}

function getAndroidKeycodeAndMeta(
  event: React.KeyboardEvent,
): { keycode: number; metaState: number } | null {
  const code = event.code;
  const keycode = codeMap[code];

  if (!keycode) {
    // Use the wrapper for conditional warning
    debugWarn(`Unknown event.code: ${code}, key: ${event.key}`);
    return null;
  }

  let metaState = ANDROID_KEYS.META_NONE;
  const isLetter = code >= 'KeyA' && code <= 'KeyZ';
  const isCapsLock = event.getModifierState('CapsLock');
  const isShiftPressed = event.shiftKey;

  // Determine effective shift state
  let effectiveShift = isShiftPressed;
  if (isLetter) {
    effectiveShift = isShiftPressed !== isCapsLock; // Logical XOR for booleans
  }

  // Apply meta states
  if (effectiveShift) metaState |= ANDROID_KEYS.META_SHIFT_ON;
  if (event.ctrlKey) metaState |= ANDROID_KEYS.META_CTRL_ON;
  if (event.altKey) metaState |= ANDROID_KEYS.META_ALT_ON;
  if (event.metaKey) metaState |= ANDROID_KEYS.META_META_ON; // Command on Mac, Windows key on Win

  return { keycode, metaState };
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

export function useScrcpyInput({
  containerRef,
  videoRef,
  dataChannelRef,
  hoverChannelRef,
}: UseScrcpyInputOptions): UseScrcpyInputResult {
  // Map to track active pointers (mouse or touch) and their last known position inside the video
  // Key: pointerId (-1 for mouse, touch.identifier for touch), Value: { x: number, y: number }
  const activePointers = useRef<Map<number, { x: number; y: number }>>(new Map());

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

  // Unified handler for both mouse and touch interactions
  const handleInteraction = (event: React.MouseEvent | React.TouchEvent) => {
    event.preventDefault();
    event.stopPropagation();

    if (
      !dataChannelRef.current ||
      dataChannelRef.current.readyState !== 'open' ||
      !videoRef.current
    ) {
      return;
    }

    const video = videoRef.current;
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    if (!videoWidth || !videoHeight) return; // Video dimensions not ready

    // Helper to process a single pointer event (either mouse or a single touch point)
    const processPointer = (
      pointerId: number,
      clientX: number,
      clientY: number,
      eventType: 'down' | 'move' | 'up' | 'cancel',
    ) => {
      const coords = getVideoCoords(video, clientX, clientY);
      const isInside = coords !== null;
      const videoX = coords?.videoX ?? 0;
      const videoY = coords?.videoY ?? 0;

      let action: number | null = null;
      let positionToSend: { x: number; y: number } | null = null;
      const pressure = 1.0; // Default pressure
      const buttons = AMOTION_EVENT.BUTTON_PRIMARY; // Assume primary button

      switch (eventType) {
        case 'down':
          if (isInside) {
            action = AMOTION_EVENT.ACTION_DOWN;
            positionToSend = { x: videoX, y: videoY };
            activePointers.current.set(pointerId, positionToSend);
            if (pointerId === -1) {
              // Focus on mouse down
              videoRef.current?.focus();
            }
          } else {
            // If the initial down event is outside, ignore it for this pointer
            activePointers.current.delete(pointerId);
          }
          break;

        case 'move':
          if (activePointers.current.has(pointerId)) {
            if (isInside) {
              action = AMOTION_EVENT.ACTION_MOVE;
              positionToSend = { x: videoX, y: videoY };
              // Update the last known position for this active pointer
              activePointers.current.set(pointerId, positionToSend);
            } else {
              // Moved outside while active - do nothing, UP/CANCEL will use last known pos
            }
          }
          break;

        case 'up':
        case 'cancel': // Treat cancel like up, but use ACTION_CANCEL
          if (activePointers.current.has(pointerId)) {
            action = eventType === 'cancel' ? AMOTION_EVENT.ACTION_CANCEL : AMOTION_EVENT.ACTION_UP;
            // IMPORTANT: Send the UP/CANCEL at the *last known position* inside the video
            positionToSend = activePointers.current.get(pointerId)!;
            activePointers.current.delete(pointerId); // Remove pointer as it's no longer active
          }
          break;
      }

      // Send message if action and position determined
      if (action !== null && positionToSend !== null) {
        const message = createTouchControlMessage(
          action,
          pointerId,
          videoWidth,
          videoHeight,
          positionToSend.x,
          positionToSend.y,
          pressure,
          buttons,
          buttons,
        );
        if (message) {
          sendBinaryControlMessage(message);
        }
      } else if (eventType === 'up' || eventType === 'cancel') {
        // Clean up map just in case if 'down' was outside and 'up'/'cancel' is triggered
        activePointers.current.delete(pointerId);
      }
    };

    // --- Event Type Handling ---

    if ('touches' in event) {
      // Touch Events
      const touches = event.changedTouches; // Use changedTouches for start/end/cancel
      let eventType: 'down' | 'move' | 'up' | 'cancel';

      switch (event.type) {
        case 'touchstart':
          eventType = 'down';
          break;
        case 'touchmove':
          eventType = 'move';
          break;
        case 'touchend':
          eventType = 'up';
          break;
        case 'touchcancel':
          eventType = 'cancel';
          break;
        default:
          return; // Should not happen
      }

      for (let i = 0; i < touches.length; i++) {
        const touch = touches[i];
        processPointer(touch.identifier, touch.clientX, touch.clientY, eventType);
      }
    } else {
      // Mouse Events
      const pointerId = -1; // Use -1 for mouse pointer
      let eventType: 'down' | 'move' | 'up' | 'cancel' | null = null;

      switch (event.type) {
        case 'mousedown':
          if (event.button === 0) eventType = 'down'; // Only primary button
          break;
        case 'mousemove':
          // Only process move if primary button is down (check map)
          if (activePointers.current.has(pointerId)) {
            eventType = 'move';
          }
          break;
        case 'mouseup':
          if (event.button === 0) eventType = 'up'; // Only primary button
          break;
        case 'mouseleave':
          // Treat leave like up only if button was down
          if (activePointers.current.has(pointerId)) {
            eventType = 'up';
          }
          break;
      }

      if (eventType) {
        processPointer(pointerId, event.clientX, event.clientY, eventType);
      } else if (event.type === 'mousemove') {
        // No active touch — emit a hover/cursor message instead.
        const coords = getVideoCoords(video, event.clientX, event.clientY);
        if (!coords) {
          return;
        }
        sendHoverMessage(
          createInjectMouseHoverMessage(
            videoWidth,
            videoHeight,
            coords.videoX,
            coords.videoY,
            event.buttons,
          ),
        );
      }
    }
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

      if (
        !dataChannelRef.current ||
        dataChannelRef.current.readyState !== 'open' ||
        !videoRef.current
      ) {
        return;
      }

      const video = videoRef.current;
      const coords = getVideoCoords(video, event.clientX, event.clientY);
      if (!coords) return;
      const { videoX, videoY, videoWidth, videoHeight } = coords;

      // Browser deltaX/deltaY → wheel ticks (1 tick ≈ one notch).
      // deltaMode 0 (pixel) is the common case: Chrome/Edge ~100px per notch,
      // Firefox uses smaller values. /100 is the de-facto convention used by
      // ya-webadb/Tango and works well for both mice and trackpads.
      let dx = event.deltaX;
      let dy = event.deltaY;
      switch (event.deltaMode) {
        case 0: // DOM_DELTA_PIXEL
          dx /= 100;
          dy /= 100;
          break;
        case 1: // DOM_DELTA_LINE — already roughly in tick units
          break;
        case 2: // DOM_DELTA_PAGE
          dx *= 3;
          dy *= 3;
          break;
      }

      // scrcpy/Android: positive vscroll = scroll up, hscroll = scroll left.
      // Browsers: positive deltaY = content scrolls down. Invert.
      const hscrollTicks = -dx;
      const vscrollTicks = -dy;

      const message = createInjectScrollEventMessage(
        videoWidth,
        videoHeight,
        videoX,
        videoY,
        hscrollTicks,
        vscrollTicks,
        event.buttons,
      );
      sendBinaryControlMessage(message);
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

    // Handle special shortcuts first (Paste, Menu)
    if (event.type === 'keydown') {
      // Paste (Cmd+V / Ctrl+V)
      if (event.key.toLowerCase() === 'v' && (event.metaKey || event.ctrlKey)) {
        debugLog('Paste shortcut detected');
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              debugLog(
                'Pasting text via SET_CLIPBOARD:',
                text.substring(0, 20) + (text.length > 20 ? '...' : ''),
              );
              const message = createSetClipboardMessage(text, true); // paste=true
              sendBinaryControlMessage(message);
            }
          })
          .catch((err) => {
            console.error('Failed to read clipboard contents: ', err);
          });
        return; // Don't process 'v' keycode further
      }

      // Menu (Cmd+M / Ctrl+M) - Send down and up immediately
      if (event.key.toLowerCase() === 'm' && (event.metaKey || event.ctrlKey)) {
        debugLog('Menu shortcut detected');
        const messageDown = createInjectKeycodeMessage(
          ANDROID_KEYS.ACTION_DOWN,
          ANDROID_KEYS.MENU,
          0,
          ANDROID_KEYS.META_NONE, // Modifiers are handled by the shortcut check, not passed down
        );
        sendBinaryControlMessage(messageDown);
        const messageUp = createInjectKeycodeMessage(
          ANDROID_KEYS.ACTION_UP,
          ANDROID_KEYS.MENU,
          0,
          ANDROID_KEYS.META_NONE,
        );
        sendBinaryControlMessage(messageUp);
        return; // Don't process 'm' keycode further
      }
    }

    // Determine if this is a non-printable/control key that needs keycode injection
    const isControlKey =
      event.key === 'Backspace' ||
      event.key === 'Delete' ||
      event.key === 'Enter' ||
      event.key === 'Tab' ||
      event.key === 'Escape' ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown' ||
      event.key === 'Insert' ||
      event.key.startsWith('Arrow') ||
      (event.key.startsWith('F') && event.key.length <= 3) ||
      event.key.startsWith('Shift') ||
      event.key.startsWith('Control') ||
      event.key.startsWith('Alt') ||
      event.key.startsWith('Meta') ||
      event.ctrlKey ||
      event.metaKey;

    if (isControlKey) {
      // Use keycode injection for control/navigation keys
      const keyInfo = getAndroidKeycodeAndMeta(event);
      if (keyInfo) {
        const { keycode, metaState } = keyInfo;
        const action = event.type === 'keydown' ? ANDROID_KEYS.ACTION_DOWN : ANDROID_KEYS.ACTION_UP;
        const message = createInjectKeycodeMessage(action, keycode, 0, metaState);
        sendBinaryControlMessage(message);
      }
    } else if (event.type === 'keydown' && event.key.length === 1) {
      // Use text injection for printable characters (supports Unicode, special chars, fast typing)
      const message = createInjectTextMessage(event.key);
      sendBinaryControlMessage(message);
    } else if (event.type === 'keydown') {
      // Fallback for other keydown events (Dead keys, etc.)
      const keyInfo = getAndroidKeycodeAndMeta(event);
      if (keyInfo) {
        const { keycode, metaState } = keyInfo;
        const message = createInjectKeycodeMessage(ANDROID_KEYS.ACTION_DOWN, keycode, 0, metaState);
        sendBinaryControlMessage(message);
      }
    }
    // keyup events for non-control keys are intentionally not sent
    // since we use text injection which doesn't need up/down pairs
  };

  return { handleInteraction, handleKeyboard };
}
