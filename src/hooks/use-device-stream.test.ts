// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { expect, mock, test } from 'bun:test';
import { fetchDeviceInfo } from './use-device-stream';

const info = { streamUrl: 'wss://stream.example/ws', streamToken: 'tok', state: 'ready' } as never;

test('fetchDeviceInfo with a client retrieves by device id', async () => {
  const retrieve = mock(async (_id: string) => info);
  const client = { devices: { retrieve } } as never;
  expect(await fetchDeviceInfo({ client, deviceId: 'dev_1' })).toBe(info);
  expect(retrieve).toHaveBeenCalledWith('dev_1');
});

test('fetchDeviceInfo with a device object refreshes that device', async () => {
  const refresh = mock(async () => info);
  expect(await fetchDeviceInfo({ device: { id: 'dev_1', refresh } })).toBe(info);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test('a device object wins when both sources are given', async () => {
  const retrieve = mock(async () => ({}) as never);
  const refresh = mock(async () => info);
  const client = { devices: { retrieve } } as never;
  await fetchDeviceInfo({ client, deviceId: 'dev_2', device: { id: 'dev_1', refresh } });
  expect(retrieve).not.toHaveBeenCalled();
});
