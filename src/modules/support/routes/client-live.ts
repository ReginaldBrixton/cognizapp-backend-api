import { Elysia } from "elysia";
import { resolveAuth } from "../../auth/middleware";
import { getDb } from "../../../lib/db";

// Only opaque revisions are transmitted; the existing authenticated APIs remain
// the source of truth. Short, bounded streams work across reverse proxies.
async function revisions(userId: string) {
  const db = getDb();
  const [support] = await db`
    SELECT
      (SELECT md5(COALESCE(string_agg(md5(row_to_json(r)::text), ',' ORDER BY r.id), ''))
       FROM support_requests r WHERE r.user_key_id = ${userId}) AS requests,
      (SELECT md5(COALESCE(string_agg(m.id::text || ':' || m.created_at::text, ',' ORDER BY m.id), ''))
       FROM (SELECT m.id, m.created_at FROM support_messages m JOIN support_message_threads t ON t.id = m.thread_id
       WHERE t.user_key_id = ${userId} ORDER BY m.created_at DESC LIMIT 6) m) AS messages
  `;
  const [referrals] = await db`
    SELECT md5(COALESCE(string_agg(md5(row_to_json(rr)::text || COALESCE(row_to_json(rc)::text,'') ||
      COALESCE((rc.available_at <= NOW())::text,'')), ',' ORDER BY rr.id, rc.id), '')) AS relationships,
      (SELECT md5(COALESCE(string_agg(md5(row_to_json(p)::text), ',' ORDER BY p.id), ''))
       FROM referral_payout_profiles p WHERE p.user_id = ${userId}::uuid) AS profiles
    FROM referral_relationships rr LEFT JOIN referral_commissions rc ON rc.relationship_id = rr.id
    WHERE rr.referrer_user_id = ${userId}::uuid
  `;
  return { requests: String(support?.requests ?? ''), messages: String(support?.messages ?? ''), referrals: String(referrals?.relationships ?? '') + String(referrals?.profiles ?? '') };
}

export const clientLiveRoutes = new Elysia().get("/client/live", async ({ headers, request }) => {
  const auth = await resolveAuth(headers);
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; if (timer) clearTimeout(timer); wake?.(); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
      request.signal.addEventListener("abort", stop, { once: true });
      const started = Date.now();
      let previous = "";
      try {
        while (!stopped && !request.signal.aborted && Date.now() - started < 40000) {
          const snapshot = JSON.stringify(await revisions(auth.userId));
          if (stopped || request.signal.aborted) break;
          if (snapshot !== previous) {
            controller.enqueue(encoder.encode("data: " + snapshot + "\n\n"));
            previous = snapshot;
          } else controller.enqueue(encoder.encode(": heartbeat\n\n"));
          await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 15000); });
        }
      } catch {
        // Closing the stream allows EventSource to reconnect and the client to reconcile.
      } finally {
        stop(); request.signal.removeEventListener("abort", stop);
        try { controller.close(); } catch {}
      }
      };
      void pump();
    },
    cancel() { stop(); }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
});
