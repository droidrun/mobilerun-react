// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0

import Mobilerun from '@mobilerun/sdk';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// Import straight from source so Bun transpiles + HMRs the package as you edit.
import { DeviceStream, NavigationBar, useDeviceStream, type RemoteControlHandle } from '../src/index';
// Prebuilt themed stylesheet (run `bun run build:css` once to generate it).
import '../dist/styles.css';
// Brand mark (black) — inverted to white in dark mode via CSS.
import logoUrl from '../assets/mobilerun-logo.png';

// ---------------------------------------------------------------------------
// Harness chrome styling. Lives here so the example stays self-contained; it's
// deliberately separate from the package's own styles (../dist/styles.css).
// ---------------------------------------------------------------------------
const HARNESS_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; }
  /* Cloud app theme tokens. Uses the SAME variable names the package reads
   * (--background, --card, --muted-foreground, --border, --primary, ...), so
   * the embedded DeviceStream/NavigationBar pick up the cloud palette too. */
  .app {
    --background: oklch(0.985 0.004 85); --foreground: oklch(0.26 0.008 65);
    --card: oklch(0.995 0.005 85); --card-foreground: oklch(0.26 0.008 65);
    --secondary: oklch(0.955 0.008 85); --muted: oklch(0.955 0.008 85);
    --muted-foreground: oklch(0.55 0.01 65);
    --primary: oklch(0.55 0.18 268); --primary-foreground: oklch(0.98 0.005 268);
    --accent: oklch(0.94 0.04 268); --accent-foreground: oklch(0.38 0.12 268);
    --destructive: oklch(0.58 0.16 28);
    --border: oklch(0.92 0.006 85); --input: oklch(0.965 0.006 85);
    --ring: oklch(0.55 0.18 268);
    --ok: oklch(0.62 0.15 150); --warn: oklch(0.72 0.14 75);
    min-height: 100vh; background: var(--background); color: var(--foreground);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; align-items: center; padding: 40px 24px 64px;
  }
  .app.dark {
    --background: oklch(0.16 0.006 60); --foreground: oklch(0.92 0.005 85);
    --card: oklch(0.19 0.006 60); --card-foreground: oklch(0.92 0.005 85);
    --secondary: oklch(0.22 0.006 60); --muted: oklch(0.21 0.006 60);
    --muted-foreground: oklch(0.68 0.008 65);
    --primary: oklch(0.72 0.16 265); --primary-foreground: oklch(0.18 0.02 268);
    --accent: oklch(0.28 0.06 268); --accent-foreground: oklch(0.86 0.08 268);
    --destructive: oklch(0.55 0.18 28);
    --border: oklch(0.25 0.006 60); --input: oklch(0.23 0.006 60);
    --ring: oklch(0.72 0.16 265);
  }
  /* one container holds header + content so both align to the same edges */
  .container { width: 100%; max-width: 768px; display: flex; flex-direction: column; gap: 22px; }
  .head { display: flex; align-items: center; gap: 12px; }
  .head h1 { margin: 0; font-size: 19px; letter-spacing: -0.01em; }
  .head .sub { color: var(--muted-foreground); font-size: 13px; }
  .logo { height: 26px; width: auto; display: block; }
  .app.dark .logo { filter: invert(1); }
  .spacer { flex: 1; }
  .layout { display: flex; gap: 28px; align-items: stretch; }
  .card {
    width: 360px; flex-shrink: 0; background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 20px; display: flex; flex-direction: column; gap: 14px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 8px 24px rgba(0,0,0,.04);
  }
  .seg { display: flex; gap: 4px; padding: 4px; background: var(--secondary); border: 1px solid var(--border); border-radius: 10px; }
  .seg button {
    flex: 1; border: 0; background: transparent; color: var(--muted-foreground); font: inherit; font-weight: 600;
    font-size: 13px; padding: 7px 10px; border-radius: 7px; cursor: pointer; transition: all .15s;
  }
  .seg button[data-on="true"] { background: var(--card); color: var(--foreground); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 12px; font-weight: 600; color: var(--muted-foreground); }
  .field input {
    background: var(--input); border: 1px solid var(--border); border-radius: 9px; color: var(--foreground);
    font: inherit; font-size: 14px; padding: 9px 11px; outline: none; transition: border-color .15s, box-shadow .15s;
  }
  .field input::placeholder { color: var(--muted-foreground); opacity: .7; }
  .field input:focus { border-color: var(--ring); box-shadow: 0 0 0 3px color-mix(in oklch, var(--ring) 25%, transparent); }
  .hint {
    display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 9px 11px;
    border-radius: 9px; background: var(--secondary); border: 1px solid var(--border);
    font-size: 12px; line-height: 1.5; color: var(--muted-foreground);
  }
  .hint svg { flex-shrink: 0; margin-top: 1px; opacity: .8; }
  .hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
    padding: 1px 5px; border-radius: 5px; background: var(--input);
    border: 1px solid var(--border); color: var(--foreground); white-space: nowrap;
  }
  .btn {
    border: 1px solid var(--border); background: var(--card); color: var(--foreground); font: inherit; font-weight: 600;
    font-size: 14px; padding: 10px 14px; border-radius: 9px; cursor: pointer; transition: all .15s;
  }
  .btn:hover:not(:disabled) { border-color: var(--muted-foreground); }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn-primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
  .btn-primary:hover:not(:disabled) { filter: brightness(1.07); }
  .row { display: flex; gap: 10px; }
  .row > * { flex: 1; }
  .divider { height: 1px; background: var(--border); margin: 2px 0; }
  .toggles { display: flex; flex-direction: column; gap: 10px; }
  .switch { display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 14px; cursor: pointer; }
  .switch input { display: none; }
  .switch .track {
    width: 38px; height: 22px; border-radius: 999px; background: var(--border); position: relative; transition: background .15s;
  }
  .switch .track::after {
    content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
    background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: transform .15s;
  }
  .switch input:checked + .track { background: var(--primary); }
  .switch input:checked + .track::after { transform: translateX(16px); }
  .status { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.idle { background: var(--muted-foreground); }
  .dot.warn { background: var(--warn); box-shadow: 0 0 0 0 rgba(217,119,6,.5); animation: pulse 1.4s infinite; }
  .dot.ok  { background: var(--ok); }
  .dot.err { background: var(--destructive); }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(217,119,6,.5);} 70% { box-shadow: 0 0 0 6px rgba(217,119,6,0);} 100% { box-shadow: 0 0 0 0 rgba(217,119,6,0);} }
  .err-text { font-size: 12px; color: var(--destructive); word-break: break-word; }
  /* phone — slim handset bezel ported from the cloud assistant frame: warm
   * dark shell locked to the 9:19.5 device aspect, soft drop shadow, no notch.
   * Bezel stays dark in BOTH light and dark themes. */
  .phone {
    width: 360px; aspect-ratio: 9 / 19.5; flex-shrink: 0; border-radius: 2.4rem; padding: 8px;
    background: #1a1815; box-shadow: 0 20px 60px -30px rgba(0,0,0,.45);
  }
  .phone-screen {
    position: relative; width: 100%; height: 100%; border-radius: 2rem; overflow: hidden; background: #000;
    display: flex; flex-direction: column;
  }
  .phone-stage { flex: 1; min-height: 0; position: relative; }
  /* nav bar top seam: hairline highlight against the black screen */
  .device-nav { border-top: none !important; box-shadow: inset 0 0.5px 0 rgba(255,255,255,.06); }
