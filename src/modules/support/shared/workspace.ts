/**
 * Workspace linking helpers for support requests.
 */

import { getDb } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import { workspaceService } from "../../workspace/service";
import type { AuthContext } from "../../auth/middleware";
import { addSupportEvent } from "./events";

export async function verifySupportWorkspaceAccess(auth: AuthContext, workspaceId: string) {
	const [workspace] = await getDb()`
    SELECT w.id
    FROM workspaces w
    LEFT JOIN workspace_members m
      ON m.workspace_id = w.id
      AND m.user_uid = ${auth.userId}
      AND m.deleted_at IS NULL
    WHERE w.id = ${workspaceId}::uuid
      AND w.deleted_at IS NULL
      AND (w.owner_uid = ${auth.userId} OR m.id IS NOT NULL)
    LIMIT 1
  `;
	if (!workspace) {
		throw new HttpError(
			403,
			"workspace_required",
			"Choose a workspace you can access before submitting this support request",
		);
	}
}

export async function ensureSupportRequestWorkspace(
	auth: AuthContext,
	request: Record<string, any>,
) {
	const currentWorkspaceId = request.workspace_id ? String(request.workspace_id) : "";
	if (currentWorkspaceId) {
		await verifySupportWorkspaceAccess(auth, currentWorkspaceId);
		return request;
	}

	const workspace = await workspaceService.ensureDefaultWorkspace(
		auth.userId,
		auth.email,
		auth.email,
	);
	const [updated] = await getDb()`
    UPDATE support_requests
    SET workspace_id = ${workspace.id}::uuid,
      updated_at = NOW()
    WHERE id = ${request.id}::uuid
      AND user_key_id = ${auth.userId}
      AND workspace_id IS NULL
    RETURNING *
  `;

	return updated ?? { ...request, workspace_id: workspace.id };
}

export async function ensureSupportWorkspaceLinks(auth: AuthContext, request: Record<string, any>) {
	const workspaceId = request.workspace_id ? String(request.workspace_id) : "";
	if (!workspaceId) {
		throw new HttpError(
			400,
			"workspace_required",
			"Choose a workspace before submitting this support request",
		);
	}
	await verifySupportWorkspaceAccess(auth, workspaceId);

	if (request.project_id && request.collection_id) {
		return request;
	}

	const db = getDb();
	const [project] = request.project_id
		? await db`SELECT * FROM workspace_projects WHERE id = ${request.project_id}::uuid LIMIT 1`
		: await db`
        INSERT INTO workspace_projects (
          workspace_id, owner_uid, title, description, status, visibility,
          field_of_study, project_type, keywords, collaborators, completion_pct,
          deadline, document_count, task_count, completed_tasks, metadata
        ) VALUES (
          ${workspaceId}::uuid, ${auth.userId}, ${String(request.title ?? "Support request")},
          ${String(request.description ?? "")}, 'active', 'private',
          ${request.subject ?? null}, 'support_request',
          ${Array.isArray(request.service_tags) ? request.service_tags : []}, ARRAY[]::TEXT[], 0,
          ${request.deadline_at ?? null}, 0, 0, 0,
          ${db.json({
						source: "support_request",
						supportRequestId: String(request.id),
						taskId: String(request.task_id ?? ""),
						paymentStatus: String(request.payment_status ?? "unpaid"),
					})}
        )
        RETURNING *
      `;

	const collectionName = `${String(request.title ?? "Support request")} Files`;
	const [collection] = request.collection_id
		? await db`SELECT * FROM workspace_collections WHERE id = ${request.collection_id}::uuid LIMIT 1`
		: await db`
        INSERT INTO workspace_collections (
          workspace_id, owner_uid, name, description, collection_type,
          parent_id, filters, sort_order, is_default, metadata
        ) VALUES (
          ${workspaceId}::uuid, ${auth.userId}, ${collectionName},
          ${`Files, uploads, and deliverables for support request ${String(request.task_id ?? request.id)}`},
          'folder', NULL, NULL, 0, FALSE,
          ${db.json({
						source: "support_request",
						supportRequestId: String(request.id),
						taskId: String(request.task_id ?? ""),
						driveFolderId: request.drive_folder_id ?? null,
						driveFolderUrl: request.drive_folder_url ?? null,
					})}
        )
        RETURNING *
      `;

	await db`
    INSERT INTO collection_items (collection_id, item_type, item_id, added_by, sort_order, metadata)
    VALUES (
      ${collection.id}, 'project', ${project.id}, ${auth.userId}, 0,
      ${db.json({ source: "support_request", supportRequestId: String(request.id) })}
    )
    ON CONFLICT DO NOTHING
  `;

	const [updated] = await db`
    UPDATE support_requests
    SET workspace_id = ${workspaceId}::uuid,
      project_id = ${project.id},
      collection_id = ${collection.id},
      updated_at = NOW()
    WHERE id = ${request.id}
    RETURNING *
  `;
	await addSupportEvent(
		String(request.id),
		auth,
		"workspace.linked",
		"Support request linked to workspace project and collection",
		{
			workspaceId,
			projectId: String(project.id),
			collectionId: String(collection.id),
		},
	);
	return updated;
}
