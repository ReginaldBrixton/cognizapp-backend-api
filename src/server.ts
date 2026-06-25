import { createApp } from "./app/create-app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import {
  handleSupportMessagesWebSocketUpgrade,
  supportMessagesWebSocketHandlers,
} from "./modules/support-messages/realtime";

// For local dev, eagerly initialize the app so Bun.serve has the Elysia instance.
const app = await createApp();

const server = Bun.serve({
  port: env.port,
  idleTimeout: 120,
  async fetch(request, bunServer) {
    // Elysia's fetch arity is 1; assign Bun's server so route handlers get
    // context.server.requestIP (needed for loopback checks on /api/auth/dev/token).
    app.server = bunServer;
    const realtimeResponse = await handleSupportMessagesWebSocketUpgrade(request, bunServer);
    if (realtimeResponse !== null) {
      return realtimeResponse;
    }
    return app.fetch(request);
  },
  websocket: supportMessagesWebSocketHandlers,
});

logger.info(`CognizApp Users API listening on http://localhost:${env.port}`);

if (env.isDevelopment) {
  logger.info(`Local smoke test endpoint: http://localhost:${env.port}${env.localTestingPath}`);
}

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});

process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
