/**
 * Shared constants for the support module.
 *
 * Centralised here so that upload limits, MIME types, and other magic values
 * are easy to discover and debug — no more hunting through a 3,000-line file.
 */

export const MAX_SUPPORT_UPLOAD_FILES = 10;
export const MAX_SUPPORT_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_SUPPORT_TIMEZONE = "Africa/Accra";
export const MOBILE_MONEY_ATTEMPT_TTL_SECONDS = 5 * 60;
export const DELIVERY_PAYMENT_REQUIRED_MESSAGE =
	"Final payment must be verified before this delivery can be downloaded.";

export const ALLOWED_SUPPORT_UPLOAD_MIME_TYPES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"text/plain",
	"text/csv",
	"image/jpeg",
	"image/png",
	"image/webp",
	"application/zip",
	"application/x-zip-compressed",
	// Audio (voice notes)
	"audio/webm",
	"audio/ogg",
	"audio/wav",
	"audio/mp4",
	"audio/mpeg",
	"audio/x-m4a",
	"audio/aac",
]);

export const ALLOWED_SUPPORT_UPLOAD_EXTENSIONS = new Set([
	"pdf",
	"doc",
	"docx",
	"xls",
	"xlsx",
	"ppt",
	"pptx",
	"txt",
	"csv",
	"jpg",
	"jpeg",
	"png",
	"webp",
	"zip",
	// Audio (voice notes)
	"webm",
	"mp3",
	"wav",
	"ogg",
	"m4a",
	"aac",
]);

export const PROVIDER_MUTABLE_SUPPORT_FILE_PURPOSES = new Set([
	"provider_message_upload",
	"milestone_upload",
	"admin_clean_pdf",
	"admin_clean_docx",
]);
