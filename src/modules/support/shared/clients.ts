/**
 * Client, WhatsApp, and row-format helpers.
 */

import { t } from "elysia";

import { getDb } from "../../../lib/db";
import { HttpError } from "../../../lib/errors";
import { requirePermission, type AuthContext } from "../../auth/middleware";
import { normalizeRole } from "../../auth/policy";

const nullableString = t.Optional(t.Union([t.String(), t.Null()]));
const nullableNumber = t.Optional(t.Union([t.Number(), t.Null()]));
const nullableBoolean = t.Optional(t.Union([t.Boolean(), t.Null()]));
const nullableStringArray = t.Optional(t.Union([t.Array(t.String()), t.Null()]));

export const requestBody = t.Object(
	{
		title: t.String(),
		description: nullableString,
		serviceTags: nullableStringArray,
		serviceCategory: nullableString,
		subServices: nullableStringArray,
		subject: nullableString,
		academicLevel: nullableString,
		outputExpectation: nullableString,
		deadlineAt: nullableString,
		timezone: nullableString,
		budgetMin: nullableNumber,
		budgetMax: nullableNumber,
		currency: nullableString,
		workspaceId: nullableString,
		paymentMode: nullableString,
		paymentMethod: nullableString,
		preferredPaymentMode: nullableString,
		wordCount: nullableNumber,
		pages: nullableNumber,
		attachmentMetadata: t.Optional(t.Union([t.Array(t.Any()), t.Null()])),
		integrityAck: nullableBoolean,
		contactConsent: nullableBoolean,
		currentStep: nullableNumber,
		fullName: nullableString,
		institution: nullableString,
		whatsappNumber: nullableString,
		supervisorComments: nullableString,
		userNotes: nullableString,
		referralCode: nullableString,
		discountCode: nullableString,
		depositPercent: nullableNumber,
		scopeType: nullableString,
		selectedChapters: nullableStringArray,
		dataCollectionOwner: nullableString,
		analysisOwner: nullableString,
		includeSlides: nullableBoolean,
		slideCount: nullableNumber,
		assistance24x7: nullableBoolean,
		correctionMode: nullableBoolean,
		correctionCommentCount: nullableNumber,
		assignmentInstructions: nullableString,
		costEstimate: t.Optional(t.Any()),
	},
	{
		additionalProperties: true,
	},
);

export function toCamel(row: Record<string, any>) {
	const camel = Object.fromEntries(
		Object.entries(row).map(([key, value]) => [
			key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()),
			value,
		]),
	);
	if ("deadlineAt" in camel && !("deadline" in camel)) {
		camel.deadline = camel.deadlineAt;
	}
	if ("userKeyId" in camel && !("userId" in camel)) {
		camel.userId = camel.userKeyId;
	}
	if ("clientKeyId" in camel && !("clientId" in camel)) {
		camel.clientId = camel.clientKeyId;
	}
	if ("providerKeyId" in camel && !("providerId" in camel)) {
		camel.providerId = camel.providerKeyId;
	}
	if ("quoteType" in camel && !("type" in camel)) {
		camel.type = camel.quoteType;
	}
	if ("amountPaid" in camel && !("amount" in camel)) {
		camel.amount = camel.amountPaid;
	}
	return camel;
}

export function cleanSupportWhatsAppNumber(value: unknown) {
	const str = String(value ?? "").trim();
	if (!str) return "";

	const digits = str.replace(/\D/g, "");
	let local = digits;

	if (local.startsWith("2330")) {
		local = local.slice(4);
	} else if (local.startsWith("233")) {
		local = local.slice(3);
	} else if (local.startsWith("0")) {
		local = local.slice(1);
	}

	return local ? `+233${local.slice(0, 9)}` : "";
}

export function assertSupportWhatsAppNumber(value: unknown) {
	const phone = cleanSupportWhatsAppNumber(value);
	if (!phone) {
		throw new HttpError(
			400,
			"whatsapp_required",
			"WhatsApp number is required so CogniZap can send request and file updates.",
		);
	}
	if (!/^\+233\d{9}$/.test(phone)) {
		throw new HttpError(
			400,
			"invalid_whatsapp_number",
			"Enter a valid Ghana WhatsApp number, for example 024XXXXXXX or +23324XXXXXXX.",
		);
	}
	return phone;
}

function buildReferralCode(userKeyId: string) {
	const shortKey = userKeyId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toUpperCase();
	return `REG-CLIENT-${shortKey || "000001"}`;
}

export async function ensureClient(auth: AuthContext, body?: Record<string, any>) {
	const whatsappNumber = body?.whatsappNumber
		? cleanSupportWhatsAppNumber(body.whatsappNumber)
		: "";
	const [client] = await getDb()`
    INSERT INTO support_clients (
      user_key_id, email, full_name, whatsapp_number, institution, level, referral_code
    )
    VALUES (
      ${auth.userId},
      ${auth.email},
      ${String(body?.fullName ?? auth.email).trim()},
      ${whatsappNumber},
      ${String(body?.institution ?? "").trim()},
      ${String(body?.academicLevel ?? "").trim()},
      ${buildReferralCode(auth.userId)}
    )
    ON CONFLICT (user_key_id) DO UPDATE
    SET
      email = EXCLUDED.email,
      full_name = COALESCE(NULLIF(EXCLUDED.full_name, ''), support_clients.full_name),
      whatsapp_number = COALESCE(NULLIF(EXCLUDED.whatsapp_number, ''), support_clients.whatsapp_number),
      institution = COALESCE(NULLIF(EXCLUDED.institution, ''), support_clients.institution),
      level = COALESCE(NULLIF(EXCLUDED.level, ''), support_clients.level),
      updated_at = NOW()
    RETURNING *
  `;
	return client;
}

export function generateTaskId() {
	const timestamp = Date.now().toString(36).toUpperCase();
	const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
	return `CZ-RS-${timestamp}-${suffix}`;
}

export function canSeeProvider(auth: AuthContext) {
	const role = normalizeRole(auth.role);
	return (
		role === "ADMIN_USER" ||
		role === "SUPPORT_PROVIDER_USER" ||
		auth.permissions.includes("support.tickets.respond") ||
		auth.permissions.includes("support.users.inspect")
	);
}

// Re-export requirePermission for convenience (used by support-inbox)
export { requirePermission };
