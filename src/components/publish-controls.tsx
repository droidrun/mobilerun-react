'use client';
// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react';
import { Mic, Video } from 'lucide-react';
import type { DeviceStreamLabels } from '../lib/stream-error';
import { supportsPublish, type DevicePublishCapabilities, type PublishOptions, type PublishState } from '../lib/publish';
import { supportsPublishCamera } from '../lib/publish-media';

export type PublishControlsProps = {
  capabilities?: DevicePublishCapabilities;
  hidden?: boolean;
  connected: boolean;
  state: PublishState;
  labels: DeviceStreamLabels;
  start: (options: PublishOptions) => Promise<PublishState>;
  stop: () => Promise<void>;
};

/** Floating over the stream; input control/view-only decisions stay server-owned. */
export function PublishControls({ capabilities, hidden, connected, state, labels, start, stop }: PublishControlsProps) {
  const [changing, setChanging] = useState(false);
  const [cameraEncoder, setCameraEncoder] = useState(false);
  useEffect(() => { setCameraEncoder(supportsPublishCamera()); }, []);
  if (hidden || !supportsPublish(capabilities)) return null;
  const pending = changing || ['capturing', 'starting', 'accepted'].includes(state.phase);
  const live = state.phase === 'active';
  const cameraLive = live && state.kinds.includes('video');
  const cameraSupported = capabilities?.cameraInjection === true && cameraEncoder;
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
    <div className="mr-publish-controls" onPointerDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()}>
      {status && <span className="mr-publish-status" role="status">{status}</span>}
      <div className="mr-publish-pill">
        <button type="button" aria-label={labels.publishMicrophone} title={labels.publishMicrophone}
          aria-pressed={live} disabled={!connected || pending} onClick={() => { void toggle(false); }}>
          <Mic size={18} aria-hidden="true" />
        </button>
        {cameraSupported && <button type="button" aria-label={labels.publishCamera} title={labels.publishCamera}
          aria-pressed={cameraLive} disabled={!connected || pending} onClick={() => { void toggle(true); }}>
          <Video size={18} aria-hidden="true" />
        </button>}
      </div>
    </div>
  );
}
