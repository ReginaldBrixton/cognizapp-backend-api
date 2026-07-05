/**
 * Support event logging (audit trail for support requests).
 */

import { getDb } from "../../../lib/db";
import type { AuthContext } from "../../auth/middleware";

export async function addSupportEvent(
	requestId: string | null,
	auth: AuthContext,
	eventType: string,
	message: string,
	metadata: Record<string, any> = {},
) {
	await getDb()`
    INSERT INTO support_events (request_id, actor_id, actor_role, event_type, message, metadata)
    VALUES (
      ${requestId}, ${auth.userId}, ${auth.role || "client"}, ${eventType}, ${message}, ${getDb().json(metadata)}
    )
  `;
}
