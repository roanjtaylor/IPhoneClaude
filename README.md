# iPhone-Claude (Claude7)

A personal Claude app for an **iPhone 7 (iOS 15.8.5)** — which can't run the official app
(needs iOS 18). Type a prompt, get the same style of streamed, web-aware answer, powered by an
existing **Claude subscription** (no API cost). **Shipped and running on the iPhone 7 via
TestFlight.**

## Layout

```
IPhoneClaude/
├── plan/        # design & setup record — start at plan/ethos.md
├── app/         # the Expo / React Native chat app → TestFlight
└── todo.md      # what works today + what's missing (the backlog)
```

The Claude "brain" (Node + `claude-agent-sdk`) used to live here as `server/`, but it's now a
**shared, multi-project resource** — this app is one of its callers, not its owner. Its
source moved to its own repo: **`../z_hf-space`** locally, deployed at
[`huggingface.co/spaces/roanjtaylor/ClaudeSubscription`](https://huggingface.co/spaces/roanjtaylor/ClaudeSubscription).
See `plan/backend.md` for how this app talks to it.

## How it fits together

```
iPhone 7 (TestFlight)            Hugging Face Space (Docker, 24/7) — shared, not app-owned
┌──────────────────┐  HTTPS/SSE  ┌──────────────────────────────────┐
│ app/  Expo chat  │ ──────────► │ ClaudeSubscription server         │
│  (thin client)   │ ◄────────── │ Express + claude-agent-sdk query()│
└──────────────────┘             └──────────────────────────────────┘
```

The brain can't run on the phone (iOS can't spawn the `claude` binary), so it runs in the
cloud and the app is a thin client — that's what makes it work with the laptop off.

## Docs

| Doc | What it covers |
| --- | --- |
| [`plan/ethos.md`](plan/ethos.md) | Why this exists + principles + status |
| [`plan/architecture.md`](plan/architecture.md) | Overall setup & tech, as built |
| [`plan/backend.md`](plan/backend.md) | How this app talks to the shared Claude server |
| [`plan/frontend.md`](plan/frontend.md) | The iPhone app + TestFlight build/ship runbook |
| [`todo.md`](todo.md) | Current capabilities and the backlog (incl. branding) |

## Disposable by design

Everything runtime lives in `app/` (outside `plan/`). To start over, delete that folder — the
plan docs and `todo.md` stay intact. (The server is a separate, shared resource — see above —
so it isn't part of "starting over" on this app.)
