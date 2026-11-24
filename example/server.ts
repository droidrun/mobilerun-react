// Copyright 2026 Mobilerun
// SPDX-License-Identifier: Apache-2.0
//
// Dev harness server for the @mobilerun/react example.
//
// The stream WebSocket is not proxied: the browser connects to the SDK-provided
// streamUrl directly, and @mobilerun/react appends a fresh stream token as ?token=.
//
// For SDK mode, this Bun + Hono server exposes narrow endpoints that uses the
// official SDK to retrieve streamUrl and mint a stream token without exposing the parent API key:
//
//   browser ──(same-origin)──▶ this server ──(@mobilerun/sdk)──▶ API
//
//   • Serves the example UI (Bun bundles index.html + main.tsx).
//   • GET /api/v1/devices/:deviceId returns id/state/streamUrl only.
//   • POST /api/v1/devices/:deviceId/stream-key mints one single-use stream token per attempt.
//   • Local use only: the server binds to 127.0.0.1 and its task routes and SSE
//     route are unauthenticated by design. If you expose anything publicly (e.g. a
//     tunnel for webhook testing), forward only /webhooks/mobilerun, never the
//     whole server.
//   • Task approvals: GET /api/v1/tasks/:taskId (pending approval), POST
//     /api/v1/tasks/:taskId/approvals/:approvalId (decision), POST /webhooks/mobilerun
//     (signed webhook, set MOBILERUN_WEBHOOK_SECRET) and GET /api/v1/events (SSE
//     change signal for the browser).
//
// Run:  MOBILERUN_API_KEY=dr_sk_… bun run example  (or put it in a .env file)

import type { Server } from 'bun';
import { MobilerunSDK, verifyWebhook, WebhookVerificationError } from '@mobilerun/sdk';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { streamSSE } from 'hono/streaming';
import index from './index.html';

const API_KEY = process.env.MOBILERUN_API_KEY;
const UPSTREAM = process.env.MOBILERUN_API_URL?.replace(/\/+$/, '');
const WEBHOOK_SECRET = process.env.MOBILERUN_WEBHOOK_SECRET;
const PORT = Number(process.env.PORT ?? 3000);
const sdk = API_KEY ? new MobilerunSDK({
  apiKey: API_KEY,
  logLevel: 'off',
  ...(UPSTREAM ? { baseURL: `${UPSTREAM}/v1` } : {}),
}) : null;

if (import.meta.main && !API_KEY) {
  console.warn(
    '\n  ! MOBILERUN_API_KEY is not set.\n' +
      '    Manual URL mode still works. SDK mode needs a key in .env or:\n' +
      '    MOBILERUN_API_KEY=dr_sk_… bun run example\n',
  );
}

/** Local-only helpers. Production apps must authenticate callers and authorize each device. */
export function createExampleApp(sdk: MobilerunSDK | null) {
  const app = new Hono<{ Bindings: Server<unknown> }>();

  app.use('/api/*', async (c, next) => {
    const host = c.req.header('Host');
    const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
    const isLoopbackHost = host !== undefined && allowedHosts.includes(host);
    const origin = c.req.header('Origin');
    const isSameOrigin = origin === undefined || origin === `http://${host}`;
    const isAllowed = isLoopbackHost && isSameOrigin;
    if (!isAllowed) {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });

  app.get('/api/v1/devices/:deviceId', async (c) => {
    if (!sdk) {
      return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use SDK mode.' }, 500);
    }

    try {
      const device = await sdk.devices.get(c.req.param('deviceId'));
      return c.json({
        id: device.info?.id ?? null,
        state: device.info?.state ?? null,
        streamUrl: device.info?.streamUrl ?? null,
      });
    } catch (err) {
      return upstreamFailure(c, 'device_retrieve_failed', err);
    }
  });

  app.post('/api/v1/devices/:deviceId/stream-key', async (c) => {
    c.header('Cache-Control', 'no-store');
    const deviceId = c.req.param('deviceId');
    if (!ID_PATTERN.test(deviceId)) return c.json({ error: 'invalid_id' }, 400);
    if (!sdk) {
      return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use SDK mode.' }, 500);
    }
    try {
      const minted = await sdk.streamTokens.create(
        { deviceId, ttlSeconds: 120 },
        { maxRetries: 0 },
      );
      const { key, keyId, expiresAt } = minted;
      return c.json({ key, keyId, expiresAt }, 201);
    } catch (err) {
      return upstreamFailure(c, 'stream_key_mint_failed', err, true);
    }
  });

  app.post('/webhooks/mobilerun', async (c) => {
    if (!WEBHOOK_SECRET) return c.json({ error: 'missing_webhook_secret' }, 500);
    if (Number(c.req.header('Content-Length') ?? 0) > MAX_WEBHOOK_BODY_BYTES) {
      return c.json({ error: 'payload_too_large' }, 413);
    }
    // Raw bytes exactly as received; the SDK verifies before parsing.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    let event: WebhookEvent;
    try {
      event = (await verifyWebhook({
        body: bytes,
        headers: c.req.raw.headers,
        secret: WEBHOOK_SECRET,
      })) as WebhookEvent;
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        if (err.reason === 'invalid_json') return c.json({ error: 'invalid_json' }, 400);
        return c.json({ error: 'invalid_signature' }, 401);
      }
      throw err;
    }
    const taskId = event?.data?.taskId;
    if (typeof event?.type === 'string' && APPROVAL_EVENTS.has(event.type) && typeof taskId === 'string') {
      for (const send of subscribers) send({ taskId });
    }
    return c.body(null, 204);
  });
  return app;
}

