import { Elysia, t } from "elysia";

import { HttpError } from "../../lib/errors";
import { fail, ok } from "../../lib/http";
import { resolveAuth } from "../auth/middleware";
import { onboardingRepository } from "./repository";

const VALID_GENDERS = ["male", "female", "non_binary", "prefer_not_to_say", "other"] as const;
const VALID_USER_TYPES = ["student", "researcher", "faculty", "professional", "other"] as const;
const VALID_USE_CASES = ["academic_writing", "research_papers", "collaborative_projects", "personal_notes", "other"] as const;
const VALID_EXPERIENCE = ["beginner", "intermediate", "advanced", "expert"] as const;
const VALID_HOW_HEARD = ["google", "social_media", "colleague", "institution", "other"] as const;

const OnboardingBody = t.Object({
  // Personal info
  date_of_birth: t.Optional(t.Nullable(t.String())),
  gender: t.Optional(t.Nullable(t.String())),
  country: t.Optional(t.Nullable(t.String())),
  city: t.Optional(t.Nullable(t.String())),
  // Academic / professional
  user_type: t.Optional(t.Nullable(t.String())),
  institution: t.Optional(t.Nullable(t.String())),
  department: t.Optional(t.Nullable(t.String())),
  position_title: t.Optional(t.Nullable(t.String())),
  field_of_study: t.Optional(t.Nullable(t.String())),
  research_interests: t.Optional(t.Array(t.String())),
  // Platform
  primary_use_case: t.Optional(t.Nullable(t.String())),
  experience_level: t.Optional(t.Nullable(t.String())),
  how_did_you_hear: t.Optional(t.Nullable(t.String())),
  // Consent
  consent_analytics: t.Optional(t.Boolean()),
  consent_ai_training: t.Optional(t.Boolean()),
  consent_marketing: t.Optional(t.Boolean()),
  // Step tracking
  steps_completed: t.Optional(t.Record(t.String(), t.Boolean())),
});

function validateEnum<T extends string>(value: string | null | undefined, valid: readonly T[], field: string): void {
  if (value && !(valid as readonly string[]).includes(value)) {
    throw new HttpError(400, "invalid_value", `${field} must be one of: ${valid.join(", ")}`);
  }
}

export const onboardingRoutes = new Elysia({ prefix: "/api/user/onboarding", tags: ["onboarding"] })
  .onError(({ code, error, set }) => {
    if (error instanceof HttpError) {
      set.status = error.status;
      return fail(error.message, error.code);
    }
    if (code === "VALIDATION") {
      set.status = 400;
      return fail("Invalid request body", "invalid_request");
    }
  })

  // ── GET /api/user/onboarding ───────────────────────────────────────────────
  // Returns the authenticated user's onboarding record (creates if missing).
  .get("/", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    let record = await onboardingRepository.getByUserId(auth.userId);
    if (!record) {
      record = await onboardingRepository.upsert(auth.userId, auth.email);
    }
    return ok({ onboarding: record });
  })

  // ── POST /api/user/onboarding ──────────────────────────────────────────────
  // Update one or more onboarding fields.
  .post(
    "/",
    async ({ headers, body }) => {
      const auth = await resolveAuth(headers);

      validateEnum(body.gender, VALID_GENDERS, "gender");
      validateEnum(body.user_type, VALID_USER_TYPES, "user_type");
      validateEnum(body.primary_use_case, VALID_USE_CASES, "primary_use_case");
      validateEnum(body.experience_level, VALID_EXPERIENCE, "experience_level");
      validateEnum(body.how_did_you_hear, VALID_HOW_HEARD, "how_did_you_hear");

      // Ensure a row exists
      let record = await onboardingRepository.getByUserId(auth.userId);
      if (!record) {
        await onboardingRepository.upsert(auth.userId, auth.email);
      }

      record = await onboardingRepository.update(auth.userId, {
        dateOfBirth: body.date_of_birth,
        gender: body.gender,
        country: body.country,
        city: body.city,
        userType: body.user_type,
        institution: body.institution,
        department: body.department,
        positionTitle: body.position_title,
        fieldOfStudy: body.field_of_study,
        researchInterests: body.research_interests,
        primaryUseCase: body.primary_use_case,
        experienceLevel: body.experience_level,
        howDidYouHear: body.how_did_you_hear,
        consentAnalytics: body.consent_analytics,
        consentAiTraining: body.consent_ai_training,
        consentMarketing: body.consent_marketing,
        stepsCompleted: body.steps_completed,
      });

      return ok({ onboarding: record });
    },
    { body: OnboardingBody },
  )

  // ── POST /api/user/onboarding/complete ────────────────────────────────────
  // Mark onboarding as fully completed.
  .post("/complete", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    let record = await onboardingRepository.getByUserId(auth.userId);
    if (!record) {
      await onboardingRepository.upsert(auth.userId, auth.email);
    }
    record = await onboardingRepository.markCompleted(auth.userId);
    return ok({ onboarding: record, message: "Onboarding completed" });
  })

  // ── POST /api/user/onboarding/skip ────────────────────────────────────────
  // Mark onboarding as skipped (can re-open later from settings).
  .post("/skip", async ({ headers }) => {
    const auth = await resolveAuth(headers);
    let record = await onboardingRepository.getByUserId(auth.userId);
    if (!record) {
      await onboardingRepository.upsert(auth.userId, auth.email);
    }
    record = await onboardingRepository.markSkipped(auth.userId);
    return ok({ onboarding: record, message: "Onboarding skipped" });
  });
