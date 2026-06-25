import { createApp } from "../src/app/create-app";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let appPromise: Promise<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): Promise<any> {
  if (!appPromise) {
    appPromise = createApp().catch((error) => {
      appPromise = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[vercel] Failed to initialize app: ${message}`);
      throw error;
    });
  }
  return appPromise;
}

export default async function handler(request: Request): Promise<Response> {
  try {
    const app = await getApp();
    return app.fetch(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[vercel] Handler error: ${message}`);
    return new Response(
      JSON.stringify({ error: "Internal Server Error", message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
