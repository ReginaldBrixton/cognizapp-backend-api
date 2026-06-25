import { createApp } from "../src/app/create-app";

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

// Convert a Node.js/Vercel request into a Web Request for Elysia.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toWebRequest(req: any): Promise<Request> {
  const host = req.headers?.host ?? "api.cognizapp.com";
  const url = new URL(req.url ?? "/", `https://${host}`);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers ?? {})) {
    if (value !== undefined) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
    }
  }

  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD" && req.body) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    body = buffer.length > 0 ? buffer : undefined;
  }

  return new Request(url, { method, headers, body });
}

// Vercel Bun API function using the default (req, res) handler signature.
// Elysia returns a Web Response, so we translate it back to Node.js res.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const app = await getApp();
    const request = await toWebRequest(req);
    const response = await app.fetch(request);

    res.statusCode = response.status;
    response.headers.forEach((value: string, key: string) => {
      // Bun/Vercel's res.setHeader may fail on read-only headers; ignore those.
      try {
        res.setHeader(key, value);
      } catch {
        // ignore
      }
    });

    const body = await response.arrayBuffer();
    res.end(Buffer.from(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal Server Error", message }));
  }
}
