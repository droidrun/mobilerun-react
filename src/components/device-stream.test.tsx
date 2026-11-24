// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveDeviceStreamLabels } from '../lib/stream-error';
import { DeviceStream } from './device-stream';
import { StreamUnavailable } from './stream-unavailable';

const custom = { unavailable: 'Telefon nicht erreichbar', retry: 'Nochmal', connecting: 'Verbinde', disconnected: 'Getrennt' };

describe('labels', () => {
  test('defaults stay English and an undefined override falls back', () => {
    expect(resolveDeviceStreamLabels()).toEqual({
      connecting: 'connecting',
      disconnected: 'reconnecting',
      unavailable: 'device stream unavailable',
      retry: 'Retry',
      publishMicrophone: 'Microphone',
      publishCamera: 'Camera',
      publishStarting: 'Starting inputs',
      publishPermissionDenied: 'Microphone or camera permission denied',
      publishNotAllowed: 'Publishing is not allowed',
      publishFailed: 'Unable to publish inputs',
    });
    expect(resolveDeviceStreamLabels({ retry: undefined, unavailable: 'x' })).toMatchObject({ retry: 'Retry', unavailable: 'x' });
  });

  test('the idle and the connecting pill come from labels', () => {
    const idle = renderToStaticMarkup(<DeviceStream hasControl labels={custom} />);
    expect(idle).toContain('Verbinde');
    expect(idle).not.toContain('>connecting<');
    const connecting = renderToStaticMarkup(<DeviceStream hasControl streamUrl="wss://example.invalid/s" tokenProvider={async () => 'k'} labels={custom} />);
    expect(connecting).toContain('Verbinde');
    expect(connecting).not.toContain('>connecting<');
  });

  test('an explicit placeholderLabel still wins over labels.connecting', () => {
    expect(renderToStaticMarkup(<DeviceStream hasControl placeholderLabel="booting" labels={custom} />)).toContain('booting');
  });

  test('the unavailable view renders both strings from labels with no English left', () => {
    const html = renderToStaticMarkup(<StreamUnavailable labels={custom} onRetry={() => {}} />);
    expect(html).toContain('Telefon nicht erreichbar');
    expect(html).toContain('Nochmal');
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('unavailable');
  });

  test('the Retry button sets a foreground color of its own', () => {
    const html = renderToStaticMarkup(<StreamUnavailable labels={resolveDeviceStreamLabels()} onRetry={() => {}} />);
    expect(html).toMatch(/<button[^>]*class="[^"]*\btext-foreground\b/);
  });
});

test('the component root carries the class the scoped CSS variables hang on', () => {
  expect(renderToStaticMarkup(<DeviceStream hasControl />)).toContain('mobilerun-device-stream');
});
