/**
 * Milestone helpers: file listing, file events, card attachments, and history.
 */

import { getDb } from "../../../lib/db";
import { toCamel } from "./clients";

export async function getMilestoneFiles(milestoneId: string) {
	const rows = await getDb()`
    SELECT f.id, f.request_id, f.milestone_id, f.user_key_id, f.file_name, f.file_url, f.file_type,
      f.file_size, f.purpose, f.storage_provider, f.external_file_id, f.external_file_url,
      f.external_upload_status, f.created_at, f.deleted_at, f.replaced_at, f.previous_file_name,
      f.submission_round,
      r.payment_status, r.payment_policy
    FROM support_files f
    LEFT JOIN support_requests r ON r.id = f.request_id
    WHERE f.milestone_id = ${milestoneId}::uuid
    ORDER BY f.submission_round DESC, f.created_at DESC
  `;
	return rows.map((file) => {
		const item = toCamel(file);
		const purpose = String(item.purpose ?? "");
		const deleted = Boolean(item.deletedAt);
		const cleanFinalFile = ["admin_clean_pdf", "admin_clean_docx"].includes(purpose);
		const providerFile = purpose === "milestone_upload" || purpose === "provider_message_upload";
		return {
			...item,
			name: item.fileName,
			label: item.fileName,
			url: deleted ? null : `/api/support/files/${item.id}/download`,
			externalUrl: null,
			externalFileId: undefined,
			externalFileUrl: undefined,
			type: item.fileType,
			size: item.fileSize,
			kind: "file",
			status: deleted ? "deleted" : item.replacedAt ? "edited" : "active",
			locked: cleanFinalFile || providerFile,
			canPreview: providerFile,
			canDownload: false,
			previousName: item.previousFileName ?? null,
			submissionRound: Number(item.submissionRound ?? 1),
		};
	});
}

export async function recordMilestoneFileEvent({
	requestId,
	milestoneId,
	fileId,
	auth,
	eventType,
	fileName,
	previousFileName,
	metadata = {},
	submissionRound,
}: {
	requestId: string;
	milestoneId?: string | null;
	fileId?: string | null;
	auth: import("../../auth/middleware").AuthContext;
	eventType: string;
	fileName?: string | null;
	previousFileName?: string | null;
	metadata?: Record<string, any>;
	submissionRound?: number;
}) {
	const db = getDb();
	const [table] = await db`SELECT to_regclass('app.milestone_file_events') AS regclass`;
	if (!table?.regclass) return null;
	const round = submissionRound ?? 1;
	const [event] = await db`
    INSERT INTO milestone_file_events (
      request_id, milestone_id, file_id, actor_key_id, actor_role,
      event_type, file_name, previous_file_name, metadata, submission_round
    )
    VALUES (
      ${requestId}::uuid, NULLIF(${milestoneId ?? ""}, '')::uuid, NULLIF(${fileId ?? ""}, '')::uuid,
      ${auth.userId}, ${auth.role || "provider"}, ${eventType},
      ${fileName ?? null}, ${previousFileName ?? null}, ${db.json(metadata)}, ${round}
    )
    RETURNING *
  `;
	return toCamel(event);
}

export async function buildMilestoneCardAttachment(
	milestone: Record<string, any>,
	requestId: string,
	latestRevision?: Record<string, any> | null,
) {
	const files = await getMilestoneFiles(String(milestone.id));
	const submissionRound = Number(milestone.submission_round ?? 0);
	return {
		kind: "milestone_card",
		milestoneId: milestone.id,
		requestId,
		title: milestone.title,
		description: milestone.description,
		dueAt: milestone.due_at,
		status: milestone.status,
		revisionCount: milestone.revision_count,
		revisionRequestCount: milestone.revision_count,
		submissionRound,
		fileCount: files.length,
		files,
		locked: true,
		canPreview: files.length > 0,
		canDownload: false,
		sourceOfTruth: "request_milestones",
		userFeedback: milestone.user_feedback,
		providerNotes: milestone.provider_notes,
		latestRevisionReason: latestRevision?.reason ?? null,
		latestRevisionMessage: latestRevision?.revision_message ?? milestone.user_feedback ?? null,
		latestRevisionStatus: latestRevision?.status ?? null,
		latestRevisionAt: latestRevision?.created_at ?? null,
		updatedAt: milestone.updated_at,
	};
}

