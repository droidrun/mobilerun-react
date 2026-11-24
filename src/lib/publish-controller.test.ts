// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { deferred } from '../hooks/webrtc-test-fixture';
import { tick } from '../hooks/test-hook-runner';
import { FakeSchedule } from './test-clock';
import { PublishController } from './publish-controller';
import type { DevicePublishCapabilities, PublishErrorEvent, PublishOptions, PublishState } from './publish';

const capabilities: DevicePublishCapabilities = { microphoneInjection: true, cameraInjection: true, mediaInjectionTransport: 'direct' };
const uuid = '11111111-1111-4111-8111-111111111111';

function fixture(config: { capabilities?: DevicePublishCapabilities | null; camera?: boolean; offered?: boolean } = {}) {
  const clock = new FakeSchedule();
  const states: PublishState[] = [];
  const errors: PublishErrorEvent[] = [];
  const sent: object[] = [];
  const captures: MediaStreamConstraints[] = [];
  const attachments: { kind: string; track: unknown }[] = [];
  const media = deferred<MediaStream>();
  const pendingAttach = deferred();
  let captureResult = media.promise;
  let holdAudio = false;
  let failVideo = false;
  let stopThrows = false;
  class Track extends EventTarget {
    readyState = 'live';
    stops = 0;
    constructor(readonly kind: string) { super(); }
    stop() { this.stops++; this.readyState = 'ended'; }
  }
  const audio = new Track('audio');
  const video = new Track('video');
  const stream = { getTracks: () => config.camera ? [audio, video] : [audio] } as unknown as MediaStream;
  const transceiver = (kind: string) => ({
    currentDirection: 'sendonly',
    sender: { async replaceTrack(track: unknown) {
      attachments.push({ kind, track });
      if (track && kind === 'audio' && holdAudio) await pendingAttach.promise;
      if (track && kind === 'video' && failVideo) throw new Error('attach');
    } },
  } as unknown as RTCRtpTransceiver);
  const reservations = { transceivers: { audio: transceiver('audio'), video: transceiver('video') }, offered: new Set<'audio' | 'video'>(config.offered === false ? [] : ['audio', 'video']) };
  const socket = { readyState: 1, send(data: string) {
    const frame = JSON.parse(data);
    if (stopThrows && frame.type === 'stopPublish') throw new Error('closed');
    sent.push(frame);
  } } as unknown as WebSocket;
  const peer = { connectionState: 'connected' } as RTCPeerConnection;
  let nextId = 0;
  const controller = new PublishController({
    onState: state => states.push(state), onError: error => errors.push(error),
    capture: constraints => { captures.push(constraints); return captureResult; },
    uuid: () => nextId++ === 0 ? uuid : '22222222-2222-4222-8222-222222222222',
    setTimer: clock.setTimeout, clearTimer: timer => { if (timer !== undefined) clock.clearTimeout(timer); },
  });
  const caps = config.capabilities === null ? undefined : config.capabilities ?? capabilities;
  const bind = () => controller.bind({ socket, peer, capabilities: caps, reservations });
  bind();
  const signal = (state: string, reason?: unknown, id = uuid, source = socket) => controller.handle(source, { type: 'publishState', mediaSessionId: id, state, reason });
  const start = async (options: PublishOptions = { audio: true }) => {
    const result = controller.start(options);
    const outcome = result.catch(error => error);
    media.resolve(stream);
    await tick();
    return { result, outcome };
  };
  return { controller, clock, states, errors, sent, captures, attachments, media, audio, video, stream, reservations, socket, peer, bind, signal, start,
    freshMedia() {
      const track = new Track('audio');
      captureResult = Promise.resolve({ getTracks: () => [track] } as unknown as MediaStream);
      return track;
    },
    holdAudio() { holdAudio = true; }, releaseAudio() { pendingAttach.resolve(); }, failVideo() { failVideo = true; }, stopThrows() { stopThrows = true; } };
}

