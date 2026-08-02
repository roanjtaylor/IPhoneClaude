// iPhone-Claude backend: turns HTTP chat requests into subscription-billed Claude
// Agent SDK calls, streamed over SSE. Runs on an always-on cloud host so the phone
// works with the laptop off (see plan/backend.md).
//
// ‼️ Run with plain `tsx` (NO watch). The Agent SDK's lazy import can deadlock under
// `tsx watch` in non-TTY stdio, and `node --watch` spuriously restarts on Windows and
// drops in-flight calls. Plain `tsx` has neither problem. Restart after editing.
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { PORT, APP_SHARED_SECRETS } from './config.ts';
import { chatRouter } from './routes/chat.ts';
import { titleRouter } from './routes/title.ts';
import { modelsRouter } from './routes/models.ts';

const app = express();
app.use(cors());
// 15mb: base64-encoded image/document attachments inflate ~33% over their byte size.
app.use(express.json({ limit: '15mb' }));

// Public liveness check — registered BEFORE the auth gate so monitors don't need the
// secret.
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Friendly public landing page at the root, so opening the Space URL in a browser explains
// what this is instead of showing a bare `unauthorized`. Registered BEFORE the auth gate, and
// deliberately leaks nothing sensitive (no secret, no usage figures, no token).
const LANDING_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>iPhone-Claude server</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #1f1e1d; color: #e8e6e3; font: 16px/1.6 -apple-system, system-ui, sans-serif; }
  main { max-width: 34rem; padding: 2rem 1.5rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .tag { color: #d97757; font-weight: 600; }
  p { color: #b8b5b0; }
  code { background: #2a2a2a; padding: .1rem .4rem; border-radius: 6px; font-size: .9em; }
  ul { color: #b8b5b0; padding-left: 1.1rem; }
  .muted { color: #8a8784; font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
<main>
  <h1>🤖 <span class="tag">iPhone-Claude</span> server</h1>
  <p>A small private relay that powers a personal Claude chat app for an iPhone 7 — the kind
     that's too old for the official app. It forwards messages to Claude on a personal
     subscription and streams the reply back.</p>
  <p>This is <strong>not a public API</strong>. Every chat request needs a shared secret, so
     visiting this page directly just shows this note. The <code>/api/health</code> check is
     the only other public endpoint.</p>
  <ul>
    <li>Single user, single device — no accounts, no sign-up.</li>
    <li>Hosted free on Hugging Face Spaces (free Docker tier): it sleeps after a stretch of
        inactivity and wakes on the next request, so the first message after idle is slow.</li>
    <li>No public usage allowance — calls run on the owner's own Claude plan, not a shared quota.</li>
  </ul>
  <p class="muted">Status: running. Health check at <code>/api/health</code>.</p>
</main>
</body>
</html>`;
app.get('/', (_req, res) => res.type('html').send(LANDING_HTML));

// Shared-secret gate. The server exposes subscription-powered Claude on the public
// internet, so every non-health request must present a matching x-app-secret. Several
// client apps can share this server, each with its own secret (comma-separated in the
// env var). When no secret is set (local dev) the gate is open for easy `curl` testing.
app.use((req: Request, res: Response, next: NextFunction) => {
  if (APP_SHARED_SECRETS.length === 0) return next();
  const presented = req.get('x-app-secret');
  if (!presented || !APP_SHARED_SECRETS.includes(presented)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.use('/api/chat', chatRouter);
app.use('/api/title', titleRouter);
app.use('/api/models', modelsRouter);

// Turn anything a route throws into JSON the client can display, not a bare 500.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] request error:', err);
  if (res.headersSent) return;
  res.status(500).json({ error: err?.message ?? 'Internal server error' });
});

// Bind on all interfaces (0.0.0.0) so cloud hosts can route to it.
const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
  if (APP_SHARED_SECRETS.length === 0) {
    console.warn('[server] APP_SHARED_SECRET is unset — auth gate is OPEN (fine locally, NOT for a public host).');
  }
  if (process.env.ANTHROPIC_API_KEY) {
    console.warn('[server] ANTHROPIC_API_KEY is set — Claude will bill the paid API, NOT your subscription. Unset it to use the plan.');
  }
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} already in use — exiting. Stop the other server first.`);
    process.exit(1);
  } else {
    console.error('[server] server error:', err);
  }
});
