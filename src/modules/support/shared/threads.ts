/**
 * Support message thread helpers.
 */

import { getDb } from "../../../lib/db";

export async function ensureSupportMessageThread(
	requestId: string,
	userId: string,
	type = "request",
) {
	const db = getDb();
	const [inserted] = await db`
    INSERT INTO support_message_threads (request_id, user_key_id, type, last_message_at)
    SELECT ${requestId}::uuid, ${userId}, ${type}, NOW()
    WHERE NOT EXISTS (
      SELECT 1
      FROM support_message_threads
      WHERE request_id = ${requestId}::uuid
        AND user_key_id = ${userId}
    )
    RETURNING *
  `;
	if (inserted) return inserted;

	const [existing] = await db`
    SELECT *
    FROM support_message_threads
    WHERE request_id = ${requestId}::uuid
      AND user_key_id = ${userId}
    ORDER BY created_at ASC
    LIMIT 1
  `;
	return existing ?? null;
}

export async function completeSupportMessageThreads(requestId: string) {
	await getDb()`
    UPDATE support_message_threads
    SET status = 'completed',
      completed_at = COALESCE(completed_at, NOW()),
      updated_at = NOW()
    WHERE request_id = ${requestId}::uuid
  `;
}
