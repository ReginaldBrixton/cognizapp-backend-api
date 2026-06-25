// ─── ai-routes.ts ─────────────────────────────────────────────────────────────
// AI extraction and streaming chat endpoints for the intelligent support wizard.
// Registered under /api/support/ai prefix in create-app.ts.
//
// Endpoints:
//   POST /api/support/ai/extract-comments   — supervisor comment extraction
//   POST /api/support/ai/extract-structure  — document chapter/section extraction
//   POST /api/support/ai/suggest-analysis   — dataset column + analysis suggestions
//   POST /api/support/ai/wizard-chat        — SSE streaming wizard chat with thinking
//
// Auth:  All routes require a valid session (Bearer token forwarded by Next.js proxy).
// Rate:  20 extraction requests/hour, 60 chat messages/hour per user.

import { Elysia, t } from "elysia"
import { inflateRawSync } from "node:zlib"
import { resolveAuth } from "../auth/middleware"
import { getNextGeminiKey } from "../../lib/gemini-keys"

// ---------------------------------------------------------------------------
// Model configuration (single source of truth — never expose to frontend)
// ---------------------------------------------------------------------------

// Primary chat model — Gemini 3.1 Flash-Lite (GA, March 2026)
// High-volume, low-latency, multimodal, supports thinkingLevel config
// Model string: gemini-3.1-flash-lite
// Thinking config uses thinkingLevel: "minimal" | "low" | "medium" | "high"
const GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite"

// Extraction model — same model, reliable JSON output at high throughput
const GEMINI_EXTRACT_MODEL = "gemini-3.1-flash-lite"

// ---------------------------------------------------------------------------
// In-memory rate limiter (per userId, per endpoint group)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number
  windowStart: number
}

const EXTRACTION_LIMIT = 20
const CHAT_LIMIT = 60
const WINDOW_MS = 60 * 60 * 1000 // 1 hour

const extractionRateMap = new Map<string, RateLimitEntry>()
const chatRateMap = new Map<string, RateLimitEntry>()

function checkRateLimit(
  map: Map<string, RateLimitEntry>,
  userId: string,
  limit: number,
): boolean {
  const now = Date.now()
  const entry = map.get(userId)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    map.set(userId, { count: 1, windowStart: now })
    return true
  }
  if (entry.count >= limit) return false
  entry.count += 1
  return true
}

// ---------------------------------------------------------------------------
// Gemini API helpers
// ---------------------------------------------------------------------------

async function callGeminiExtract(
  prompt: string,
  file: GeminiExtractionFile,
): Promise<string> {
  const apiKey = await getNextGeminiKey()
  const filePart = await buildGeminiExtractionPart(file)
  if (!apiKey) {
    return callCompletionExtract(prompt, filePart)
  }

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          filePart,
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
    },
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EXTRACT_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`AI extraction failed (${response.status}): ${errorText}`)
  }

  const result = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
    }>
  }
  return result.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
}

async function callCompletionExtract(prompt: string, filePart: GeminiPart): Promise<string> {
  const configuredUrl = (
    process.env.COGNIZAP_COMPLETION_URL ||
    "https://api.cognizapp.com/v1/chat/completions"
  ).trim().replace(/\/+$/, "")
  const completionUrl = configuredUrl.endsWith("/v1/chat/completions")
    ? configuredUrl
    : `${configuredUrl}/v1/chat/completions`
  const token = (
    process.env.COGNIZAP_COMPLETION_TOKEN ||
    process.env.COGNIZAP_API_KEY ||
    ""
  ).trim()

  if (!token) {
    throw new Error("AI extraction is not configured on the server")
  }

  const content = filePartToCompletionContent(filePart)
  const response = await fetch(completionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: GEMINI_EXTRACT_MODEL,
      stream: false,
      temperature: 0.1,
      max_tokens: 8192,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            ...content,
          ],
        },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`AI extraction failed (${response.status}): ${errorText}`)
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  }
  const contentValue = result.choices?.[0]?.message?.content
  if (typeof contentValue === "string") return contentValue
  if (Array.isArray(contentValue)) {
    return contentValue.map((part) => part.text ?? "").join("")
  }
  return ""
}

