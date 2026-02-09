import http from "http";
import path from "path";
import fs from "fs";
import express from "express";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import type { SessionNotification, ContentBlock } from "@agentclientprotocol/sdk";
import { ACPClient } from "./acp/client";
import {
  getAgent,
  getAgentsWithStatus,
  getFirstAvailableAgent,
  type AgentConfig,
} from "./acp/agents";

type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

type Attachment = {
  id: string;
  type: "file" | "image" | "code";
  name: string;
  content: string;
  path?: string;
  language?: string;
  lineRange?: [number, number];
  mimeType?: string;
};

type IncomingMessage =
  | { type: "ready" }
  | { type: "connect" }
  | { type: "cancel" }
  | { type: "newChat" }
  | { type: "clearChat" }
  | { type: "selectAgent"; agentId: string }
  | { type: "selectMode"; modeId: string }
  | { type: "selectModel"; modelId: string }
  | { type: "sendMessage"; text?: string; attachments?: Attachment[] };

function send(ws: WebSocket, msg: Record<string, unknown>) {
  ws.send(JSON.stringify(msg));
}

function getAuthToken(req: http.IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header === "string") {
    const m = header.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  try {
    const u = new URL(req.url ?? "", "http://localhost");
    const q = u.searchParams.get("token");
    if (q && q.trim()) return q.trim();
  } catch {
    // ignore
  }
  return null;
}

function toDisplayText(text: string, attachments?: Attachment[]): string {
  const displayParts: string[] = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (att.type === "image") {
        displayParts.push(`[Image: ${att.name}]`);
      } else if (att.type === "code") {
        const lang = att.language || "";
        const range = att.lineRange ? ` (lines ${att.lineRange[0]}-${att.lineRange[1]})` : "";
        displayParts.push(
          `\`\`\`${lang}\n// File: ${att.path || att.name}${range}\n${att.content}\n\`\`\``
        );
      } else {
        displayParts.push(
          `\`\`\`\n// File: ${att.path || att.name}\n${att.content}\n\`\`\``
        );
      }
    }
  }

  if (text && text.trim()) displayParts.push(text);
  return displayParts.join("\n\n");
}

