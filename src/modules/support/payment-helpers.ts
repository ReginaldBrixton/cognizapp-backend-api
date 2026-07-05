/**
 * Payment-related helper functions extracted from routes.ts.
 */

/**
 * Determine the appropriate payment status to reset to after a payment
 * is cancelled, based on the payment type and current request state.
 */
export function retryablePaymentStatusAfterCancel(
	paymentType: string,
	request: Record<string, any>,
) {
	const currentRequestStatus = String(
		request.request_payment_status ?? request.payment_status ?? "unpaid",
	);
	// If the deposit has already been paid, don't reset below "deposit_paid".
	if (paymentType === "deposit") {
		return currentRequestStatus === "deposit_paid" ? "deposit_paid" : "deposit_required";
	}
	if (paymentType === "full_payment") {
		return currentRequestStatus === "deposit_paid" ? "final_payment_required" : "unpaid";
	}
	if (paymentType === "final_balance" || paymentType === "partial_balance")
		return "final_payment_required";
	const depositAmount = Number(request.deposit_amount ?? 0);
	const totalAmount = Number(
		request.final_amount ?? request.payment_amount ?? request.quoted_amount ?? 0,
	);
	if (currentRequestStatus === "deposit_paid") return "final_payment_required";
	return depositAmount > 0 && depositAmount < totalAmount ? "deposit_required" : "unpaid";
}