`;

type NavAction = 'BACK' | 'HOME' | 'RECENT';

/** Bordered phone frame: live stream filling the screen, NavigationBar docked below. */
function DeviceChrome({ onNav, children }: { onNav: (a: NavAction) => void; children: React.ReactNode }) {
  return (
    <div className="phone">
      <div className="phone-screen">
        <div className="phone-stage">{children}</div>
        <NavigationBar onAction={onNav} className="device-nav" />
      </div>
    </div>
  );
}

function Switch({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="switch">
      <span>{children}</span>
      <span style={{ display: 'inline-flex' }}>
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" />
      </span>
    </label>
  );
}

interface Status {
  state?: string;
  isLoading: boolean;
  error?: unknown;
  connected: boolean;
}

/**
 * Drives streaming from a device id via @mobilerun/sdk. `useDeviceStream`
 * resolves the device's `streamUrl` + `streamToken`; the component connects the
 * WebSocket directly (the token rides in the URL).
 */
function SdkStream({
  apiKey,
  baseURL,
  deviceId,
  hasControl,
  muted,
  onStatus,
}: {
  apiKey: string;
  baseURL?: string;
  deviceId: string;
  hasControl: boolean;
  muted: boolean;
  onStatus: (s: Partial<Status>) => void;
}) {
  const client = useMemo(
    // apiKey may be blank when the example SDK helper supplies the real key.
    () => new Mobilerun({ apiKey: apiKey || 'example-sdk-helper', ...(baseURL ? { baseURL } : {}) }),
    [apiKey, baseURL],
  );
  const { streamUrl, streamToken, state, error, isLoading, refetch } = useDeviceStream({
    client,
    deviceId,
  });

  React.useEffect(() => onStatus({ state, error, isLoading }), [state, error, isLoading, onStatus]);

  const streamRef = useRef<RemoteControlHandle>(null);

  return (
    <DeviceChrome onNav={(a) => streamRef.current?.sendSystemKey(a)}>
      <DeviceStream
        ref={streamRef}
        streamUrl={streamUrl}
        streamToken={streamToken}
        hasControl={hasControl}
        muted={muted}
        placeholderLabel={state ?? (isLoading ? 'loading…' : 'connecting')}
        onStreamHealed={refetch}
        onConnectionStateChange={(c) => onStatus({ connected: c })}
      />
    </DeviceChrome>
  );
}

type Mode = 'sdk' | 'manual';

function StatusLine({ s, active }: { s: Status; active: boolean }) {
  const errText = s.error ? (s.error as { message?: string })?.message ?? String(s.error) : null;
  let tone: 'idle' | 'warn' | 'ok' | 'err' = 'idle';
  let text = 'idle';
  if (errText) {
    tone = 'err';
    text = 'error';
  } else if (active && s.connected) {
    tone = 'ok';
    text = 'live';
  } else if (active) {
    tone = 'warn';
    text = s.state ? `${s.state}…` : s.isLoading ? 'loading…' : 'connecting…';
  }
  return (
    <div>
      <div className="status">
        <span className={`dot ${tone}`} />
        <strong>{text}</strong>
      </div>
      {errText ? <div className="err-text">{errText}</div> : null}
    </div>
  );
}

function App() {
  const [mode, setMode] = useState<Mode>('sdk');

  // SDK mode uses the local server endpoint only to retrieve stream credentials
  // without exposing the API key. The WebSocket itself opens the returned streamUrl
  // directly in the browser with streamToken appended as ?token=.
  const apiKey = '';
  const baseURL = typeof window === 'undefined' ? '/api/v1' : `${window.location.origin}/api/v1`;
  const [deviceId, setDeviceId] = useState('');
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState<Status>({ isLoading: false, connected: false });
  const onStatus = useCallback((p: Partial<Status>) => setStatus((s) => ({ ...s, ...p })), []);

  // Manual mode: paste a streamUrl + streamToken directly.
  const [streamUrl, setStreamUrl] = useState('');
  const [streamToken, setStreamToken] = useState('');
  const [applied, setApplied] = useState<{ url?: string; token?: string }>({});
  const manualStreamRef = useRef<RemoteControlHandle>(null);

  // Shared controls
  const [hasControl, setHasControl] = useState(true);
  const [muted, setMuted] = useState(true);
  const [dark, setDark] = useState(false);

  const device =
    mode === 'sdk' ? (
      active ? (
        <SdkStream
          apiKey={apiKey}
          baseURL={baseURL || undefined}
          deviceId={deviceId}
          hasControl={hasControl}
          muted={muted}
          onStatus={onStatus}
        />
      ) : (
        <DeviceChrome onNav={() => {}}>
          <DeviceStream hasControl={hasControl} placeholderLabel="enter API key + device id" />
        </DeviceChrome>
      )
    ) : (
      <DeviceChrome onNav={(a) => manualStreamRef.current?.sendSystemKey(a)}>
        <DeviceStream
          ref={manualStreamRef}
          streamUrl={applied.url}
          streamToken={applied.token}
          hasControl={hasControl}
          muted={muted}
          placeholderLabel="waiting for stream"
          onConnectionStateChange={(c) => onStatus({ connected: c })}
        />
      </DeviceChrome>
    );

  return (
    <div className={dark ? 'app dark' : 'app'}>
      <style>{HARNESS_CSS}</style>

      <div className="container">
        <header className="head">
          <img className="logo" src={logoUrl} alt="Mobilerun" />
          <h1>@mobilerun/react</h1>
          <span className="sub">live device streaming · dev playground</span>
          <span className="spacer" />
          <Switch checked={dark} onChange={setDark}>
            <span className="sub">dark</span>
          </Switch>
        </header>

        <div className="layout">
          <div className="card">
            <div className="seg">
              <button data-on={mode === 'sdk'} onClick={() => setMode('sdk')}>
                SDK
              </button>
              <button data-on={mode === 'manual'} onClick={() => setMode('manual')}>
                Manual URL
              </button>
            </div>

            {mode === 'sdk' ? (
              <>
                <div className="field">
                  <label>device id</label>
                  <input value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="device_…" />
                </div>
                <p className="hint">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="7.5" cy="15.5" r="5.5" />
                    <path d="m21 2-9.6 9.6" />
                    <path d="m15.5 7.5 3 3L22 7l-3-3" />
                  </svg>
                  <span>
                    The SDK helper keeps <code>MOBILERUN_API_KEY</code> server-side. The stream WebSocket connects
                    directly with <code>?token=</code>.
                  </span>
                </p>
                <div className="row">
                  <button className="btn btn-primary" disabled={!deviceId} onClick={() => setActive(true)}>
                    Connect
                  </button>
                  <button className="btn" onClick={() => setActive(false)}>
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>streamUrl</label>
                  <input value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)} placeholder="wss://…" />
                </div>
                <div className="field">
                  <label>streamToken</label>
                  <input value={streamToken} onChange={(e) => setStreamToken(e.target.value)} placeholder="token…" />
                </div>
                <div className="row">
                  <button
                    className="btn btn-primary"
                    onClick={() => setApplied({ url: streamUrl || undefined, token: streamToken || undefined })}
                  >
                    Connect
                  </button>
                  <button
                    className="btn"
                    onClick={() => {
                      setApplied({});
                      setStreamUrl('');
                      setStreamToken('');
                    }}
                  >
                    Clear
                  </button>
                </div>
              </>
            )}

            <div className="divider" />
            <div className="toggles">
              <Switch checked={hasControl} onChange={setHasControl}>
                hasControl
              </Switch>
              <Switch checked={muted} onChange={setMuted}>
                muted
              </Switch>
            </div>

            <span className="spacer" />
            <div className="divider" />
            <StatusLine s={status} active={mode === 'sdk' ? active : !!applied.url} />
          </div>

          {device}
        </div>
      </div>
    </div>
  );
}

// Not wrapped in <React.StrictMode>: its dev-only double-mount tears down and
// recreates the WebSocket/RTCPeerConnection mid-negotiation, which WebRTC
// doesn't survive. Production apps with StrictMode rely on the component's
// reconnect logic (onStreamHealed) to recover.
createRoot(document.getElementById('root')!).render(<App />);
