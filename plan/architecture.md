# Architecture — overall setup & tech (as built)

Two components, talking over HTTPS. That's the whole system.

```
iPhone 7 (iOS 15.8.5, TestFlight)        Hugging Face Space (Docker, always-on)
┌────────────────────────────┐  HTTPS   ┌─────────────────────────────────────┐
│ Expo / React Native app    │  (SSE)   │ Node + Express "Claude server"      │
│  - chat list + chat + setts │ ───────► │  POST /api/chat   (SSE, multimodal) │
│  - Markdown, attachments    │          │  POST /api/title  GET /api/health   │
│  - light/dark, pinch-zoom   │          │  GET  /api/models                   │
│  - SQLite history (local)   │ ◄─────── │  @anthropic-ai/claude-agent-sdk     │
│  - x-app-secret header      │          │  NO ANTHROPIC_API_KEY ⇒ subscription│
│  (built by EAS → TestFlight)│          │  auth via CLAUDE_CODE_OAUTH_TOKEN   │
└────────────────────────────┘          │  tools: WebSearch + WebFetch        │
                                         └─────────────────────────────────────┘
```

## The two halves

| | Frontend (the app) | Backend (the brain) |
| --- | --- | --- |
| Runs on | iPhone 7 | Hugging Face Spaces (free Docker, 16 GB RAM) |
| Tech | Expo SDK 54, RN 0.81, React 19, TS; React Navigation, expo-sqlite, react-native-markdown-display, expo-image/document-picker | Node 20, Express, `@anthropic-ai/claude-agent-sdk`, `tsx` |
| Job | Render Markdown chat, persist history locally, pick attachments, stream the reply | Call Claude on the subscription (text + multimodal), stream tokens/tools back |
| Detail | [`frontend.md`](frontend.md) | [`backend.md`](backend.md) |

## Why the brain can't live on the phone

The Agent SDK answers a request by **spawning the Claude Code CLI as a subprocess**. iOS
sandboxes apps — no Node runtime, no `child_process`, no spawning binaries — so that cannot
run on-device. The server runs in the cloud and the app is a thin client. Hosting it on an
always-on Space (rather than the laptop) is what makes "laptop-free" true.

## Request flow

1. You type a prompt (optionally attaching photos/documents); the app writes the user turn to
   SQLite and appends it to the on-screen conversation.
2. App `POST`s `{ messages: [...], model?, systemPrompt?, projectContext? }` (attachments as
   base64 content blocks — every turn's, so past images stay in context) to `/api/chat` with the
   `x-app-secret` header.
3. Server checks the secret, then calls the SDK's `query()` with the conversation (text, or a
   streaming-input content-block message when any turn has attachments), the chosen model/system
   prompt (with any `projectContext` appended), and `allowedTools: ['WebSearch', 'WebFetch']`.
4. The SDK spawns the Claude CLI, which authenticates with the **subscription** (because no
   API key is set) and streams partial text + tool activity back.
5. The server forwards text as SSE `delta` events (plus `tool`/`sources` when web search runs);
   the app appends them live, shows the search state, and renders sources. A final `done` (or
   `error`) ends the stream, and the app persists the completed assistant turn to SQLite.

A side endpoint keeps Settings current without an app update: `GET /api/models` returns the live
Anthropic model list (so new releases appear in the picker), read through the host's OAuth token
(`oauthApi.ts` in the server's own repo — see `backend.md` for where that lives now).

## Key tech decisions (and constraints behind them)

- **Subscription auth** — `query()` with no `ANTHROPIC_API_KEY`; on the host a long-lived
  `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. Zero API cost.
- **Model** — `claude-opus-4-8` (set in the server's own `config.ts`, overridable via
  `CLAUDE_MODEL`; see `backend.md` — the server isn't part of this repo any more).
- **Local data model** — SQLite (`app/src/storage/db.ts`): `conversations` (+ optional
  `projectId` FK), `messages`, and `projects` (goal + injected `contextPrompt`). Schema changes
  ride a `PRAGMA user_version` migration so existing installs upgrade without data loss.
- **Streaming** — Server-Sent Events end to end; the client reads it with `expo/fetch`
  (React Native's global `fetch` can't expose the response stream).
- **Persistent host, not serverless** — each request spawns a CLI subprocess and streams for
  seconds, which serverless platforms (execution caps, restricted subprocesses) don't suit.
- **iOS 15 support** — built with the latest Xcode/SDK Apple requires, but the **deployment
  target stays at 15.1**, so the binary still runs on the iPhone 7.
- **TestFlight distribution** — verified to install on this iPhone 7 (overriding the common
  "TestFlight needs iOS 16" claim), via EAS's cloud build + submit.
- **Shared-secret gate** — the server is on the public internet exposing subscription Claude,
  so every request must carry the matching `x-app-secret`.

## Cost & footprint

- **$0** in Claude usage (subscription) and **$0** hosting (HF free tier, no card).
- Only standing cost is the existing **$99/yr Apple Developer** membership.
- Single user, single device. Trade-offs and the ToS gray area (driving subscription creds
  from a server) are accepted for a private MVP.
