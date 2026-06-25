// Minimal API function test: no external imports, just a fixed response.
// This confirms whether the Vercel Bun runtime invokes the fetch export at all.
export async function fetch(): Promise<Response> {
  return new Response(JSON.stringify({ status: "ok", source: "api/index.ts" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
