export default async function handler(request: Request): Promise<Response> {
  return new Response(JSON.stringify({ status: "ok", message: "minimal test" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
