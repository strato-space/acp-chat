# acp-chat

Standalone ACP chat UI (browser) + server bridge.

## What it is

- `web/`: React UI (ported from the VS Code ACP webview).
- `server/`: Node server that:
  - spawns an ACP agent per WebSocket connection (multi-user basic)
  - translates ACP session updates into the same message shape the webview expects
  - serves `/api/health`, `/api/agents` and a WebSocket at `/ws`

## Run locally

```bash
cd /home/tools/acp-chat
npm install
npm run build:web
npm run build:server

# requires a token if ACP_CHAT_AUTH_TOKEN is set
ACP_CHAT_HOST=127.0.0.1 ACP_CHAT_PORT=8732 ACP_CHAT_AUTH_TOKEN=devtoken \\
  npm run start
```

Then open `http://127.0.0.1:8732` (or `https://...` behind nginx).

## Auth

Set `ACP_CHAT_AUTH_TOKEN` (recommended). The browser connects to `/ws` and must provide:

- `Authorization: Bearer <token>` (preferred), or
- `?token=<token>` query parameter (fallback)

## Deploy (nginx + systemd)

Templates live in:

- `deploy/nginx/agents-dev.conf`
- `deploy/systemd/acp-chat.service`