describe('publish wire and state', () => {
  test('accepted authorizes audio then video; active waits for attachment and stop preserves viewing', async () => {
    const f = fixture({ camera: true });
    expect(f.controller.getState()).toEqual({ phase: 'idle', mediaSessionId: null, kinds: [] });
    const { result } = await f.start({ audio: true, video: true });
    expect(f.sent).toEqual([{ type: 'publishStart', mediaSessionId: uuid, kinds: ['audio', 'video'] }]);
    expect(f.attachments).toEqual([]);
    f.holdAudio();
    f.signal('accepted');
    f.signal('active');
    await tick();
    expect(f.controller.getState().phase).toBe('accepted');
    expect(f.attachments).toEqual([{ kind: 'audio', track: f.audio }]);
    f.releaseAudio();
    await tick();
    expect(await result).toEqual({ phase: 'active', mediaSessionId: uuid, kinds: ['audio', 'video'] });
    expect(f.states.map(state => state.phase)).toEqual(['capturing', 'starting', 'accepted', 'active']);
    expect(f.attachments).toEqual([{ kind: 'audio', track: f.audio }, { kind: 'video', track: f.video }]);
    await f.controller.stop();
    await f.controller.stop();
    expect(f.controller.getState()).toEqual({ phase: 'stopped', mediaSessionId: uuid, kinds: ['audio', 'video'], reason: 'stopped_by_client' });
    expect(f.sent).toEqual([{ type: 'publishStart', mediaSessionId: uuid, kinds: ['audio', 'video'] }, { type: 'stopPublish', mediaSessionId: uuid }]);
    expect(f.audio.stops).toBe(1);
    expect(f.video.stops).toBe(1);
    expect(f.peer.connectionState).toBe('connected');
    expect(f.errors).toEqual([]);
    expect(f.clock.pendingCount).toBe(0);
    expect(Object.isFrozen(f.states[0].kinds)).toBe(true);
  });

  test('active alone accepts once and ignores duplicate and foreign messages', async () => {
    const f = fixture();
    const { result } = await f.start();
    f.signal('active', undefined, 'foreign');
    f.signal('active', undefined, uuid, {} as WebSocket);
    f.controller.handle(f.socket, { type: 'publishState', mediaSessionId: uuid, state: 'unknown' });
    expect(f.attachments).toEqual([]);
    f.signal('active');
    f.signal('accepted');
    f.signal('active');
    await result;
    expect(f.states.map(state => state.phase)).toEqual(['capturing', 'starting', 'accepted', 'active']);
    expect(f.attachments).toEqual([{ kind: 'audio', track: f.audio }]);
    await f.controller.stop();
    f.signal('active');
    expect(f.controller.getState().phase).toBe('stopped');
  });

  test.each([
    ['forbidden', 'publish_not_allowed', undefined], ['unsupported', 'publish_unsupported', undefined],
    ['busy', 'publish_busy', undefined], ['inject_failed', 'publish_failed', undefined],
    ['source_lost', 'publish_failed', undefined], ['connection_closed', 'disconnected', undefined],
    ['stopped_by_client', 'publish_failed', 'remote_stop'], ['unknown', 'publish_failed', undefined],
    ['toString', 'publish_failed', undefined], [undefined, 'publish_failed', undefined], [42, 'publish_failed', undefined],
  ])('terminal server reason %s maps to %s', async (reason, expected, detail) => {
    const f = fixture();
    const { outcome } = await f.start();
    f.signal('rejected', reason);
    f.signal('error', reason);
    const failure = await outcome;
    expect(failure.reason).toBe(expected);
    expect(failure.detail).toBe(detail);
    expect(failure.serverReason).toBe(typeof reason === 'string' ? reason : undefined);
    expect(f.controller.getState()).toMatchObject({ phase: 'error', reason: expected });
    expect(f.errors).toHaveLength(1);
    expect(f.audio.stops).toBe(1);
    expect(f.attachments.filter(call => call.track !== null)).toEqual([]);
    expect(f.sent[1]).toEqual({ type: 'stopPublish', mediaSessionId: uuid });
    expect(f.clock.pendingCount).toBe(0);
  });

  test('silence is unsupported exactly at 5 seconds and late active cannot attach', async () => {
    const f = fixture();
    const { outcome } = await f.start();
    f.clock.advance(4999);
    expect(f.controller.getState().phase).toBe('starting');
    f.clock.advance(1);
    expect(await outcome).toMatchObject({ reason: 'publish_unsupported', detail: 'response_timeout' });
    f.signal('active');
    await tick();
    expect(f.audio.stops).toBe(1);
    expect(f.attachments.filter(call => call.track !== null)).toEqual([]);
  });

  test('acceptance has its own 15-second deadline, which duplicates do not extend', async () => {
    const f = fixture();
    const { outcome } = await f.start();
    f.clock.advance(4999);
    f.signal('accepted');
    await tick();
    f.clock.advance(14999);
    f.signal('accepted');
    expect(f.controller.getState().phase).toBe('accepted');
    f.clock.advance(1);
    expect(await outcome).toMatchObject({ reason: 'publish_timeout', detail: 'active_timeout' });
    expect(f.audio.stops).toBe(1);
    expect(f.clock.pendingCount).toBe(0);
  });

  test('a concurrent start preserves the first operation; a new explicit start uses a fresh UUID', async () => {
    const f = fixture();
    const { result } = await f.start();
    const pending = f.controller.getState();
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'publish_failed', detail: 'publish_in_progress' });
    expect(f.controller.getState()).toBe(pending);
    f.signal('active');
    await result;
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'publish_failed', detail: 'already_publishing' });
    expect(f.captures).toHaveLength(1);
    await f.controller.stop();
    f.freshMedia();
    const { outcome } = await f.start();
    expect(f.sent[2]).toEqual({ type: 'publishStart', mediaSessionId: '22222222-2222-4222-8222-222222222222', kinds: ['audio'] });
    f.signal('active'); // old UUID cannot affect the replacement
    expect(f.controller.getState().phase).toBe('starting');
    await f.controller.stop();
    expect(await outcome).toMatchObject({ reason: 'publish_cancelled' });
  });
});

