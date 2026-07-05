/**
 * File storage helpers (UploadThing + database fallback).
 */

import { getDb } from "../../../lib/db";
import { uploadSupportFile, uploadthingConfigured } from "../../../lib/uploadthing";
import type { AuthContext } from "../../auth/middleware";
import { addSupportEvent } from "./events";

let warnedUploadThingFallback = false;

export async function ensureRequestStorageReady(
	request: Record<string, any>,
	auth: AuthContext,
) {
	await addSupportEvent(
		String(request.id),
		auth,
		uploadthingConfigured() ? "storage.uploadthing_ready" : "storage.local_fallback",
		uploadthingConfigured()
			? "UploadThing storage is ready for request files"
			: "UploadThing is not configured; files will use local database fallback",
		{
			provider: uploadthingConfigured() ? "uploadthing" : "database",
			taskId: String(request.task_id ?? ""),
		},
	);

	return request;
}

export async function storeSupportFileOnUploadThing(
	fileRow: Record<string, any>,
	file: File,
	buffer: Buffer,
	auth: AuthContext,
	purpose: string,
) {
	const db = getDb();
	if (!uploadthingConfigured()) {
		if (!warnedUploadThingFallback) {
			warnedUploadThingFallback = true;
			console.warn(
				"[support:storage] UploadThing is not configured; support files will remain in database fallback storage",
				{
					whatHappened: "UPLOADTHING_TOKEN was not available to the users backend.",
					userImpact:
						"Uploads still save, but they use database fallback storage instead of UploadThing URLs.",
					whatToDo: "Set UPLOADTHING_TOKEN and restart the users backend.",
				},
			);
		}
		const [fallback] = await db`
      UPDATE support_files
      SET storage_provider = 'database',
        external_upload_status = 'not_configured',
        external_upload_error = NULL
      WHERE id = ${fileRow.id}
      RETURNING *
    `;
		return fallback ?? fileRow;
	}

	const [pending] = await db`
    UPDATE support_files
    SET storage_provider = 'uploadthing',
      external_upload_status = 'pending',
      external_upload_error = NULL,
      external_folder_id = NULL
    WHERE id = ${fileRow.id}
    RETURNING *
  `;

	const result = await uploadSupportFile({
		bytes: buffer,
		fileName: file.name,
		fileType: file.type || "application/octet-stream",
		requestId: fileRow.request_id ? String(fileRow.request_id) : null,
		userId: auth.userId,
		purpose,
		metadata: {
			fileRowId: String(fileRow.id),
			originalFileName: file.name,
		},
	});
	const externalFileId = result.ok ? result.key : null;
	const externalFileUrl = result.ok ? result.url : null;
	const externalFolderId = result.ok ? result.customId : null;
	const uploadError = result.ok ? null : `${result.code}: ${result.message}`.slice(0, 1000);

	const [updated] = await db`
    UPDATE support_files
    SET external_file_id = ${externalFileId},
      external_file_url = ${externalFileUrl},
      external_folder_id = ${externalFolderId},
      external_upload_status = ${result.ok ? "uploaded" : "failed"},
      external_upload_error = ${uploadError},
      external_uploaded_at = CASE WHEN ${result.ok} THEN NOW() ELSE external_uploaded_at END,
      file_url = CASE WHEN ${result.ok} THEN ${externalFileUrl} ELSE file_url END,
      content_base64 = CASE WHEN ${result.ok} THEN NULL ELSE content_base64 END,
      updated_at = NOW()
    WHERE id = ${fileRow.id}
    RETURNING *
  `;

	if (fileRow.request_id) {
		await addSupportEvent(
			String(fileRow.request_id),
			auth,
			result.ok ? "uploadthing.file_uploaded" : "uploadthing.file_upload_failed",
			result.ok ? "File uploaded to secure storage" : "Secure file upload failed",
			{
				fileId: fileRow.id,
				externalFileId: externalFileId ?? "",
				externalFileUrl: externalFileUrl ?? "",
				purpose,
				provider: "uploadthing",
				error: result.ok ? null : result.message,
			},
		);
	}

	return updated ?? pending ?? fileRow;
}
