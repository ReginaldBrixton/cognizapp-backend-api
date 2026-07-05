/**
 * Payment calculation, schedule, and policy helpers.
 */

import { HttpError } from "../../../lib/errors";
import { DEFAULT_SUPPORT_TIMEZONE } from "../constants";

const SERVICE_STARTING_PRICES: Record<string, number> = {
	"research-diagnostic": 30,
	"proposal-review": 120,
	"chapter-editing": 180,
	"literature-methodology": 160,
	"citation-integrity": 90,
	"supervisor-comments": 100,
	"data-analysis": 250,
	"questionnaire-survey": 140,
	"thesis-formatting": 120,
	"powerpoint-preparation": 100,
	"excel-dashboard": 180,
	"full-project-support": 500,
	"free-diagnostic": 30,
	assignment: 10,
};

const LAUNCH_DISCOUNT_RATE = 0.5;

const LOCKED_CLIENT_EDIT_PAYMENT_STATUSES = new Set([
	"pending",
	"paystack_pending",
	"deposit_pending_verification",
	"deposit_paid",
	"final_payment_required",
	"final_payment_pending_verification",
	"paid",
	"refunded",
]);

// ── Scope multipliers (mirrors cost-estimation.ts) ───────────────────────────

const URGENCY_MULTIPLIERS = [
	{ maxDays: 3, multiplier: 1.5 },
	{ maxDays: 7, multiplier: 1.25 },
	{ maxDays: 14, multiplier: 1.1 },
	{ maxDays: Infinity, multiplier: 1 },
];

const ACADEMIC_LEVEL_MULTIPLIERS: Record<string, number> = {
	undergraduate: 1,
	bachelor: 1,
	master: 1.2,
	masters: 1.2,
	graduate: 1.2,
	phd: 1.4,
	doctorate: 1.4,
	doctoral: 1.4,
};

const BASE_PAGES = 10;
const BASE_WORDS = 2750;
const PAGE_INCREMENT = 5;
const PAGE_INCREMENT_MULTIPLIER = 0.1;