const app = createExampleApp(sdk);

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** Maps an upstream API error to a response, passing 4xx/5xx through (404/409 let the UI refetch). */
function upstreamFailure(c: Context, error: string, err: unknown, redact = false) {
  const { status, message } = err as { status?: number; message?: string };
  const isUpstreamError = status && status >= 400 && status < 600;
  const code = (isUpstreamError ? status : 502) as ContentfulStatusCode;
  if (redact) {
    console.error(error, code);
    return c.json({ error }, code);
  }
  console.error(`✗ ${error}`, JSON.stringify(c.req.param()), message ?? String(err));
  return c.json({ error, detail: message ?? String(err) }, code);
}

// A real app authenticates the caller and checks that the task belongs to that
// user/org before forwarding. This example is unauthenticated and local-only.
app.get('/api/v1/tasks/:taskId', async (c) => {
  if (!sdk) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const taskId = c.req.param('taskId');
  if (!ID_PATTERN.test(taskId)) return c.json({ error: 'invalid_id' }, 400);
  try {
    // The installed SDK's task type may not carry pendingApproval yet, so read the raw response.
    const { task } = await sdk.api.get<{ task?: { pendingApproval?: unknown } }>(`/tasks/${encodeURIComponent(taskId)}`);
    return c.json({ pendingApproval: task?.pendingApproval ?? null });
  } catch (err) {
    return upstreamFailure(c, 'task_retrieve_failed', err);
  }
});

// Same rule as above: authenticate the caller and check task ownership before forwarding.
app.post('/api/v1/tasks/:taskId/approvals/:approvalId', async (c) => {
  if (!sdk) {
    return c.json({ error: 'missing_api_key', detail: 'Set MOBILERUN_API_KEY to use task approvals.' }, 500);
  }
  const taskId = c.req.param('taskId');
  const approvalId = c.req.param('approvalId');
  if (!ID_PATTERN.test(taskId) || !ID_PATTERN.test(approvalId)) return c.json({ error: 'invalid_id' }, 400);
  const body = (await c.req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return c.json({ error: 'invalid_decision', detail: "decision must be 'approve' or 'deny'." }, 422);
  }
  try {
    // Becomes sdk.api.tasks.approvals.decide(...) once the SDK ships that method.
    await sdk.api.post(`/tasks/${encodeURIComponent(taskId)}/approvals/${encodeURIComponent(approvalId)}`, {
      body: { decision },
    });
    return c.body(null, 204);
  } catch (err) {
    return upstreamFailure(c, 'approval_decide_failed', err);
  }
});

// SSE subscribers. A real app scopes this per signed-in user/org instead of
// broadcasting every event to every browser.
type ApprovalSignal = { taskId: string };
const subscribers = new Set<(signal: ApprovalSignal) => void>();

app.get('/api/v1/events', (c) => {
  // Bun closes idle requests after 10 s; exempt this long-lived stream only.
  c.env.timeout(c.req.raw, 0);
  return streamSSE(c, async (stream) => {
    const send = (signal: ApprovalSignal) => void stream.writeSSE({ data: JSON.stringify(signal) });
    subscribers.add(send);
    stream.onAbort(() => { subscribers.delete(send); });
    // Keep the connection open until the client goes away.
    while (!stream.aborted && !stream.closed) {
      await stream.writeSSE({ event: 'ping', data: '' });
      await stream.sleep(25_000);
    }
    subscribers.delete(send);
  });
});

type WebhookEvent = { type?: unknown; data?: { taskId?: unknown } } | null;

const APPROVAL_EVENTS = new Set(['task.run.approval_requested', 'task.run.approval_resolved']);

if (import.meta.main) {
  Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    routes: { '/': index }, // Bun bundles + serves the React UI and its assets
    development: { hmr: true, console: true },
    fetch: app.fetch,
  });

  console.log(`\n  ▸ @mobilerun/react dev harness   http://localhost:${PORT}`);
  const upstreamUrl = sdk?.api.baseURL ?? 'https://api.mobilerun.ai/v1';
  console.log(`  ▸ SDK helper    GET /api/v1/devices/:id      →  ${upstreamUrl}/devices/:id`);
  console.log('  ▸ stream token  POST /api/v1/devices/:id/stream-key');
  console.log(
    '  ▸ approvals     GET/POST /api/v1/tasks/:id…  ·  POST /webhooks/mobilerun  ·  GET /api/v1/events',
  );
  console.log('  ▸ stream WS     direct browser connection using ?token=\n');
}
