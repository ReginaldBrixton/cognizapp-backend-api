import { Elysia } from "elysia";

import { createApp } from "./app/create-app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): Promise<any> {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      appPromise = null;
      const name = error instanceof Error ? error.constructor.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[vercel] Failed to initialize app: ${name}: ${message}`);
      if (error instanceof Error) console.error(`[vercel] Stack: ${error.stack}`);
      throw error;
    });
  }
  return appPromise;
}

const app = new Elysia().all("*", async ({ request }) => {
  try {
    const realApp = await getApp();
    return realApp.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: "Internal Server Error", message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

export default app;