function toContentBlocks(text: string, attachments?: Attachment[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      if (att.type === "image") {
        const base64Data = att.content.includes(",") ? att.content.split(",")[1] : att.content;
        blocks.push({
          type: "image",
          data: base64Data,
          mimeType: att.mimeType || "image/png",
        });
        continue;
      }

      if (att.type === "code") {
        const lang = att.language || "";
        const range = att.lineRange ? ` (lines ${att.lineRange[0]}-${att.lineRange[1]})` : "";
        const codeBlock = `\`\`\`${lang}\n// File: ${att.path || att.name}${range}\n${att.content}\n\`\`\``;
        blocks.push({ type: "text", text: codeBlock });
        continue;
      }

      const fileBlock = `\`\`\`\n// File: ${att.path || att.name}\n${att.content}\n\`\`\``;
      blocks.push({ type: "text", text: fileBlock });
    }
  }

  if (text && text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

function mapConnectionState(state: ConnectionState): ConnectionState {
  return state;
}

function mapToolStatus(status: unknown): "running" | "completed" | "failed" {
  const raw = typeof status === "string" ? status.toLowerCase() : "";
  if (["completed", "complete", "done", "success", "succeeded"].includes(raw)) return "completed";
  if (["failed", "error"].includes(raw)) return "failed";
  return "running";
}

type WsContext = {
  ws: WebSocket;
  client: ACPClient;
  hasSession: boolean;
  streamingText: string;
  stderrBuffer: string;
  agentId: string;
};

async function ensureConnected(ctx: WsContext) {
  const state = ctx.client.getState();
  if (state === "connecting") return;
  if (state === "connected") return;
  await ctx.client.connect();
}

async function ensureSession(ctx: WsContext) {
  if (ctx.hasSession) return;
  const workingDir = process.cwd();
  await ctx.client.newSession(workingDir);
  ctx.hasSession = true;
}

function translateSessionUpdate(ctx: WsContext, n: SessionNotification) {
  const update = n.update;

  if (update.sessionUpdate === "agent_message_chunk") {
    if (update.content.type === "text") {
      ctx.streamingText += update.content.text;
      send(ctx.ws, { type: "streamChunk", text: update.content.text });
    }
    return;
  }

  if (update.sessionUpdate === "agent_thought_chunk") {
    if (update.content.type === "text") {
      send(ctx.ws, { type: "thinkingChunk", text: update.content.text });
    }
    return;
  }

  if (update.sessionUpdate === "tool_call") {
    const meta = (update as unknown as { _meta?: unknown })._meta;
    send(ctx.ws, {
      type: "toolCallStart",
      name: update.title,
      toolCallId: update.toolCallId,
      kind: update.kind,
      meta,
      rawInput: (update as unknown as { rawInput?: unknown }).rawInput,
      rawOutput: (update as unknown as { rawOutput?: unknown }).rawOutput,
    });
    return;
  }

  if (update.sessionUpdate === "tool_call_update") {
    send(ctx.ws, {
      type: "toolCallComplete",
      toolCallId: update.toolCallId,
      title: update.title,
      kind: update.kind,
      content: update.content,
      rawInput: update.rawInput,
      rawOutput: update.rawOutput,
      meta: (update as unknown as { _meta?: unknown })._meta,
      status: mapToolStatus(update.status),
    });
    return;
  }

  if (update.sessionUpdate === "available_commands_update") {
    send(ctx.ws, { type: "availableCommands", commands: update.availableCommands });
    return;
  }

  if (update.sessionUpdate === "plan") {
    send(ctx.ws, { type: "plan", plan: { entries: update.entries } });
    return;
  }

  if (update.sessionUpdate === "current_mode_update") {
    send(ctx.ws, { type: "modeUpdate", modeId: update.currentModeId });
    return;
  }
}

async function handleIncoming(ctx: WsContext, msg: IncomingMessage) {
  switch (msg.type) {
    case "ready": {
      send(ctx.ws, { type: "connectionState", state: mapConnectionState(ctx.client.getState()) });
      send(ctx.ws, { type: "appInfo", version: "acp-chat" });
      const agents = getAgentsWithStatus();
      send(ctx.ws, { type: "agents", agents: agents.map((a) => ({ id: a.id, name: a.name, available: a.available })), selected: ctx.agentId });
      send(ctx.ws, { type: "sessionMetadata", modes: null, models: null, commands: null });
      send(ctx.ws, { type: "sessions", sessions: [] });
      return;
    }

    case "selectAgent": {
      const nextAgentId = msg.agentId;
      const a = getAgent(nextAgentId);
      if (!a) {
        send(ctx.ws, { type: "error", text: `Unknown agent: ${nextAgentId}` });
        return;
      }
      ctx.agentId = nextAgentId;
      ctx.client.setAgent(a);
      ctx.hasSession = false;
      send(ctx.ws, { type: "agentChanged", agentId: nextAgentId });
      send(ctx.ws, { type: "sessionMetadata", modes: null, models: null, commands: null });
      return;
    }

    case "connect": {
      try {
        send(ctx.ws, { type: "connectionState", state: "connecting" });
        await ensureConnected(ctx);
        send(ctx.ws, { type: "connectionState", state: "connected" });
        await ensureSession(ctx);
        const meta = ctx.client.getSessionMetadata();
        send(ctx.ws, { type: "sessionMetadata", modes: meta?.modes ?? null, models: meta?.models ?? null, commands: meta?.commands ?? null });
      } catch (e) {
        send(ctx.ws, { type: "connectionState", state: "error" });
        send(ctx.ws, { type: "connectAlert", text: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    case "selectMode": {
      try {
        await ctx.client.setMode(msg.modeId);
        const meta = ctx.client.getSessionMetadata();
        send(ctx.ws, { type: "sessionMetadata", modes: meta?.modes ?? null, models: meta?.models ?? null, commands: meta?.commands ?? null });
      } catch (e) {
        send(ctx.ws, { type: "error", text: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    case "selectModel": {
      try {
        await ctx.client.setModel(msg.modelId);
        const meta = ctx.client.getSessionMetadata();
        send(ctx.ws, { type: "sessionMetadata", modes: meta?.modes ?? null, models: meta?.models ?? null, commands: meta?.commands ?? null });
      } catch (e) {
        send(ctx.ws, { type: "error", text: e instanceof Error ? e.message : String(e) });
      }
      return;
    }

    case "cancel": {
      await ctx.client.cancel();
      return;
    }

    case "newChat": {
      ctx.hasSession = false;
      send(ctx.ws, { type: "chatCleared" });
      send(ctx.ws, { type: "sessionMetadata", modes: null, models: null, commands: null });
      try {
        await ensureConnected(ctx);
        await ensureSession(ctx);
        const meta = ctx.client.getSessionMetadata();
        send(ctx.ws, { type: "sessionMetadata", modes: meta?.modes ?? null, models: meta?.models ?? null, commands: meta?.commands ?? null });
      } catch {
        // ignore
      }
      return;
    }

    case "clearChat": {
      send(ctx.ws, { type: "chatCleared" });
      return;
    }

    case "sendMessage": {
      const text = msg.text ?? "";
      const attachments = msg.attachments ?? [];

      const displayText = toDisplayText(text, attachments);
      const imageAttachments = attachments.filter((a) => a.type === "image");

      send(ctx.ws, { type: "userMessage", text: displayText, attachments: imageAttachments.length > 0 ? imageAttachments : undefined });

      ctx.streamingText = "";
      ctx.stderrBuffer = "";
      send(ctx.ws, { type: "streamStart" });

      try {
        await ensureConnected(ctx);
        await ensureSession(ctx);
        const response = await ctx.client.sendMessage(toContentBlocks(text, attachments));

        if (ctx.streamingText.length === 0) {
          send(ctx.ws, { type: "error", text: "Agent returned no streaming response." });
          send(ctx.ws, { type: "streamEnd", stopReason: "error" });
        } else {
          send(ctx.ws, { type: "streamEnd", stopReason: response.stopReason });
        }
        ctx.streamingText = "";
      } catch (e) {
        send(ctx.ws, { type: "error", text: e instanceof Error ? e.message : String(e) });
        send(ctx.ws, { type: "streamEnd", stopReason: "error" });
        ctx.streamingText = "";
        ctx.stderrBuffer = "";
      }
      return;
    }
  }
}

const PORT = Number.parseInt(process.env.ACP_CHAT_PORT || "8732", 10);
const HOST = process.env.ACP_CHAT_HOST || "127.0.0.1";
const AUTH_TOKEN = process.env.ACP_CHAT_AUTH_TOKEN || "";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/agents", (_req, res) => {
  const agents = getAgentsWithStatus();
  res.json({
    agents: agents.map((a) => ({ id: a.id, name: a.name, available: a.available })),
  });
});

// Serve static client (optional; build web first)
const webDist = path.resolve(__dirname, "../../web/dist");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  if (AUTH_TOKEN) {
    const token = getAuthToken(req);
    if (!token || token !== AUTH_TOKEN) {
      ws.close(1008, "unauthorized");
      return;
    }
  }

  const connectTimeoutMs = Number.parseInt(process.env.ACP_CONNECT_TIMEOUT_MS || "600000", 10);
  const client = new ACPClient({ connectTimeoutMs });
  const first = getFirstAvailableAgent();
  client.setAgent(first);

  const ctx: WsContext = {
    ws,
    client,
    hasSession: false,
    streamingText: "",
    stderrBuffer: "",
    agentId: first.id,
  };

  const unsubState = client.setOnStateChange((state) => {
    send(ws, { type: "connectionState", state });
  });
  const unsubUpdates = client.setOnSessionUpdate((n) => translateSessionUpdate(ctx, n));
  const unsubStderr = client.setOnStderr((_text) => {
    // Keep for debugging; we don't forward stderr to the UI by default.
  });

  ws.on("message", async (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      send(ws, { type: "error", text: "Invalid JSON message" });
      return;
    }

    const msg = parsed as IncomingMessage;
    try {
      await handleIncoming(ctx, msg);
    } catch (e) {
      send(ws, { type: "error", text: e instanceof Error ? e.message : String(e) });
    }
  });

  ws.on("close", () => {
    unsubState();
    unsubUpdates();
    unsubStderr();
    client.dispose();
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`[acp-chat] listening on http://${HOST}:${PORT}`);
});

