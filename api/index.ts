// Minimal API function test using the (req, res) handler signature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function handler(req: any, res: any): void {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ status: "ok", source: "api/index.ts", path: req.url }));
}
