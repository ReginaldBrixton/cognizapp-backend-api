/**
 * File-related helper functions extracted from routes.ts.
 *
 * These cover provider file mutation checks, message attachment updates,
 * and file activity message creation.
 */

import { getDb } from "../../lib/db";
import { HttpError } from "../../lib/errors";
import type { AuthContext } from "../auth/middleware";
import { addSupportEvent, toCamel } from "./shared";
import { PROVIDER_MUTABLE_SUPPORT_FILE_PURPOSES } from "./constants";
import { canSeeProvider } from "./shared";

export function assertProviderCanMutateSupportFile(
	auth: AuthContext,
	file: Record<string, any>,
) {
	if (!canSeeProvider(auth)) {
		throw new HttpError(403, "provider_required", "Only providers can edit request files");
	}
	if (!file.request_id) {
		throw new HttpError(400, "request_file_required", "Only request files can be edited");
	}
	if (file.deleted_at) {
		throw new HttpError(410, "file_deleted", "This file has already been deleted");
	}
	if (!PROVIDER_MUTABLE_SUPPORT_FILE_PURPOSES.has(String(file.purpose ?? ""))) {
		throw new HttpError(403, "file_not_provider_owned", "Only provider-uploaded files can be edited");
	}
}

export function updateAttachmentForFile(
	attachment: Record<string, any>,
	fileId: string,
	updater: (item: Record<string, any>) => Record<string, any>,
) {
	let changed = false;
	const next = { ...attachment };
	const attachmentFileId = String(next.fileId ?? next.id ?? "").trim();
	if (attachmentFileId === fileId && (!next.kind || next.kind === "file")) {
		Object.assign(next, updater(next));
		changed = true;
	}
	if (Array.isArray(next.files)) {
		const files = next.files.map((file) => {
			if (!file || typeof file !== "object") return file;
			const nestedFile = { ...(file as Record<string, any>) };
			const nestedFileId = String(nestedFile.fileId ?? nestedFile.id ?? "").trim();
			if (nestedFileId !== fileId) return file;
			changed = true;
			return updater(nestedFile);
		});
		next.files = files;
	}
	return { attachment: next, changed };
}

export async function updateSupportMessageFileAttachments(
	fileId: string,
	updater: (item: Record<string, any>) => Record<string, any>,
) {
	const db = getDb();
	const markers = [
		{ fileId },
		{ id: fileId },
	];
	const messages = await db`
    SELECT *
    FROM support_messages
    WHERE deleted_at IS NULL
      AND (
        attachments @> ${db.json([markers[0]] as any)}::jsonb
        OR attachments @> ${db.json([markers[1]] as any)}::jsonb
      )
  `;
	const { broadcastSupportMessageUpdate } = await import("../support-messages/realtime");
	for (const message of messages) {
		const attachments = Array.isArray(message.attachments) ? message.attachments : [];
		let changed = false;
		const nextAttachments = attachments.map((attachment) => {
			if (!attachment || typeof attachment !== "object") return attachment;
			const result = updateAttachmentForFile(attachment as Record<string, any>, fileId, updater);
			if (result.changed) changed = true;
			return result.attachment;
		});
		if (!changed) continue;
		const [updatedMessage] = await db`
      UPDATE support_messages
      SET attachments = ${db.json(nextAttachments as any)}, edited_at = COALESCE(edited_at, NOW())
      WHERE id = ${message.id}
      RETURNING *
    `;
		broadcastSupportMessageUpdate(String(updatedMessage.thread_id), toCamel(updatedMessage));
	}
}

export async function createSupportFileActivityMessage(
	auth: AuthContext,
	requestId: string,
	content: string,
	attachment: Record<string, any>,
) {
	const db = getDb();
	const [thread] = await db`
    SELECT *
    FROM support_message_threads
    WHERE request_id = ${requestId}::uuid
    ORDER BY created_at ASC
    LIMIT 1
  `;
	if (!thread) return null;
	const [message] = await db`
    INSERT INTO support_messages (
      thread_id, sender_key_id, sender_name, sender_role, content, attachments, read_by
    )
    VALUES (
      ${thread.id}, ${auth.userId}, ${auth.email}, 'provider',
      ${content}, ${db.json([attachment] as any)}, ARRAY[${auth.userId}]::TEXT[]
    )
    RETURNING *
  `;
	await db`
    UPDATE support_message_threads
    SET last_message_at = ${message.created_at}, updated_at = NOW()
    WHERE id = ${thread.id}
  `;
	await addSupportEvent(requestId, auth, "support.file.changed", content, {
		threadId: thread.id,
		messageId: message.id,
		attachment,
	});
	const { broadcastSupportMessage } = await import("../support-messages/realtime");
	broadcastSupportMessage(String(thread.id), toCamel(message));
	return message;
}