async function callCompletionChat(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  message: string,
): Promise<string> {
  const configuredUrl = (
    process.env.COGNIZAP_COMPLETION_URL ||
    "https://api.cognizapp.com/v1/chat/completions"
  ).trim().replace(/\/+$/, "")
  const completionUrl = configuredUrl.endsWith("/v1/chat/completions")
    ? configuredUrl
    : `${configuredUrl}/v1/chat/completions`
  const token = (
    process.env.COGNIZAP_COMPLETION_TOKEN ||
    process.env.COGNIZAP_API_KEY ||
    ""
  ).trim()

  if (!token) {
    throw new Error("AI chat is not configured on the server")
  }

  const response = await fetch(completionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: GEMINI_CHAT_MODEL,
      stream: false,
      temperature: 0.7,
      max_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((item) => ({
          role: item.role === "user" ? "user" : "assistant",
          content: item.content,
        })),
        { role: "user", content: message },
      ],
    }),
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error")
    throw new Error(`AI chat fallback failed (${response.status}): ${errorText.slice(0, 200)}`)
  }

  const result = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  }
  const content = result.choices?.[0]?.message?.content
  if (typeof content === "string" && content.trim()) return content
  if (Array.isArray(content)) {
    const text = content.map((part) => part.text ?? "").join("").trim()
    if (text) return text
  }
  throw new Error("AI chat fallback returned an empty response")
}

type GeminiExtractionFile = {
  buffer: Buffer
  fileName: string
  mimeType: string
}

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } }

function filePartToCompletionContent(filePart: GeminiPart) {
  if ("text" in filePart) {
    return [{ type: "text", text: filePart.text }]
  }
  return [{
    type: "image_url",
    image_url: {
      url: `data:${filePart.inline_data.mime_type};base64,${filePart.inline_data.data}`,
    },
  }]
}

const GEMINI_INLINE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "text/plain",
  "text/csv",
  "text/markdown",
])

function getFileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".")
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : ""
}

function isDocxFile(fileName: string, mimeType: string) {
  return (
    getFileExtension(fileName) === "docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  )
}

function isTextLikeFile(fileName: string, mimeType: string) {
  const extension = getFileExtension(fileName)
  return (
    mimeType.startsWith("text/") ||
    ["csv", "txt", "md", "json", "xml", "html", "css", "js", "ts"].includes(extension)
  )
}

async function buildGeminiExtractionPart(file: GeminiExtractionFile): Promise<GeminiPart> {
  if (isDocxFile(file.fileName, file.mimeType)) {
    const text = extractDocxText(file.buffer)
    if (!text.trim()) {
      throw new Error("The DOCX file could not be read. Please upload a readable Word document.")
    }
    return {
      text: [
        `Uploaded file: ${file.fileName}`,
        "The original upload was a DOCX file. Its readable text was extracted server-side because the AI model does not accept DOCX binary MIME input.",
        "",
        text,
      ].join("\n"),
    }
  }

  if (isTextLikeFile(file.fileName, file.mimeType)) {
    return {
      text: [
        `Uploaded file: ${file.fileName}`,
        "",
        file.buffer.toString("utf8"),
      ].join("\n"),
    }
  }

  const inlineMimeType = GEMINI_INLINE_MIME_TYPES.has(file.mimeType)
    ? file.mimeType
    : "application/octet-stream"

  return {
    inline_data: {
      mime_type: inlineMimeType,
      data: file.buffer.toString("base64"),
    },
  }
}

function extractDocxText(buffer: Buffer) {
  const entries = readZipEntries(buffer)
  const documentXml = entries.get("word/document.xml") ?? ""
  const commentsXml = entries.get("word/comments.xml") ?? ""
  const footnotesXml = entries.get("word/footnotes.xml") ?? ""
  const endnotesXml = entries.get("word/endnotes.xml") ?? ""

  return [
    documentXml ? "Document text:\n" + wordXmlToText(documentXml) : "",
    commentsXml ? "Reviewer comments:\n" + wordXmlToText(commentsXml) : "",
    footnotesXml ? "Footnotes:\n" + wordXmlToText(footnotesXml) : "",
    endnotesXml ? "Endnotes:\n" + wordXmlToText(endnotesXml) : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function readZipEntries(buffer: Buffer) {
  const entries = new Map<string, string>()
  const eocdOffset = findEndOfCentralDirectory(buffer)
  if (eocdOffset < 0) return entries

  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16)
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize
  let offset = centralDirectoryOffset

  while (offset + 46 <= centralDirectoryEnd && offset + 46 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset)
    if (signature !== 0x02014b50) break

    const compressionMethod = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const fileNameLength = buffer.readUInt16LE(offset + 28)
    const extraFieldLength = buffer.readUInt16LE(offset + 30)
    const fileCommentLength = buffer.readUInt16LE(offset + 32)
    const localHeaderOffset = buffer.readUInt32LE(offset + 42)
    const fileNameStart = offset + 46
    const fileNameEnd = fileNameStart + fileNameLength
    const nextOffset = fileNameEnd + extraFieldLength + fileCommentLength

    if (fileNameEnd > buffer.length) break

    const localHeaderSignature = buffer.readUInt32LE(localHeaderOffset)
    if (localHeaderSignature !== 0x04034b50) {
      offset = nextOffset
      continue
    }

    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
    const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28)
    const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength
    const dataEnd = dataStart + compressedSize

    if (dataEnd > buffer.length) break

    const fileName = buffer.subarray(fileNameStart, fileNameEnd).toString("utf8").replace(/\\/g, "/")
    const compressed = buffer.subarray(dataStart, dataEnd)

    if (fileName.endsWith(".xml")) {
      try {
        const data =
          compressionMethod === 0
            ? compressed
            : compressionMethod === 8
              ? inflateRawSync(compressed)
              : null

        if (data) entries.set(fileName, data.toString("utf8"))
      } catch {
        // Skip malformed entries; other DOCX parts may still be readable.
      }
    }

    offset = nextOffset
  }

  return entries
}

