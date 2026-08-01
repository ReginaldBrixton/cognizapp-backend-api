/**
 * Support file upload validation helpers.
 */

import {
	ALLOWED_SUPPORT_UPLOAD_EXTENSIONS,
	ALLOWED_SUPPORT_UPLOAD_MIME_TYPES,
	MAX_SUPPORT_UPLOAD_FILE_BYTES,
	MAX_SUPPORT_UPLOAD_FILES,
} from "./constants";

const AUDIO_EXTENSIONS = new Set(["webm", "mp3", "wav", "ogg", "m4a", "aac"]);

export function extensionFor(fileName: string) {
	const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
	return extension === fileName.toLowerCase() ? "" : extension;
}

export function isVoiceNoteUpload(file: File) {
	const extension = extensionFor(file.name);
	return file.type.toLowerCase().startsWith("audio/") || AUDIO_EXTENSIONS.has(extension);
}

export function validateSupportUploads(files: File[], existingCount: number) {
	const errors: Array<Record<string, unknown>> = [];
	if (!files.length) {
		errors.push({
			code: "no_files",
			message: "Choose at least one file to upload.",
		});
	}
	if (files.length > MAX_SUPPORT_UPLOAD_FILES) {
		errors.push({
			code: "too_many_files",
			message: `Upload up to ${MAX_SUPPORT_UPLOAD_FILES} files at a time.`,
			limit: MAX_SUPPORT_UPLOAD_FILES,
			actual: files.length,
		});
	}

	// Voice notes are conversational messages, not retained request documents.
	// They still obey the per-upload count and 50 MB per-file limits, but they
	// must not be rejected because a long-running request already has 10 files.
	const countableDocuments = files.filter((file) => !isVoiceNoteUpload(file));
	if (existingCount + countableDocuments.length > MAX_SUPPORT_UPLOAD_FILES) {
		errors.push({
			code: "request_file_limit_reached",
			message: `This request can keep up to ${MAX_SUPPORT_UPLOAD_FILES} uploaded documents. Voice notes do not count toward this limit.`,
			limit: MAX_SUPPORT_UPLOAD_FILES,
			existingCount,
			incomingCount: countableDocuments.length,
		});
	}

	for (const file of files) {
		const extension = extensionFor(file.name);
		const mimeType = file.type || "application/octet-stream";
		const isAllowed =
			ALLOWED_SUPPORT_UPLOAD_MIME_TYPES.has(mimeType) ||
			ALLOWED_SUPPORT_UPLOAD_EXTENSIONS.has(extension);
		if (!isAllowed) {
			errors.push({
				code: "unsupported_file_type",
				fileName: file.name,
				mimeType,
				extension,
				message: `${file.name} is not a supported support upload type.`,
			});
		}
		if (file.size > MAX_SUPPORT_UPLOAD_FILE_BYTES) {
			errors.push({
				code: "file_too_large",
				fileName: file.name,
				size: file.size,
				limit: MAX_SUPPORT_UPLOAD_FILE_BYTES,
				message: `${file.name} is larger than the 50MB upload limit.`,
			});
		}
	}

	return errors;
}