describe('publish local guards and capture', () => {
  test.each([{ audio: false }, { audio: false, video: true }, {}, { audio: true, video: 'yes' }])('audio-required validation: %j', async options => {
    const f = fixture();
    await expect(f.controller.start(options as PublishOptions)).rejects.toMatchObject({ reason: 'publish_failed', detail: 'invalid_options' });
    expect(f.captures).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test.each([
    [null, 'capabilities_unavailable'],
    [{ ...capabilities, microphoneInjection: false }, 'device_capability'],
    [{ ...capabilities, mediaInjectionTransport: 'relay' }, 'device_capability'],
    [{ ...capabilities, cameraInjection: false }, 'device_capability'],
  ] as const)('capability guard %j', async (caps, detail) => {
    const f = fixture({ capabilities: caps });
    await expect(f.controller.start({ audio: true, video: true })).rejects.toMatchObject({ reason: 'publish_unsupported', detail });
    expect(f.captures).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test('a disconnected viewer fails before capture even with support', async () => {
    const f = fixture();
    f.controller.disconnect();
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'disconnected', detail: 'not_connected' });
    expect(f.captures).toEqual([]);
  });

  test('missing SSRC/codec reservations fail locally without capture', async () => {
    const f = fixture({ offered: false });
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'publish_unsupported', detail: 'local_media_support' });
    expect(f.captures).toEqual([]);
  });

  test('a rejected upstream answer still allows explicit forbidden to be authoritative', async () => {
    const f = fixture();
    Object.defineProperty(f.reservations.transceivers.audio, 'currentDirection', { value: 'inactive' });
    const { outcome } = await f.start();
    f.signal('rejected', 'forbidden');
    expect(await outcome).toMatchObject({ reason: 'publish_not_allowed' });
    expect(f.attachments.filter(call => call.track !== null)).toEqual([]);
  });

  test('accepted with an inactive sender is unsupported, never not allowed', async () => {
    const f = fixture();
    Object.defineProperty(f.reservations.transceivers.audio, 'currentDirection', { value: 'inactive' });
    const { outcome } = await f.start();
    f.signal('accepted');
    expect(await outcome).toMatchObject({ reason: 'publish_unsupported', detail: 'negotiated_sender' });
    expect(f.audio.stops).toBe(1);
  });

  test.each([['NotAllowedError', 'permission_denied', 'capture_permission'], ['SecurityError', 'permission_denied', 'capture_permission'], ['NotReadableError', 'publish_failed', 'capture_unavailable'], ['AbortError', 'publish_failed', 'capture_unavailable']])('capture %s is %s', async (name, reason, detail) => {
    const f = fixture();
    const result = f.controller.start({ audio: true });
    f.media.reject(Object.assign(new Error('capture'), { name }));
    await expect(result).rejects.toMatchObject({ reason, detail });
    expect(f.sent).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });

  test('a partial camera capture stops the microphone without signaling', async () => {
    const f = fixture();
    const { outcome } = await f.start({ audio: true, video: true });
    expect(await outcome).toMatchObject({ reason: 'publish_failed', detail: 'capture_unavailable' });
    expect(f.audio.stops).toBe(1);
    expect(f.sent).toEqual([]);
  });
});

