import { createHash } from "node:crypto";

import { getConfiguredGeminiKeyCount, getNextGeminiKey } from "./gemini-keys";

export type SupportAiActionItem = {
  type: "create_request" | "reference_file" | "contact_support";
  label: string;
  data: Record<string, unknown>;
};

export type SupportAiResponse = {
  reasoning: string;
  response: string;
  complexity: "simple" | "complex";
  actionItems: SupportAiActionItem[];
};

const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const PUBLIC_MODEL_NAMES: Record<string, string> = {
  "gemini-3.1-flash-lite": "CognizApp Lite",
  "gemini-3.1-flash": "CognizApp Pro",
};
const SUPPORT_AI_MAX_ATTEMPTS = 3;
const SUPPORT_AI_TIMEOUT_MS = 15000;
const SUPPORT_AI_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    reasoning: { type: "STRING" },
    response: { type: "STRING" },
    complexity: { type: "STRING", enum: ["simple", "complex"] },
    actionItems: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          type: { type: "STRING", enum: ["create_request", "reference_file", "contact_support"] },
          label: { type: "STRING" },
          data: { type: "OBJECT" },
        },
        required: ["type", "label", "data"],
      },
    },
  },
  required: ["reasoning", "response", "complexity", "actionItems"],
};

export function getSupportAiModel() {
  return process.env.SUPPORT_AI_MODEL?.trim() || DEFAULT_MODEL;
}

export function getPublicSupportAiModelName(model = getSupportAiModel()) {
  return PUBLIC_MODEL_NAMES[model] || "CognizApp Lite";
}

export function hashSupportPrompt(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function fallbackResponse(prompt: string): SupportAiResponse {
  const complexSignals = [
    "deadline",
    "write",
    "build",
    "research",
    "assignment",
    "chapter",
    "analysis",
    "project",
    "urgent",
  ];
  const lowerPrompt = prompt.toLowerCase();
  const isComplex = complexSignals.some((signal) => lowerPrompt.includes(signal));

  return {
    reasoning: isComplex
      ? "The request appears to involve scoped work, deliverables, or timing. It should be captured as a support request so deadline, budget, files, and payment can be tracked."
      : "The request is narrow enough for a direct support assistant response without opening a project request.",
    response: isComplex
      ? "This looks like a project request. Create a support request with the deadline, expected output, budget, and any reference files so the team can quote and track it properly."
      : "I can help with that here. Share the exact issue or question and include any related request or file reference if it affects an existing project.",
    complexity: isComplex ? "complex" : "simple",
    actionItems: isComplex
      ? [
          {
            type: "create_request",
            label: "Create a tracked support request",
            data: { reason: "complex_scope_or_deadline_required" },
          },
        ]
      : [],
  };
}

function parseSupportAiJson(text: string): SupportAiResponse {
  const trimmed = text.trim();
  const cleaned = trimmed
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const parsed = JSON.parse(cleaned) as Partial<SupportAiResponse>;

  return {
    reasoning: String(parsed.reasoning ?? ""),
    response: String(parsed.response ?? ""),
    complexity: parsed.complexity === "complex" ? "complex" : "simple",
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems.map((item) => ({
          type:
            item?.type === "reference_file" || item?.type === "contact_support"
              ? item.type
              : "create_request",
          label: String(item?.label ?? "Next action"),
          data: item?.data && typeof item.data === "object" ? item.data : {},
        }))
      : [],
  };
}

async function postSupportAiPayload(model: string, apiKey: string, payload: Record<string, unknown>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPPORT_AI_TIMEOUT_MS);
  try {
    return await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateSupportAiResponse(input: {
  prompt: string;
  requestReferences?: unknown[];
  fileReferences?: unknown[];
  inlineFiles?: Array<{ mimeType: string; data: string; displayName?: string }>;
  history?: unknown[];
}) {
  const apiKey = await getNextGeminiKey();
  const model = getSupportAiModel();
  const prompt = input.prompt.trim();

  if (!getConfiguredGeminiKeyCount() || !apiKey) {
    return { model, ...fallbackResponse(prompt), provider: "fallback" as const };
  }

  const systemPrompt = [
    "You are the CognizApp support assistant.",
    "Return strict JSON only with keys: reasoning, response, complexity, actionItems.",
    "The reasoning must be visible and concise for the user interface.",
    "Use complexity='simple' for direct help. Use complexity='complex' when a tracked support request, deadline, budget, files, quote, or agent delegation is needed.",
    "actionItems is an array of objects with type create_request, reference_file, or contact_support; label; and data.",
  ].join("\n");

  const userParts: Array<Record<string, unknown>> = [
    {
      text: JSON.stringify({
        prompt,
        requestReferences: input.requestReferences ?? [],
        fileReferences: input.fileReferences ?? [],
        inlineFileNames: input.inlineFiles?.map((file) => file.displayName).filter(Boolean) ?? [],
        history: input.history ?? [],
      }),
    },
    ...(input.inlineFiles ?? []).map((file) => ({
      inlineData: {
        mimeType: file.mimeType || "application/octet-stream",
        data: file.data,
      },
    })),
  ];

  const payload = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: userParts,
      },
    ],
    generationConfig: {
      temperature: 0.25,
      responseMimeType: "application/json",
      responseSchema: SUPPORT_AI_RESPONSE_SCHEMA,
      thinkingConfig: {
        thinkingBudget: 128,
      },
    },
  };

  let lastError: unknown = null;
  const attempts = Math.min(SUPPORT_AI_MAX_ATTEMPTS, Math.max(1, getConfiguredGeminiKeyCount()));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const attemptKey = attempt === 0 ? apiKey : await getNextGeminiKey();
    if (!attemptKey) break;
    try {
      const response = await postSupportAiPayload(model, attemptKey, payload);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`CognizApp AI request failed with ${response.status}: ${detail.slice(0, 500)}`);
      }
      const data = (await response.json()) as any;
      const text = String(
        data?.candidates?.[0]?.content?.parts
          ?.map((part: Record<string, unknown>) => part.text ?? "")
          .join("\n") ?? "",
      );
      return { model, ...parseSupportAiJson(text), provider: "cognizap" as const };
    } catch (error) {
      lastError = error;
      console.warn(`[gemini] Attempt ${attempt + 1}/${attempts} failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  throw lastError ?? new Error("CognizApp AI request failed");
}
