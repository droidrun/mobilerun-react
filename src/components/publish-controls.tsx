'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useRef } from 'react';
import { Mic, Video } from 'lucide-react';
import type { DeviceStreamLabels } from '../lib/stream-error';
import { supportsPublish, type DevicePublishCapabilities, type PublishOptions, type PublishState, type PublishKind } from '../lib/publish';

export type PublishControlsProps = {
  capabilities?: DevicePublishCapabilities;
  offeredKinds: readonly PublishKind[];
  hidden?: boolean;
  connected: boolean;
  state: PublishState;
  labels: DeviceStreamLabels;
  start: (options: PublishOptions) => Promise<PublishState>;
  stop: () => Promise<void>;
};

/** Floating over the stream; input control/view-only decisions stay server-owned. */
export function PublishControls({ capabilities, offeredKinds, hidden, connected, state, labels, start, stop }: PublishControlsProps) {
  const [changing, setChanging] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const [dimmed, setDimmed] = useState(false);
  const visible = !hidden && supportsPublish(capabilities) && offeredKinds.includes('audio') && state.reason !== 'publish_unsupported';
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout>;
    const restore = () => {
      setDimmed(false);
      clearTimeout(timer);
      timer = setTimeout(() => setDimmed(true), 3000);
    };
    const nearby = (event: Event) => {
      const point = 'touches' in event ? (event as TouchEvent).touches[0] : event as PointerEvent;
      const rect = root.current?.getBoundingClientRect();
      if (point && rect && point.clientX >= rect.left - 48 && point.clientX <= rect.right + 48
        && point.clientY >= rect.top - 48 && point.clientY <= rect.bottom + 48) restore();
    };
    const names = ['pointermove', 'pointerdown', 'touchstart', 'touchmove'];
    restore();
    names.forEach(name => window.addEventListener(name, nearby, { capture: true, passive: true }));
    root.current?.addEventListener('focusin', restore);
    const element = root.current;
    return () => {
      clearTimeout(timer);
      names.forEach(name => window.removeEventListener(name, nearby, true));
      element?.removeEventListener('focusin', restore);
    };
  }, [visible]);
  if (!visible) return null;
  const pending = changing || ['capturing', 'starting', 'accepted'].includes(state.phase);
  const live = state.phase === 'active';
  const cameraLive = live && state.kinds.includes('video');
  const cameraSupported = capabilities?.cameraInjection === true && offeredKinds.includes('video');
  const status = pending ? labels.publishStarting : state.phase === 'error'
    ? state.reason === 'permission_denied' ? labels.publishPermissionDenied
      : state.reason === 'publish_not_allowed' ? labels.publishNotAllowed : labels.publishFailed
    : undefined;
  const toggle = async (camera: boolean) => {
    setChanging(true);
    try {
      if (live) await stop();
      if (camera || !live) await start({ audio: true, video: camera && !cameraLive });
    } catch { /* The controller reports the typed failure via state and onError. */ }
    finally { setChanging(false); }
  };
  return (
    <div ref={root} className="mr-publish-controls" data-dimmed={dimmed}>
      {status && <span className="mr-publish-status" role="status">{status}</span>}
      <div className="mr-publish-pill">
        <button type="button" aria-label={(live ? labels.stopMicrophone : labels.microphone)} title={(live ? labels.stopMicrophone : labels.microphone)}
          aria-pressed={live} disabled={!connected || pending} onClick={() => { void toggle(false); }}>
          <Mic size={18} aria-hidden="true" />
        </button>
        {cameraSupported && <button type="button" aria-label={(cameraLive ? labels.stopCamera : labels.camera)} title={(cameraLive ? labels.stopCamera : labels.camera)}
          aria-pressed={cameraLive} disabled={!connected || pending} onClick={() => { void toggle(true); }}>
          <Video size={18} aria-hidden="true" />
        </button>}
      </div>
    </div>
  );
}