function urgencyMultiplier(deadlineAt?: string): number {
	if (!deadlineAt) return 1;
	const deadline = new Date(deadlineAt);
	if (Number.isNaN(deadline.getTime())) return 1;
	const days = (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
	const tier = URGENCY_MULTIPLIERS.find((t) => days <= t.maxDays);
	return tier?.multiplier ?? 1;
}

function academicLevelMultiplier(level?: string): number {
	const key = (level || "").toLowerCase().trim();
	return ACADEMIC_LEVEL_MULTIPLIERS[key] ?? 1;
}

function pageCountMultiplier(pages?: number, wordCount?: number): number {
	const effectivePages = pages ?? (wordCount ? Math.ceil(wordCount / BASE_WORDS) : 0);
	if (!effectivePages || effectivePages <= BASE_PAGES) return 1;
	const increments = Math.floor((effectivePages - BASE_PAGES) / PAGE_INCREMENT);
	return 1 + increments * PAGE_INCREMENT_MULTIPLIER;
}

export function roundMoney(value: number) {
	return Math.round((Number(value) || 0) * 100) / 100;
}

export function calculatePaymentAmount(body: Record<string, any>) {
	const serviceTags = Array.isArray(body.serviceTags) ? body.serviceTags.map(String) : [];
	if (serviceTags.includes("assignment") || body.serviceCategory === "assignment") return 10;

	const pricedTags = serviceTags.filter((tag) => SERVICE_STARTING_PRICES[tag] !== undefined);
	if (pricedTags.length > 0) {
		const basePrice = pricedTags.reduce(
			(sum, tag) => sum + (SERVICE_STARTING_PRICES[tag] ?? 0),
			0,
		);

		const urgency = urgencyMultiplier(body.deadlineAt);
		const acad = academicLevelMultiplier(body.academicLevel);
		const pages = pageCountMultiplier(body.pages, body.wordCount);

		const multiplied = basePrice * urgency * acad * pages;
		const discount = roundMoney(multiplied * LAUNCH_DISCOUNT_RATE);
		return Math.max(0, roundMoney(multiplied - discount));
	}

	const estimate =
		body.costEstimate && typeof body.costEstimate === "object" ? body.costEstimate : null;
	if (estimate !== null) {
		const hasExplicitTotal =
			"total" in estimate || "min" in estimate || ("range" in estimate && estimate.range);
		const estimateTotal = Number(estimate.total ?? estimate.range?.min ?? estimate.min ?? 0);
		if (Number.isFinite(estimateTotal) && estimateTotal > 0) {
			return roundMoney(estimateTotal);
		}
		if (hasExplicitTotal && estimateTotal === 0) {
			return 0;
		}
	}

	// Safety fallback: if no priced tag and no cost estimate, use a minimum
	// base price so the payment amount is never 0. This prevents users from
	// being unable to pay because the amount wasn't calculated.
	const MINIMUM_FALLBACK_PRICE = 10;
	return roundMoney(MINIMUM_FALLBACK_PRICE * (1 - LAUNCH_DISCOUNT_RATE));
}

export function buildPaymentSchedule(body: Record<string, any>, depositPercent?: number) {
	const paymentAmount = roundMoney(calculatePaymentAmount(body));
	const resolvedDepositPercent =
		typeof depositPercent === "number" && Number.isFinite(depositPercent)
			? Math.max(0, Math.min(100, depositPercent))
			: paymentAmount > 0
				? 100
				: 0;
	const depositAmount = roundMoney((paymentAmount * resolvedDepositPercent) / 100);
	const balanceAmount = roundMoney(Math.max(paymentAmount - depositAmount, 0));
	return {
		paymentAmount,
		depositPercent: resolvedDepositPercent,
		depositAmount,
		balanceAmount,
	};
}

export function assertClientRequestEditable(request: Record<string, any>) {
	const paymentStatus = String(request.payment_status ?? "unpaid");
	const status = String(request.status ?? "draft");
	const retryableDraftCheckout =
		status === "draft" &&
		[
			"pending",
			"paystack_pending",
			"deposit_pending_verification",
			"final_payment_pending_verification",
		].includes(paymentStatus);
	if (
		(LOCKED_CLIENT_EDIT_PAYMENT_STATUSES.has(paymentStatus) && !retryableDraftCheckout) ||
		status === "submitted" ||
		status === "under_review" ||
		status === "in_progress" ||
		status === "work_ready" ||
		status === "completed" ||
		status === "closed"
	) {
		throw new HttpError(
			409,
			"request_locked_after_payment",
			"This request cannot be edited after payment has started. Use the request chat for follow-ups or scope changes.",
			{
				paymentStatus,
				status,
			},
		);
	}
	if (status === "submitted" && paymentStatus === "unpaid") {
		throw new HttpError(
			409,
			"request_submitted_edit_locked",
			"This request has been submitted and can no longer be edited. Use the request chat for any changes.",
			{
				paymentStatus,
				status,
			},
		);
	}
}

export function buildDraftPayload(body: Record<string, any>) {
	return {
		serviceCategory: Array.isArray(body.serviceTags) ? body.serviceTags[0] ?? "" : "",
		subServices: Array.isArray(body.serviceTags) ? body.serviceTags.slice(1) : [],
		title: body.title ?? "",
		description: body.description ?? "",
		academicLevel: body.academicLevel ?? "",
		subject: body.subject ?? "",
		outputExpectation: body.outputExpectation ?? "",
		institution: body.institution ?? "",
		whatsappNumber: body.whatsappNumber ?? "",
		supervisorComments: body.supervisorComments ?? "",
		referralCode: body.referralCode ?? "",
		discountCode: body.discountCode ?? "",
		contactConsent: body.contactConsent ?? false,
		deadline: body.deadlineAt ?? null,
		timezone: DEFAULT_SUPPORT_TIMEZONE,
		budgetMin: body.budgetMin ?? null,
		budgetMax: body.budgetMax ?? null,
		currency: body.currency ?? "GHS",
		wordCount: body.wordCount ?? null,
		pages: body.pages ?? null,
		workspaceId: body.workspaceId ?? null,
		integrityAck: body.integrityAck ?? false,
		attachmentMetadata: body.attachmentMetadata ?? [],
		paymentMode: "before_work",
		paymentMethod: body.paymentMethod ?? "",
		depositPercent: 100,
		scopeType: body.scopeType ?? "",
		selectedChapters: Array.isArray(body.selectedChapters) ? body.selectedChapters : [],
		dataCollectionOwner: body.dataCollectionOwner ?? "",
		analysisOwner: body.analysisOwner ?? "",
		includeSlides: body.includeSlides ?? false,
		assistance24x7: body.assistance24x7 ?? false,
		correctionCommentCount: body.correctionCommentCount ?? null,
		assignmentInstructions: body.assignmentInstructions ?? null,
		assignment_config:
			body.assignment_config ??
			(body.assignmentInstructions ? { instructions: body.assignmentInstructions } : null),
		costEstimate: body.costEstimate ?? null,
	};
}

export function paymentStatusForSubmittedPayment(paymentType: string) {
	if (paymentType === "deposit") return "deposit_pending_verification";
	if (paymentType === "final_balance") return "final_payment_pending_verification";
	if (paymentType === "partial_balance") return "final_payment_pending_verification";
	return "pending";
}

export function paymentStatusForVerifiedPayment(paymentType: string) {
	if (paymentType === "deposit") return "deposit_paid";
	if (paymentType === "partial_balance") return "final_payment_required";
	if (paymentType === "final_balance") return "paid";
	if (paymentType === "full_payment") return "paid";
	throw new HttpError(400, "invalid_payment_type", `Unknown payment type: ${paymentType}`);
}

export function paymentAmountForType(
	request: Record<string, any>,
	paymentType: string,
	requestedAmount?: number,
) {
	const serviceTags = Array.isArray(request.service_tags)
		? request.service_tags.map(String)
		: Array.isArray(request.serviceTags)
			? request.serviceTags.map(String)
			: [];
	if (serviceTags.includes("assignment")) {
		if (paymentType === "final_balance" || paymentType === "partial_balance") return 0;
		if (
			typeof requestedAmount === "number" &&
			Number.isFinite(requestedAmount) &&
			requestedAmount > 0 &&
			Math.abs(roundMoney(requestedAmount) - 10) > 0.01
		) {
			throw new HttpError(
				400,
				"payment_amount_mismatch",
				"Assignment payment amount must be exactly GHS 10",
				{
					requestedAmount: roundMoney(requestedAmount),
					expectedAmount: 10,
					paymentType,
				},
			);
		}
		return 10;
	}

	let baseAmount = Number(
		request.final_amount ??
			request.payment_amount ??
			request.quoted_amount ??
			request.budget_min ??
			0,
	);

	// Safety fallback: if the stored amount is 0 but the service tag has a
	// predefined starting price, use that price so the user is never asked to
	// pay GHS 0. This handles cases where the amount wasn't properly saved
	// during request creation (e.g. unrecognized service tag at creation time).
	if (!Number.isFinite(baseAmount) || baseAmount <= 0) {
		const pricedTags = serviceTags.filter(
			(tag) => SERVICE_STARTING_PRICES[tag] !== undefined,
		);
		if (pricedTags.length > 0) {
			const fallbackPrice = pricedTags.reduce(
				(sum, tag) => sum + (SERVICE_STARTING_PRICES[tag] ?? 0),
				0,
			);
			if (fallbackPrice > 0) {
				baseAmount = roundMoney(fallbackPrice * (1 - LAUNCH_DISCOUNT_RATE));
			}
		}
	}

	let computedAmount = baseAmount;
	if (paymentType === "full_payment") {
		computedAmount = baseAmount;
	} else if (paymentType === "deposit") {
		computedAmount = roundMoney(Number(request.deposit_amount ?? baseAmount) || baseAmount);
	} else if (paymentType === "final_balance" || paymentType === "partial_balance") {
		const depositAmount = Number(request.deposit_amount ?? 0);
		computedAmount = roundMoney(
			Math.max(Number(request.balance_amount ?? baseAmount - depositAmount), 0),
		);
	}

	if (paymentType === "partial_balance") {
		const partialAmount = roundMoney(Number(requestedAmount ?? 0));
		const minimumPartial = roundMoney(computedAmount * 0.5);
		if (
			!Number.isFinite(partialAmount) ||
			partialAmount <= 0 ||
			partialAmount > roundMoney(computedAmount) ||
			Math.abs(partialAmount - minimumPartial) > 0.01
		) {
			throw new HttpError(
				400,
				"invalid_partial_balance_amount",
				"Partial balance payment must be half of the remaining balance",
				{
					requestedAmount: partialAmount,
					expectedAmount: minimumPartial,
					paymentType,
				},
			);
		}
		return partialAmount;
	}

	if (
		typeof requestedAmount === "number" &&
		Number.isFinite(requestedAmount) &&
		requestedAmount > 0 &&
		Math.abs(roundMoney(requestedAmount) - roundMoney(computedAmount)) > 0.01
	) {
		throw new HttpError(
			400,
			"payment_amount_mismatch",
			"Payment amount must match the approved request amount",
			{
				requestedAmount: roundMoney(requestedAmount),
				expectedAmount: roundMoney(computedAmount),
				paymentType,
			},
		);
	}

	return computedAmount;
}

export function refundEligibilityForRequest(
	request: Record<string, any>,
	payment: Record<string, any>,
) {
	const status = String(request.status ?? "");
	const deliveryStatus = String(request.delivery_status ?? "");
	const refundStatus = String(payment.refund_status ?? "none");
	const paidAt = payment.verified_at ? new Date(payment.verified_at) : null;
	const requestAgeDays = paidAt ? (Date.now() - paidAt.getTime()) / (1000 * 60 * 60 * 24) : 0;

	if (refundStatus !== "none") {
		return { eligible: false, reason: "A refund review already exists for this payment" };
	}
	if (String(payment.status ?? "") !== "verified") {
		return { eligible: false, reason: "Only verified payments can be reviewed for refund" };
	}
	if (
		["downloaded", "accepted"].includes(deliveryStatus) ||
		["completed", "closed"].includes(status)
	) {
		return {
			eligible: false,
			reason: "Delivered, downloaded, accepted, or closed work is not normally refundable",
		};
	}
	if (
		requestAgeDays > 14 &&
		!["non_delivery", "scope_mismatch"].includes(String(request.refund_reason_category ?? ""))
	) {
		return {
			eligible: false,
			reason: "Refund review must normally be requested within 14 days of payment",
		};
	}

	return { eligible: true, reason: "Eligible for support review" };
}
