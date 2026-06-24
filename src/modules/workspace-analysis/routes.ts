import { Elysia, t } from "elysia";
import { HttpError } from "../../lib/errors";
import { resolveAuth } from "../auth/middleware";
import { analysisService } from "./service";
import { isValidUuid, sanitizeInput, VALIDATION_LIMITS } from "../../lib/validation";

const TEXT_MAX_LENGTH = 50000;

const HumaniseBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  originalText: t.String({ minLength: 1, maxLength: TEXT_MAX_LENGTH }),
});

const TextCompareBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  textA: t.String({ minLength: 1, maxLength: TEXT_MAX_LENGTH }),
  textB: t.String({ minLength: 1, maxLength: TEXT_MAX_LENGTH }),
});

const TextIdentifyBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  inputText: t.String({ minLength: 1, maxLength: TEXT_MAX_LENGTH }),
});

const FactCheckBody = t.Object({
  title: t.String({ minLength: 1, maxLength: VALIDATION_LIMITS.TITLE_MAX_LENGTH }),
  claimText: t.String({ minLength: 1, maxLength: TEXT_MAX_LENGTH }),
});

export const analysisRoutes = new Elysia({ prefix: "/api/workspace/:workspaceId/analysis", tags: ["workspace-analysis"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return { success: false, error: error.message, errorCode: error.code };
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return { success: false, error: "Invalid request body", errorCode: "invalid_request" };
    }
  })
  .get("/", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    return await analysisService.listAnalysis(auth.userId, params.workspaceId);
  })
  .post("/humanise", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await analysisService.createHumanise(auth.userId, params.workspaceId, sanitized);
  }, {
    body: HumaniseBody,
  })
  .post("/textcompare", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await analysisService.createTextCompare(auth.userId, params.workspaceId, sanitized);
  }, {
    body: TextCompareBody,
  })
  .post("/textidentify", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await analysisService.createTextIdentify(auth.userId, params.workspaceId, sanitized);
  }, {
    body: TextIdentifyBody,
  })
  .post("/factcheck", async ({ headers, params, body }) => {
    if (!isValidUuid(params.workspaceId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid workspace ID");
    }
    const auth = await resolveAuth(headers);
    const sanitized = sanitizeInput(body) as Record<string, unknown>;
    return await analysisService.createFactCheck(auth.userId, params.workspaceId, sanitized);
  }, {
    body: FactCheckBody,
  })
  .get("/:analysisId", async ({ headers, params }) => {
    if (!isValidUuid(params.workspaceId) || !isValidUuid(params.analysisId)) {
      throw new HttpError(400, "invalid_uuid", "Invalid ID");
    }
    const auth = await resolveAuth(headers);
    return await analysisService.getAnalysis(auth.userId, params.workspaceId, params.analysisId);
  });