export async function refreshMilestoneCardMessages(
	requestId: string,
	milestoneId: string,
) {
	const db = getDb();
	const [milestone] = await db`
    SELECT *
    FROM request_milestones
    WHERE id = ${milestoneId}::uuid
      AND request_id = ${requestId}::uuid
    LIMIT 1
  `;
	if (!milestone) return [];

	const [latestRevision] = await db`
    SELECT reason, revision_message, status, created_at
    FROM support_revisions
    WHERE milestone_id = ${milestoneId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
	const card = await buildMilestoneCardAttachment(milestone, requestId, latestRevision);
	const messages = await db`
    UPDATE support_messages sm
    SET attachments = ${db.json([card])},
      edited_at = NOW()
    FROM support_message_threads t
    WHERE sm.thread_id = t.id
      AND t.request_id = ${requestId}::uuid
      AND sm.attachments @> ${db.json([{ kind: "milestone_card", milestoneId }] as any)}::jsonb
    RETURNING sm.*
  `;
	return messages.map(toCamel);
}

/**
 * Fetch the full history of a milestone, grouped by submission round.
 * Each round includes: the files uploaded in that round, any revision request,
 * and the file events that occurred. This powers the "version history" UI.
 */
export async function getMilestoneHistory(milestoneId: string) {
	const db = getDb();

	const [milestone] = await db`
    SELECT id, submission_round, status, created_at
    FROM request_milestones
    WHERE id = ${milestoneId}::uuid
    LIMIT 1
  `;
	if (!milestone) return [];

	const events = await db`
    SELECT id, event_type, file_name, previous_file_name, actor_key_id, actor_role,
      submission_round, metadata, created_at
    FROM milestone_file_events
    WHERE milestone_id = ${milestoneId}::uuid
    ORDER BY submission_round ASC, created_at ASC
    LIMIT 200
  `;

	const revisions = await db`
    SELECT id, reason, revision_message, status, submission_round, created_at
    FROM support_revisions
    WHERE milestone_id = ${milestoneId}::uuid
    ORDER BY submission_round ASC, created_at ASC
    LIMIT 50
  `;

	const files = await db`
    SELECT f.id, f.file_name, f.file_type, f.file_size, f.purpose,
      f.submission_round, f.created_at, f.deleted_at, f.replaced_at, f.previous_file_name
    FROM support_files f
    WHERE f.milestone_id = ${milestoneId}::uuid
    ORDER BY f.submission_round ASC, f.created_at ASC
    LIMIT 200
  `;

	const maxRound = Math.max(
		milestone.submission_round || 0,
		...events.map((e) => e.submission_round || 1),
		...revisions.map((r) => r.submission_round || 1),
		...files.map((f) => f.submission_round || 1),
	);

	const rounds: Array<{
		round: number;
		label: string;
		files: any[];
		revision: any | null;
		events: any[];
		submittedAt: string | null;
	}> = [];

	for (let round = 1; round <= maxRound; round++) {
		const roundFiles = files
			.filter((f) => (f.submission_round || 1) === round)
			.map((f) => ({
				id: f.id,
				name: f.file_name,
				fileName: f.file_name,
				type: f.file_type,
				size: f.file_size,
				purpose: f.purpose,
				round,
				createdAt: f.created_at,
				deletedAt: f.deleted_at,
				replacedAt: f.replaced_at,
				previousName: f.previous_file_name,
				status: f.deleted_at ? "deleted" : f.replaced_at ? "replaced" : "active",
			}));

		const roundRevision = revisions.find((r) => (r.submission_round || 1) === round);
		const roundEvents = events
			.filter((e) => (e.submission_round || 1) === round)
			.map((e) => ({
				id: e.id,
				eventType: e.event_type,
				fileName: e.file_name,
				previousFileName: e.previous_file_name,
				actorKeyId: e.actor_key_id,
				actorRole: e.actor_role,
				round,
				metadata: e.metadata,
				createdAt: e.created_at,
			}));

		const submitEvent = roundEvents.find(
			(e) => e.eventType === "card_sent" || e.eventType === "card_updated",
		);

		rounds.push({
			round,
			label: round === 1 ? "Initial submission" : `Revision ${round - 1} resubmission`,
			files: roundFiles,
			revision: roundRevision
				? {
						id: roundRevision.id,
						reason: roundRevision.reason,
						message: roundRevision.revision_message,
						status: roundRevision.status,
						round,
						createdAt: roundRevision.created_at,
					}
				: null,
			events: roundEvents,
			submittedAt: submitEvent?.createdAt ?? null,
		});
	}

	return rounds;
}

export async function getMilestoneSubmissionRound(milestoneId: string): Promise<number> {
	const [row] = await getDb()`
    SELECT submission_round
    FROM request_milestones
    WHERE id = ${milestoneId}::uuid
    LIMIT 1
  `;
	return Number(row?.submission_round ?? 0);
}

export async function incrementMilestoneSubmissionRound(milestoneId: string): Promise<number> {
	const [row] = await getDb()`
    UPDATE request_milestones
    SET submission_round = submission_round + 1,
      updated_at = NOW()
    WHERE id = ${milestoneId}::uuid
    RETURNING submission_round
  `;
	return Number(row?.submission_round ?? 1);
}
