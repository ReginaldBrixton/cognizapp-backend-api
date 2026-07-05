/**
 * Request body and estimate helper functions extracted from routes.ts.
 */

import { HttpError } from "../../lib/errors";
import { estimateSupportCostLocal } from "./cost-estimation";
import { roundMoney } from "./shared";
import { DEFAULT_SUPPORT_TIMEZONE } from "./constants";

export function requestEstimateInput(request: Record<string, any>) {
	return {
		academicLevel: request.academic_level,
		serviceCategory: Array.isArray(request.service_tags) ? request.service_tags[0] : undefined,
		serviceTags: Array.isArray(request.service_tags) ? request.service_tags : [],
		selectedChapters: Array.isArray(request.draft_payload?.selectedChapters)
			? request.draft_payload.selectedChapters
			: [],
		budgetMin: Number(request.budget_min ?? 0) || undefined,
		budgetMax: Number(request.budget_max ?? 0) || undefined,
		dataCollectionOwner: request.draft_payload?.dataCollectionOwner,
		analysisOwner: request.draft_payload?.analysisOwner,
		includeSlides: Boolean(request.draft_payload?.includeSlides),
		assistance24x7: Boolean(request.draft_payload?.assistance24x7),
		description: request.description,
		pages: Number(request.pages ?? 0) || undefined,
		wordCount: Number(request.word_count ?? 0) || undefined,
		deadlineAt: request.deadline_at ? new Date(request.deadline_at).toISOString() : undefined,
		correctionCommentCount: Number(request.draft_payload?.correctionCommentCount ?? 0) || undefined,
	};
}

export function requestEstimateInputFromBody(body: Record<string, any>) {
	return {
		academicLevel: body.academicLevel,
		serviceCategory: Array.isArray(body.serviceTags) ? body.serviceTags[0] : undefined,
		serviceTags: Array.isArray(body.serviceTags) ? body.serviceTags : [],
		selectedChapters: Array.isArray(body.selectedChapters) ? body.selectedChapters : [],
		budgetMin: Number(body.budgetMin ?? 0) || undefined,
		budgetMax: Number(body.budgetMax ?? 0) || undefined,
		dataCollectionOwner: body.dataCollectionOwner,
		analysisOwner: body.analysisOwner,
		includeSlides: Boolean(body.includeSlides),
		assistance24x7: Boolean(body.assistance24x7),
		description: body.description,
		pages: Number(body.pages ?? 0) || undefined,
		wordCount: Number(body.wordCount ?? 0) || undefined,
		deadlineAt: body.deadlineAt ? new Date(body.deadlineAt).toISOString() : undefined,
		correctionCommentCount: Number(body.correctionCommentCount ?? 0) || undefined,
	};
}

export function assertAssignmentRequestBody(body: Record<string, any>) {
	const serviceTags = Array.isArray(body.serviceTags) ? body.serviceTags.map(String) : [];
	const isAssignment = serviceTags.includes("assignment") || body.serviceCategory === "assignment";
	if (!isAssignment) return;
	if (serviceTags.length > 1) {
		throw new HttpError(
			400,
			"assignment_single_service",
			"Assignment requests can only contain one assignment service.",
		);
	}
	const instructions = String(body.assignmentInstructions ?? body.description ?? "").trim();
	if (!instructions) {
		throw new HttpError(
			400,
			"assignment_instructions_required",
			"Assignment instructions are required.",
		);
	}
	body.serviceTags = ["assignment"];
	body.serviceCategory = "assignment";
	body.assignmentInstructions = instructions;
	body.paymentMode = "before_work";
	body.preferredPaymentMode = "before_work";
	body.depositPercent = 100;
	if (!String(body.description ?? "").trim()) body.description = instructions;
}

export function bodyWithAuthoritativeEstimate(body: Record<string, any>): Record<string, any> {
	const estimateInput = requestEstimateInputFromBody(body);
	const localEstimate = estimateSupportCostLocal(estimateInput);
	const isAssignment =
		estimateInput.serviceCategory === "assignment" ||
		(estimateInput.serviceTags ?? []).includes("assignment");
	const clientEstimate =
		body.costEstimate && typeof body.costEstimate === "object" ? body.costEstimate : {};
	const trustedTotal = isAssignment ? 10 : roundMoney(localEstimate.range.min);
	const trustedMax = isAssignment
		? 10
		: roundMoney(Math.max(localEstimate.range.max, trustedTotal));

	return {
		...body,
		paymentMode: "before_work",
		preferredPaymentMode: "before_work",
		depositPercent: 100,
		costEstimate: {
			...clientEstimate,
			total: trustedTotal,
			min: trustedTotal,
			max: trustedMax,
			range: {
				min: trustedTotal,
				max: trustedMax,
			},
			serverMinimumTotal: localEstimate.range.min,
			provider: "server-local",
		},
	};
}

export function formatRequestDeadline(deadlineAt: unknown) {
	if (!deadlineAt) return "the agreed deadline";
	const date = new Date(String(deadlineAt));
	if (!Number.isFinite(date.getTime())) return "the agreed deadline";
	return date.toLocaleString("en-GB", {
		timeZone: DEFAULT_SUPPORT_TIMEZONE,
		dateStyle: "medium",
		timeStyle: "short",
	});
}