function findEndOfCentralDirectory(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - 0xffff - 22)
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

function wordXmlToText(xml: string) {
  return decodeXmlEntities(
    xml
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  )
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Calls the Gemini streaming chat endpoint.
 * Returns the raw fetch Response (SSE stream).
 *
 * SSE events from Gemini 2.0 Flash Thinking include two part types:
 *   - thought parts:  { thought: true, text: "<reasoning>" }
 *   - output parts:   { text: "<response>" }
 *
 * We forward both as typed SSE events so the frontend can render thinking
 * separately from the main reply.
 */
async function callGeminiChatStream(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  message: string,
): Promise<Response> {
  const apiKey = await getNextGeminiKey()
  if (!apiKey) throw new Error("No Gemini API keys configured")

  const contents = [
    // Inject system context as a priming exchange
    { role: "user", parts: [{ text: systemPrompt }] },
    {
      role: "model",
      parts: [
        {
          text: "Understood. I'm your CogniZap AI assistant, ready to help with your support request.",
        },
      ],
    },
    // Prior conversation history
    ...history.map((h) => ({
      role: h.role === "user" ? "user" : "model",
      parts: [{ text: h.content }],
    })),
    // Current message
    { role: "user", parts: [{ text: message }] },
  ]

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_CHAT_MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          // Gemini 3.1 Flash-Lite thinking config — uses thinkingLevel, not thinkingBudget
          // Must be nested inside generationConfig (not top-level)
          // includeThoughts: true exposes thought parts in the SSE stream
          // "high" advanced reasoning per user requirement
          thinkingConfig: {
            thinkingLevel: "high",
            includeThoughts: true,
          },
        },
      }),
    },
  )

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(`AI chat request failed (${response.status}): ${text.slice(0, 200)}`)
  }

  return response
}

