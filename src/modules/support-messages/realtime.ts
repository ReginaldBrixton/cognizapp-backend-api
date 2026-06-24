import type { Server, ServerWebSocket } from "bun";

import { HttpError } from "../../lib/errors";
import { resolveAuth, type AuthContext } from "../auth/middleware";
import { createSupportMessage, getAuthorizedSupportMessageThread } from "./routes";

type SupportSocketData = {
  auth: AuthContext;
  threadId: string;
  connectedAt: number;
};

type SupportSocket = ServerWebSocket<SupportSocketData>;

const supportRooms = new Map<string, Set<SupportSocket>>();
const maxSocketPayloadBytes = 64 * 1024;

function safeSend(ws: SupportSocket, payload: Record<string, unknown>) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function roomFor(threadId: string) {
  let room = supportRooms.get(threadId);
  if (!room) {
    room = new Set<SupportSocket>();
    supportRooms.set(threadId, room);
  }
  return room;
}

function removeSocket(ws: SupportSocket) {
  const room = supportRooms.get(ws.data.threadId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) {
    supportRooms.delete(ws.data.threadId);
  }
}

function parseMessage(raw: string | Buffer) {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  if (Buffer.byteLength(text, "utf8") > maxSocketPayloadBytes) {
    throw new HttpError(413, "payload_too_large", "Realtime message payload is too large");
  }
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new HttpError(400, "invalid_json", "Realtime message payload must be valid JSON");
  }
}

export function broadcastSupportMessage(threadId: string, message: Record<string, unknown>) {
  const room = supportRooms.get(threadId);
  if (!room) return;
  for (const ws of room) {
    safeSend(ws, {
      type: "message.created",
      threadId,
      message,
      sentAt: new Date().toISOString(),
    });
  }
}

export function broadcastSupportMessageUpdate(threadId: string, message: Record<string, unknown>) {
  const room = supportRooms.get(threadId);
  if (!room) return;
  for (const ws of room) {
    safeSend(ws, {
      type: "message.updated",
      threadId,
      message,
      sentAt: new Date().toISOString(),
    });
  }
}

export async function handleSupportMessagesWebSocketUpgrade(
  request: Request,
  server: Server<SupportSocketData>,
) {
  const url = new URL(request.url);
  if (url.pathname !== "/api/support/messages/ws") {
    return null;
  }

  const token = String(url.searchParams.get("token") ?? "").trim();
  const threadId = String(url.searchParams.get("threadId") ?? url.searchParams.get("thread_id") ?? "").trim();
  if (!token || !threadId) {
    return new Response("Missing realtime credentials", { status: 400 });
  }

  try {
    const auth = await resolveAuth({ authorization: `Bearer ${token}` });
    await getAuthorizedSupportMessageThread(auth, threadId);
    const upgraded = server.upgrade(request, {
      data: {
        auth,
        threadId,
        connectedAt: Date.now(),
      },
    });
    return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 401;
    return new Response("Realtime authorization failed", { status });
  }
}

export const supportMessagesWebSocketHandlers = {
  open(ws: SupportSocket) {
    roomFor(ws.data.threadId).add(ws);
    safeSend(ws, {
      type: "ready",
      threadId: ws.data.threadId,
      userId: ws.data.auth.userId,
      connectedAt: new Date(ws.data.connectedAt).toISOString(),
    });
  },
  async message(ws: SupportSocket, raw: string | Buffer) {
    try {
      const payload = parseMessage(raw);
      const type = String(payload.type ?? "");

      if (type === "ping") {
        safeSend(ws, { type: "pong", threadId: ws.data.threadId, sentAt: new Date().toISOString() });
        return;
      }

      if (type === "message.send") {
        const result = await createSupportMessage(ws.data.auth, ws.data.threadId, {
          content: payload.content,
          body: payload.body,
          attachments: payload.attachments,
          fileReferences: payload.fileReferences,
          file_references: payload.file_references,
          mentions: payload.mentions,
          replyToMessageId: payload.replyToMessageId,
          reply_to_message_id: payload.reply_to_message_id,
        });
        broadcastSupportMessage(ws.data.threadId, result.message);
        return;
      }

      safeSend(ws, {
        type: "error",
        code: "unsupported_event",
        message: "Unsupported realtime event",
      });
    } catch (error) {
      safeSend(ws, {
        type: "error",
        code: error instanceof HttpError ? error.code : "realtime_error",
        message: error instanceof HttpError ? error.message : "Realtime message failed",
      });
    }
  },
  close(ws: SupportSocket) {
    removeSocket(ws);
  },
};
