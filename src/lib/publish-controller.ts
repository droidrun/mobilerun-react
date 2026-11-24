// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import {
  INITIAL_PUBLISH_STATE, PublishError, supportsPublish,
  type DevicePublishCapabilities, type PublishErrorEvent, type PublishFailure,
  type PublishKind, type PublishOptions, type PublishState,
} from './publish';
import { usablePublishSender, type PublishReservations } from './publish-media';

type Binding = {
  socket: WebSocket;
  peer: RTCPeerConnection;
  capabilities?: DevicePublishCapabilities;
  reservations: PublishReservations;
};
type Operation = {
  binding: Binding;
  kinds: PublishKind[];
  id: string | null;
  stream?: MediaStream;
  sent: boolean;
  accepted: boolean;
  active: boolean;
  attached: boolean;
  timer?: ReturnType<typeof setTimeout>;
  ended?: () => void;
  sendFailed?: boolean;
  resolve: (state: PublishState) => void;
  reject: (error: PublishError) => void;
};
type Options = {
  onState: (state: PublishState) => void;
  onError: (error: PublishErrorEvent) => void;
  capture?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  uuid?: () => string;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout> | undefined) => void;
};

/** One operation per viewer. All sender mutations share a queue across operations. */
export class PublishController {
  private binding?: Binding;
  private capabilities?: DevicePublishCapabilities;
  private operation?: Operation;
  private ending?: Promise<void>;
  private closed = false;
  private state = INITIAL_PUBLISH_STATE;
  private mutations: Promise<void> = Promise.resolve();
  private readonly setTimer;
  private readonly clearTimer;
  constructor(private readonly options: Options) {
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? (timer => clearTimeout(timer));
  }
  getState = (): PublishState => this.state;
  open(capabilities?: DevicePublishCapabilities): void { this.closed = false; this.capabilities = capabilities; }
  bind(binding: Binding): void {
    this.disconnect();
    this.binding = binding;
    this.capabilities = binding.capabilities;
  }
  disconnect(): void {
    const op = this.operation;
    this.binding = undefined;
    if (op) void this.fail(op, { reason: 'disconnected', message: 'Publishing connection closed' });
  }
  async replace(): Promise<void> {
    const op = this.operation;
    this.binding = undefined;
    if (op) await this.fail(op, { reason: 'disconnected', message: 'Publishing connection closed' });
    this.closed = true;
  }
  dispose(): void {
    this.closed = true;
    this.binding = undefined;
    void this.stop();
  }
  private emit(state: PublishState): void {
    this.state = Object.freeze({ ...state, kinds: Object.freeze([...state.kinds]) as unknown as PublishKind[] });
    if (!this.closed) this.options.onState(this.state);
  }
  private current(op: Operation): boolean { return this.operation === op && this.binding === op.binding && !this.closed; }
  private report(failure: PublishFailure, id?: string | null): PublishError {
    if (!this.closed) this.options.onError({ ...failure, ...(id ? { mediaSessionId: id } : {}) });
    return new PublishError(failure);
  }
  private invalid(failure: PublishFailure, kinds: PublishKind[], preserve = false): Promise<never> {
    if (!preserve) this.emit({ phase: 'error', mediaSessionId: null, kinds, ...failure });
    return Promise.reject(this.report(failure));
  }
  start = (options: PublishOptions): Promise<PublishState> => {
    if (this.operation || this.ending) return this.invalid({ reason: 'publish_failed', message: 'Publishing is already in progress',
      detail: this.operation && this.state.phase === 'active' ? 'already_publishing' : 'publish_in_progress' }, [], true);
    const kinds: PublishKind[] = options?.video === true ? ['audio', 'video'] : ['audio'];
    if (this.closed) return this.invalid({ reason: 'disconnected', message: 'The session is closed', detail: 'session_closed' }, []);
    if (options?.audio !== true || (options.video !== undefined && typeof options.video !== 'boolean')) {
      return this.invalid({ reason: 'publish_failed', message: 'Microphone audio is required', detail: 'invalid_options' }, []);
    }
    const binding = this.binding;
    const capabilities = this.capabilities;
    if (!capabilities) return this.invalid({ reason: 'publish_unsupported', message: 'Publish capabilities are unavailable', detail: 'capabilities_unavailable' }, kinds);
    if (!supportsPublish(capabilities) || (options.video && !capabilities.cameraInjection)) {
      return this.invalid({ reason: 'publish_unsupported', message: 'The device does not support these inputs', detail: 'device_capability' }, kinds);
    }
    if (!binding || binding.socket.readyState !== 1 || binding.peer.connectionState !== 'connected') {
      return this.invalid({ reason: 'disconnected', message: 'The viewer is not connected', detail: 'not_connected' }, kinds);
    }
    if ((!this.options.capture && (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia))
      || kinds.some(kind => !binding.reservations.offered.has(kind))) {
      return this.invalid({ reason: 'publish_unsupported', message: 'Local media publishing is unsupported', detail: 'local_media_support' }, kinds);
    }
    const promise = new Promise<PublishState>((resolve, reject) => {
      const op: Operation = { binding, kinds, id: null, sent: false, accepted: false, active: false, attached: false, resolve, reject };
      this.operation = op;
      try {
        op.id = (this.options.uuid ?? (() => crypto.randomUUID()))();
        this.emit({ phase: 'starting', mediaSessionId: op.id, kinds });
        if (!this.current(op)) return;
        op.sent = true;
        op.timer = this.setTimer(() => { void this.fail(op, { reason: 'publish_unsupported', message: 'The device did not answer the publish request', detail: 'response_timeout' }); }, 5000);
        binding.socket.send(JSON.stringify({ type: 'publishStart', mediaSessionId: op.id, kinds }));
      } catch {
        void this.fail(op, { reason: 'disconnected', message: 'Publishing connection closed' });
      }
    });
    return promise;
  };
  private async capture(op: Operation): Promise<void> {
    try {
      const constraints: MediaStreamConstraints = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: op.kinds.includes('video') ? { width: { ideal: 1280, max: 1280 }, height: { ideal: 720, max: 720 }, frameRate: { ideal: 24, max: 30 } } : false,
      };
      const stream = await (this.options.capture?.(constraints) ?? navigator.mediaDevices.getUserMedia(constraints));
      if (!this.current(op)) { stream.getTracks().forEach(track => track.stop()); return; }
      op.stream = stream;
      if (op.kinds.some(kind => !stream.getTracks().some(track => track.kind === kind && track.readyState === 'live'))) {
        throw new Error('Missing live capture track');
      }
      op.ended = () => { void this.fail(op, { reason: 'publish_failed', message: 'A local input stopped', detail: 'capture_unavailable' }); };
      stream.getTracks().forEach(track => track.addEventListener('ended', op.ended!));
      await this.attach(op);
    } catch (error) {
      const name = error && typeof error === 'object' && 'name' in error ? error.name : undefined;
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      await this.fail(op, { reason: denied ? 'permission_denied' : 'publish_failed',
        message: denied ? 'Microphone or camera permission was denied' : 'Local capture is unavailable', detail: denied ? 'capture_permission' : 'capture_unavailable' });
    }
  }
  handle(socket: WebSocket, message: unknown): void {
    const op = this.operation;
    if (!op || !this.current(op) || socket !== op.binding.socket || !op.sent || !message || typeof message !== 'object') return;
    const frame = message as Record<string, unknown>;
    if (frame.type !== 'publishState' || typeof frame.mediaSessionId !== 'string' || frame.mediaSessionId !== op.id
      || !['accepted', 'active', 'rejected', 'error', 'stopped'].includes(String(frame.state)) || typeof frame.state !== 'string') return;
    if (frame.state === 'accepted' || frame.state === 'active') {
      if (frame.state === 'active') op.active = true;
      if (!op.accepted) {
        op.accepted = true;
        this.clearTimer(op.timer);
        op.timer = this.setTimer(() => { void this.fail(op, { reason: 'publish_timeout', message: 'Publishing did not become active', detail: 'active_timeout' }); }, 30000);
        this.emit({ phase: 'accepted', mediaSessionId: op.id, kinds: op.kinds });
        if (this.current(op)) {
          this.emit({ phase: 'capturing', mediaSessionId: op.id, kinds: op.kinds });
          if (this.current(op)) void this.capture(op);
        }
      }
      this.complete(op);
      return;
    }
    const serverReason = typeof frame.reason === 'string' ? frame.reason : undefined;
    const reasons: Record<string, PublishFailure['reason']> = {
      forbidden: 'publish_not_allowed', unsupported: 'publish_unsupported', busy: 'publish_busy', connection_closed: 'disconnected',
    };
    void this.fail(op, { reason: serverReason && Object.hasOwn(reasons, serverReason) ? reasons[serverReason]! : 'publish_failed', message: 'The device stopped or refused publishing',
      ...(serverReason ? { serverReason } : {}), ...(serverReason === 'stopped_by_client' ? { detail: 'remote_stop' } : {}) });
  }
  private async attach(op: Operation): Promise<void> {
    try {
      for (const kind of op.kinds) {
        const sender = usablePublishSender(op.binding.reservations, kind);
        if (!sender) { await this.fail(op, { reason: 'publish_unsupported', message: 'The negotiated sender is unavailable', detail: 'negotiated_sender' }); return; }
        const track = op.stream!.getTracks().find(track => track.kind === kind)!;
        await this.mutate(async () => {
          if (!this.current(op)) return;
          await sender.replaceTrack(track);
          if (!this.current(op)) { track.stop(); await sender.replaceTrack(null); }
        });
        if (!this.current(op)) return;
      }
      op.attached = true;
      this.complete(op);
    } catch {
      await this.fail(op, { reason: 'publish_failed', message: 'Could not attach local inputs', detail: 'attach_failed' });
    }
  }
  private complete(op: Operation): void {
    if (!this.current(op) || !op.active || !op.attached || this.state.phase === 'active') return;
    this.clearTimer(op.timer);
    this.emit({ phase: 'active', mediaSessionId: op.id, kinds: op.kinds });
    op.resolve(this.state);
  }
  private mutate(fn: () => Promise<void>): Promise<void> {
    const next = this.mutations.then(fn);
    this.mutations = next.catch(() => {});
    return next;
  }
  private teardown(op: Operation): Promise<void> {
    this.operation = undefined; // invalidate before any asynchronous cleanup
    this.clearTimer(op.timer);
    op.stream?.getTracks().forEach(track => { if (op.ended) track.removeEventListener('ended', op.ended); track.stop(); });
    if (op.sent && op.binding.socket.readyState === 1) {
      try { op.binding.socket.send(JSON.stringify({ type: 'stopPublish', mediaSessionId: op.id })); } catch { op.sendFailed = true; }
    }
    const cleanup = !op.accepted ? Promise.resolve() : this.mutate(async () => {
      for (const kind of op.kinds) {
        try { await op.binding.reservations.transceivers[kind]?.sender.replaceTrack(null); } catch { /* closed peer */ }
      }
    });
    this.ending = cleanup;
    return cleanup;
  }
  private async fail(op: Operation, failure: PublishFailure): Promise<void> {
    if (this.operation !== op) return;
    await this.teardown(op);
    this.ending = undefined;
    if (op.sendFailed) failure = { reason: 'disconnected', message: 'Publishing connection closed' };
    this.emit({ phase: 'error', mediaSessionId: op.id, kinds: op.kinds, ...failure });
    op.reject(this.report(failure, op.id));
  }
  stop = async (): Promise<void> => {
    const op = this.operation;
    if (!op) { await this.ending; return; }
    await this.teardown(op);
    this.ending = undefined;
    if (op.sendFailed) {
      const failure: PublishFailure = { reason: 'disconnected', message: 'Publishing connection closed' };
      this.emit({ phase: 'error', mediaSessionId: op.id, kinds: op.kinds, ...failure });
      op.reject(this.report(failure, op.id));
      return;
    }
    this.emit({ phase: 'stopped', mediaSessionId: op.id, kinds: op.kinds, reason: 'stopped_by_client' });
    op.reject(new PublishError({ reason: 'publish_cancelled', message: 'Publishing was cancelled' }));
  };
}