function safeParseJSON(text: string): unknown {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  return JSON.parse(cleaned)
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const supportAiRoutes = new Elysia({ prefix: "/api/support/ai" })
  .onError(({ code, error, set }) => {
    if (code === "VALIDATION") {
      const validationError = error as { message?: string }
      set.status = 400
      return { error: "Invalid request body", details: validationError.message }
    }
  })

  // ── POST /extract-comments ───────────────────────────────────────────────
  .post("/extract-comments", async ({ request, set }) => {
    const auth = await resolveAuth(request.headers as unknown as Record<string, string>)
    if (!auth) {
      set.status = 401
      return { error: "Unauthorized" }
    }

    if (!checkRateLimit(extractionRateMap, auth.userId, EXTRACTION_LIMIT)) {
      set.status = 429
      return { error: "Rate limit exceeded. Try again in an hour." }
    }

    let file: File | undefined
    try {
      const form = await request.formData()
      file = (form.get("file") as File | null) ?? undefined
    } catch {
      set.status = 400
      return { error: "Could not parse upload" }
    }
    if (!file) {
      set.status = 400
      return { error: "No file provided" }
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || "application/octet-stream"

      const prompt = `You are a document review assistant for an academic support platform.
Extract all supervisor comments, track changes, and annotations from the provided document.
Return a JSON array only — no markdown, no extra text. Each item must have:
- "id": unique string ("c1", "c2", …)
- "text": the full comment text
- "location": context snippet or section name (empty string if unknown)
- "pageRef": page number as string (empty string if unknown)`

      const raw = await callGeminiExtract(prompt, {
        buffer,
        fileName: file.name,
        mimeType,
      })
      const parsed = safeParseJSON(raw) as Array<{
        id: string
        text: string
        location: string
        pageRef: string
      }>
      if (!Array.isArray(parsed)) throw new Error("Expected a JSON array")
      return { comments: parsed }
    } catch (error) {
      console.error("[ai-routes] extract-comments error:", error)
      set.status = 502
      return { error: error instanceof Error ? error.message : "Comment extraction failed" }
    }
  })

  // ── POST /extract-structure ──────────────────────────────────────────────
  .post("/extract-structure", async ({ request, set }) => {
    const auth = await resolveAuth(request.headers as unknown as Record<string, string>)
    if (!auth) {
      set.status = 401
      return { error: "Unauthorized" }
    }

    if (!checkRateLimit(extractionRateMap, auth.userId, EXTRACTION_LIMIT)) {
      set.status = 429
      return { error: "Rate limit exceeded. Try again in an hour." }
    }

    let file: File | undefined
    try {
      const form = await request.formData()
      file = (form.get("file") as File | null) ?? undefined
    } catch {
      set.status = 400
      return { error: "Could not parse upload" }
    }
    if (!file) {
      set.status = 400
      return { error: "No file provided" }
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || "application/octet-stream"

      const prompt = `You are a document structure analyzer for an academic support platform.
Extract chapter and section headings from the provided document.
Return a JSON object only — no markdown, no extra text:
{ "sections": [ { "title": string, "level": 1|2|3 } ] }
level 1 = chapter, 2 = section, 3 = subsection.`

      const raw = await callGeminiExtract(prompt, {
        buffer,
        fileName: file.name,
        mimeType,
      })
      const parsed = safeParseJSON(raw) as { sections: Array<{ title: string; level: number }> }
      if (!parsed || !Array.isArray(parsed.sections)) throw new Error("Expected { sections: [] }")
      return { sections: parsed.sections }
    } catch (error) {
      console.error("[ai-routes] extract-structure error:", error)
      set.status = 502
      return { error: error instanceof Error ? error.message : "Structure extraction failed" }
    }
  })

  // ── POST /suggest-analysis ───────────────────────────────────────────────
  .post("/suggest-analysis", async ({ request, set }) => {
    const auth = await resolveAuth(request.headers as unknown as Record<string, string>)
    if (!auth) {
      set.status = 401
      return { error: "Unauthorized" }
    }

    if (!checkRateLimit(extractionRateMap, auth.userId, EXTRACTION_LIMIT)) {
      set.status = 429
      return { error: "Rate limit exceeded. Try again in an hour." }
    }

    let file: File | undefined
    try {
      const form = await request.formData()
      file = (form.get("file") as File | null) ?? undefined
    } catch {
      set.status = 400
      return { error: "Could not parse upload" }
    }
    if (!file) {
      set.status = 400
      return { error: "No file provided" }
    }

    try {
      const buffer = Buffer.from(await file.arrayBuffer())
      const mimeType = file.type || "application/octet-stream"

      const prompt = `You are a data analysis assistant for an academic support platform.
Analyze the uploaded dataset (CSV, Excel, or SPSS file).
Return a JSON object only — no markdown, no extra text:
{
  "columns": [ { "name": string, "inferredType": "numeric"|"categorical"|"date"|"text"|"boolean" } ],
  "suggestions": [ string ]  // recommended analysis types
}`

      const raw = await callGeminiExtract(prompt, {
        buffer,
        fileName: file.name,
        mimeType,
      })
      const parsed = safeParseJSON(raw) as {
        columns: Array<{ name: string; inferredType: string }>
        suggestions: string[]
      }
      if (!parsed || !Array.isArray(parsed.columns)) throw new Error("Expected { columns: [], suggestions: [] }")
      return {
        columns: parsed.columns,
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      }
    } catch (error) {
      console.error("[ai-routes] suggest-analysis error:", error)
      set.status = 502
      return { error: error instanceof Error ? error.message : "Analysis suggestion failed" }
    }
  })

  // ── POST /chat (SSE streaming with thinking) ────────────────────────────
  .post("/wizard-chat", async ({ request, body: elysiaBody, set }) => {
    // Auth — resolveAuth reads the Authorization header
    let auth: Awaited<ReturnType<typeof resolveAuth>> | null = null
    try {
      auth = await resolveAuth(request.headers as unknown as Record<string, string>)
    } catch {
      set.status = 401
      return { error: "Unauthorized" }
    }
    if (!auth) {
      set.status = 401
      return { error: "Unauthorized" }
    }

    if (!checkRateLimit(chatRateMap, auth.userId, CHAT_LIMIT)) {
      set.status = 429
      return { error: "Rate limit exceeded. Max 60 messages per hour." }
    }

    // Use Elysia's pre-parsed body — never call request.json() after Elysia has consumed it
    const rawBody = elysiaBody as {
      message?: string
      serviceCategory?: string
      step?: string
      history?: Array<{ role: string; content: string }>
    } | null

    if (!rawBody || typeof rawBody !== "object") {
      set.status = 400
      return { error: "Invalid JSON body" }
    }

    const message = rawBody.message ?? ""
    const serviceCategory = rawBody.serviceCategory ?? ""
    const step = rawBody.step ?? ""
    const history = Array.isArray(rawBody.history) ? rawBody.history : []

    if (!message?.trim()) {
      set.status = 400
      return { error: "message is required" }
    }

    // Build system prompt — service-aware, no model info exposed
    const serviceName = serviceCategory
      ? serviceCategory.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : ""

    const noServiceYet = !serviceCategory
    const stepLabel = step || "0"

    // Catalogue of services so the AI can intelligently recommend one
    const serviceCatalogue = `Available services:
1. powerpoint-preparation — Slide decks for defenses, classes, conferences
2. full-project-support — End-to-end thesis/project support across phases
3. data-analysis — SPSS/R/Excel/Python statistical analysis from a dataset
4. excel-dashboard — Excel dashboards, KPIs, pivot reports, charts
5. chapter-editing — Chapter-level editing of an existing draft
6. thesis-formatting — Institutional formatting (APA, MLA, university styles)
7. proposal-review — Proposal review, restructuring, feedback
8. research-diagnostic — Diagnose research direction, gaps, methodology
9. literature-methodology — Literature review and methodology design
10. questionnaire-survey — Questionnaire/survey design and validation
11. citation-integrity — Citations, plagiarism, reference manager fixes
12. supervisor-comments — Address supervisor track-changes and comments`

    const systemPrompt = noServiceYet
      ? `You are an expert AI assistant embedded in CogniZap, an academic support platform.
The user is on the Service Selection step (Step ${stepLabel}) and has NOT yet picked a service.
Your job: ask 1-2 brief diagnostic questions to understand their need, then recommend ONE service from the catalogue.
${serviceCatalogue}
Guidelines:
- Be warm, concise, and academically precise.
- If the user describes their problem, recommend the BEST matching service by exact name (e.g., "I recommend 'data-analysis'").
- Never ask for payment or login info.
- Keep replies under 150 words unless asked for more.`
      : `You are an expert AI assistant embedded in CogniZap, an academic support platform.
The user is completing the "${serviceName}" service request wizard. Current step: "${stepLabel}".
Guidelines:
- Be warm, concise, and academically precise.
- Guide them to provide clear, complete information specific to ${serviceName}.
- If they seem uncertain, offer concrete examples for this service type.
- Never ask for payment or login info.
- Keep replies under 250 words unless asked for more.`

    try {
      let geminiResponse: Response | null = null
      let fallbackText: string | null = null
      try {
        geminiResponse = await callGeminiChatStream(systemPrompt, history, message.trim())
      } catch (geminiError) {
        console.warn("[ai-routes] Gemini chat unavailable; using completion fallback", geminiError)
        fallbackText = await callCompletionChat(systemPrompt, history, message.trim())
      }

      if (fallbackText !== null) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller: ReadableStreamDefaultController<Uint8Array>) {
            const encoder = new TextEncoder()
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: "token", text: fallbackText })}\n\n`,
              ),
            )
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          },
        })
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
          },
        })
      }

      if (!geminiResponse) {
        throw new Error("AI chat did not return a response")
      }

      // Build a TransformStream that parses Gemini SSE chunks and emits typed events:
      //   data: {"type":"thinking","text":"..."}\n\n   — reasoning from thinking parts
      //   data: {"type":"token","text":"..."}\n\n       — response tokens
      //   data: [DONE]\n\n                              — end of stream
      const stream = new ReadableStream<Uint8Array>({
        async start(controller: ReadableStreamDefaultController<Uint8Array>) {
          const reader = geminiResponse.body?.getReader()
          if (!reader) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
            return
          }

          const decoder = new TextDecoder()
          let buffer = ""

          const enqueue = (event: { type: "thinking" | "token"; text: string }) => {
            if (!event.text) return
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
            )
          }

          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break

              buffer += decoder.decode(value, { stream: true })

              // Process complete SSE lines from the buffer
              const lines = buffer.split("\n")
              buffer = lines.pop() ?? ""

              for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const rawData = line.slice(6).trim()
                if (!rawData || rawData === "[DONE]") continue

                try {
                  const parsed = JSON.parse(rawData) as {
                    candidates?: Array<{
                      content?: {
                        parts?: Array<{
                          text?: string
                          thought?: boolean
                        }>
                      }
                    }>
                  }

                  const parts = parsed.candidates?.[0]?.content?.parts ?? []
                  for (const part of parts) {
                    if (!part.text) continue
                    if (part.thought) {
                      // Thinking/reasoning content
                      enqueue({ type: "thinking", text: part.text })
                    } else {
                      // Regular response token
                      enqueue({ type: "token", text: part.text })
                    }
                  }
                } catch {
                  // Skip malformed SSE lines
                }
              }
            }

            // Flush any remaining buffer content
            if (buffer.trim()) {
              const line = buffer.trim()
              if (line.startsWith("data: ")) {
                const rawData = line.slice(6).trim()
                if (rawData && rawData !== "[DONE]") {
                  try {
                    const parsed = JSON.parse(rawData) as {
                      candidates?: Array<{
                        content?: { parts?: Array<{ text?: string; thought?: boolean }> }
                      }>
                    }
                    const parts = parsed.candidates?.[0]?.content?.parts ?? []
                    for (const part of parts) {
                      if (!part.text) continue
                      enqueue({ type: part.thought ? "thinking" : "token", text: part.text })
                    }
                  } catch { /* ignore */ }
                }
              }
            }
          } finally {
            reader.releaseLock()
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      })
    } catch (error) {
      console.error("[ai-routes] chat error:", error)
      set.status = 502
      return { error: error instanceof Error ? error.message : "AI chat request failed" }
    }
  }, {
    body: t.Object({
      message: t.String(),
      serviceCategory: t.Optional(t.String()),
      step: t.Optional(t.String()),
      history: t.Optional(t.Array(t.Object({
        role: t.String(),
        content: t.String(),
      }))),
    }),
  })