describe('publish cancellation and teardown', () => {
  test('stop during permission capture rejects start, then stops late tracks without attaching', async () => {
    const f = fixture();
    const result = f.controller.start({ audio: true });
    const failure = result.catch(error => error);
    f.clock.advance(60000); // permission prompts do not consume the response deadline
    expect(f.controller.getState().phase).toBe('capturing');
    await f.controller.stop();
    expect(await failure).toMatchObject({ reason: 'publish_cancelled' });
    f.media.resolve(f.stream);
    await tick();
    expect(f.audio.stops).toBe(1);
    expect(f.sent).toEqual([]);
    expect(f.attachments).toEqual([]);
    expect(f.errors).toEqual([]);
  });

  test('late attachment is detached before a subsequent operation can attach', async () => {
    const f = fixture();
    f.holdAudio();
    const { outcome } = await f.start();
    f.signal('accepted');
    await tick();
    const stopped = f.controller.stop();
    expect(f.audio.stops).toBe(1);
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'publish_failed', detail: 'publish_in_progress' });
    f.releaseAudio();
    await stopped;
    const nextAudio = f.freshMedia();
    const next = f.controller.start({ audio: true });
    const nextOutcome = next.catch(error => error);
    await tick();
    f.signal('active', undefined, '22222222-2222-4222-8222-222222222222');
    expect(await outcome).toMatchObject({ reason: 'publish_cancelled' });
    expect(await nextOutcome).toMatchObject({ phase: 'active', mediaSessionId: '22222222-2222-4222-8222-222222222222' });
    expect(f.attachments).toEqual([{ kind: 'audio', track: f.audio }, { kind: 'audio', track: null }, { kind: 'audio', track: null }, { kind: 'audio', track: nextAudio }]);
    await f.controller.stop();
  });

  test('video attachment failure releases the already-attached audio', async () => {
    const f = fixture({ camera: true });
    f.failVideo();
    const { outcome } = await f.start({ audio: true, video: true });
    f.signal('active');
    expect(await outcome).toMatchObject({ reason: 'publish_failed', detail: 'attach_failed' });
    await tick();
    expect(f.audio.stops).toBe(1);
    expect(f.video.stops).toBe(1);
    expect(f.attachments.slice(-2)).toEqual([{ kind: 'audio', track: null }, { kind: 'video', track: null }]);
  });

  test('disconnect releases capture; replacement never resumes it', async () => {
    const f = fixture();
    const { result } = await f.start();
    f.signal('active');
    await result;
    f.controller.disconnect();
    await tick();
    expect(f.audio.stops).toBe(1);
    expect(f.attachments.at(-1)).toEqual({ kind: 'audio', track: null });
    expect(f.errors[0]).toMatchObject({ reason: 'disconnected', mediaSessionId: uuid });
    f.bind();
    await tick();
    expect(f.captures).toHaveLength(1);
    expect(f.sent).toEqual([{ type: 'publishStart', mediaSessionId: uuid, kinds: ['audio'] }, { type: 'stopPublish', mediaSessionId: uuid }]);
    expect(f.clock.pendingCount).toBe(0);
  });

  test('ended capture terminates the entire audio/video publication', async () => {
    const f = fixture({ camera: true });
    const { result } = await f.start({ audio: true, video: true });
    f.signal('active');
    await result;
    f.video.dispatchEvent(new Event('ended'));
    await tick();
    expect(f.audio.stops).toBe(1);
    expect(f.video.stops).toBe(1);
    expect(f.errors).toEqual([{ reason: 'publish_failed', message: 'A local input stopped', detail: 'capture_unavailable', mediaSessionId: uuid }]);
  });

  test('a failing stop write cannot hold capture open', async () => {
    const f = fixture();
    const { result } = await f.start();
    f.signal('active');
    await result;
    f.stopThrows();
    await f.controller.stop();
    expect(f.audio.stops).toBe(1);
    expect(f.attachments.at(-1)).toEqual({ kind: 'audio', track: null });
    expect(f.errors).toEqual([]);
    expect(f.clock.pendingCount).toBe(0);
  });

  test('dispose stops capture, closes methods and prevents later callbacks', async () => {
    const f = fixture();
    const { result } = await f.start();
    f.signal('active');
    await result;
    const count = f.states.length;
    f.controller.dispose();
    await tick();
    await expect(f.controller.start({ audio: true })).rejects.toMatchObject({ reason: 'disconnected', detail: 'session_closed' });
    expect(f.audio.stops).toBe(1);
    expect(f.attachments.at(-1)).toEqual({ kind: 'audio', track: null });
    expect(f.states).toHaveLength(count);
    expect(f.errors).toEqual([]);
  });
});
