import { HttpError } from "./errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handleRouteError(context: any) {
  const { code, error, set } = context;
  if (error instanceof HttpError) {
    set.status = error.status;
    return { success: false, error: error.message, errorCode: error.code };
  }
  if (code === "VALIDATION") {
    set.status = 400;
    return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
  }
  console.error("[route] Error:", error);
  set.status = 500;
  return { success: false, error: String(error) };
}
