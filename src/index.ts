// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

// Components
export { DeviceStream } from './components/device-stream';
export {
  RemoteControl,
  type RemoteControlHandle,
  type ImperativeKeyboardEvent,
  type SystemButton,
} from './components/remote-control';
export { StreamStatusPill } from './components/stream-status-pill';
export { NavigationBar } from './components/navigation-bar';
export { Button, buttonVariants, type ButtonProps } from './components/ui/button';

// Hooks
export { useDeviceStream } from './hooks/use-device-stream';
export type { UseDeviceStreamOptions, UseDeviceStreamResult } from './hooks/use-device-stream';
export {
  useStreamSelfHeal,
  useDeviceGridSelfHeal,
} from './hooks/use-stream-self-heal';
export { useWebRtcConnection } from './hooks/use-webrtc-connection';
export { useScrcpyInput } from './hooks/use-scrcpy-input';

// Utilities
export { cn } from './lib/cn';

// Low-level scrcpy protocol helpers
export * from './webrtc-messages';
export {
  ANDROID_KEYS,
  AMOTION_EVENT,
  CONTROL_MSG_TYPE,
  codeMap,
} from './constants';
