// Minimal API function test using the default (req, res) handler signature.
// Vercel's Bun API function runtime expects this signature, not a Response return.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function handler(_req: any, res: any): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "ok", source: "api/index.ts" }));
}
