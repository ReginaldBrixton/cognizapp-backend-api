type CostEstimateInput = {
  academicLevel?: string;
  serviceCategory?: string;
  serviceTags?: string[];
  chapters?: string[];
  selectedChapters?: string[];
  budget?: number;
  budgetMin?: number;
  budgetMax?: number;
  dataCollection?: string;
  dataCollectionOwner?: string;
  analysisOwner?: string;
  powerpoint?: boolean;
  includeSlides?: boolean;
  assistance?: boolean;
  assistance24x7?: boolean;
  description?: string;
  pages?: number;
  wordCount?: number;
  deadlineAt?: string;
  correctionCommentCount?: number;
};

type LineItem = {
  item: string;
  cost: number;
};

export type CostEstimateResult = {
  accepted: boolean;
  counterOffer: number | null;
  reasoning: string;
  suggestions: string[];
  breakdown: LineItem[];
  range: {
    min: number;
    max: number;
  };
  deposit: {
    minPercent: number;
    defaultPercent: number;
  };
  provider: "local" | "cognizapp" | "cache";
};

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
  "assignment": 10,
};

const SERVICE_LABELS: Record<string, string> = {
  "research-diagnostic": "Research Diagnostic",
  "proposal-review": "Proposal Review",
  "chapter-editing": "Chapter Editing",
  "literature-methodology": "Literature and Methodology Help",
  "citation-integrity": "Citation and Integrity Check",
  "supervisor-comments": "Supervisor Comments Fix",
  "data-analysis": "Data Analysis Support",
  "questionnaire-survey": "Questionnaire and Survey Design",
  "thesis-formatting": "Thesis Formatting",
  "powerpoint-preparation": "PowerPoint Preparation",
  "excel-dashboard": "Excel Sheets and Dashboards",
  "full-project-support": "Full Project Support",
  "free-diagnostic": "Research Diagnostic",
  "assignment": "One assignment",
};

const LAUNCH_DISCOUNT_RATE = 0.5;

// ── Scope multipliers ────────────────────────────────────────────────────────

const URGENCY_MULTIPLIERS = [
  { maxDays: 3, multiplier: 1.5, label: "Urgent (< 3 days)" },
  { maxDays: 7, multiplier: 1.25, label: "Express (3\u20137 days)" },
  { maxDays: 14, multiplier: 1.1, label: "Standard (7\u201314 days)" },
  { maxDays: Infinity, multiplier: 1, label: "" },
];

const ACADEMIC_LEVEL_MULTIPLIERS: Record<string, { multiplier: number; label: string }> = {
  undergraduate: { multiplier: 1, label: "" },
  bachelor: { multiplier: 1, label: "" },
  master: { multiplier: 1.2, label: "Master\u2019s level (+20%)" },
  masters: { multiplier: 1.2, label: "Master\u2019s level (+20%)" },
  graduate: { multiplier: 1.2, label: "Graduate level (+20%)" },
  phd: { multiplier: 1.4, label: "PhD level (+40%)" },
  doctorate: { multiplier: 1.4, label: "Doctoral level (+40%)" },
  doctoral: { multiplier: 1.4, label: "Doctoral level (+40%)" },
};

const BASE_PAGES = 10;
const BASE_WORDS = 2750;
const PAGE_INCREMENT = 5;
const PAGE_INCREMENT_MULTIPLIER = 0.1;

interface ScopeMultiplier {
  multiplier: number;
  label: string;
}

function urgencyMultiplier(deadlineAt?: string): ScopeMultiplier {
  if (!deadlineAt) return { multiplier: 1, label: "" };
  const deadline = new Date(deadlineAt);
  if (Number.isNaN(deadline.getTime())) return { multiplier: 1, label: "" };
  const days = (deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  const tier = URGENCY_MULTIPLIERS.find((t) => days <= t.maxDays);
  return { multiplier: tier?.multiplier ?? 1, label: tier?.label ?? "" };
}

function academicLevelMultiplier(level?: string): ScopeMultiplier {
  const key = (level || "").toLowerCase().trim();
  const entry = ACADEMIC_LEVEL_MULTIPLIERS[key];
  return entry ?? { multiplier: 1, label: "" };
}

function pageCountMultiplier(pages?: number, wordCount?: number): ScopeMultiplier {
  const effectivePages = pages ?? (wordCount ? Math.ceil(wordCount / BASE_WORDS) : 0);
  if (!effectivePages || effectivePages <= BASE_PAGES) return { multiplier: 1, label: "" };
  const increments = Math.floor((effectivePages - BASE_PAGES) / PAGE_INCREMENT);
  const multiplier = 1 + increments * PAGE_INCREMENT_MULTIPLIER;
  return { multiplier, label: `Extended scope (+${increments * 10}%)` };
}

function round(value: number) {
  return Math.round(Number(value) || 0);
}

function selectedServiceTag(input: CostEstimateInput) {
  const firstTag = Array.isArray(input.serviceTags) ? input.serviceTags[0] : undefined;
  return String(input.serviceCategory ?? firstTag ?? "");
}

export function estimateSupportCostLocal(input: CostEstimateInput): CostEstimateResult {
  const serviceTag = selectedServiceTag(input);
  const basePrice = serviceTag === "assignment" ? 10 : SERVICE_STARTING_PRICES[serviceTag] ?? 0;

  // Apply scope multipliers
  const urgency = urgencyMultiplier(input.deadlineAt);
  const acad = academicLevelMultiplier(input.academicLevel);
  const pages = pageCountMultiplier(input.pages, input.wordCount);

  const surcharges: LineItem[] = [];

  if (urgency.multiplier > 1) {
    const amount = round(basePrice * (urgency.multiplier - 1));
    if (amount > 0) surcharges.push({ item: urgency.label, cost: amount });
  }
  if (acad.multiplier > 1) {
    const amount = round(basePrice * urgency.multiplier * (acad.multiplier - 1));
    if (amount > 0) surcharges.push({ item: acad.label, cost: amount });
  }
  if (pages.multiplier > 1) {
    const amount = round(basePrice * urgency.multiplier * acad.multiplier * (pages.multiplier - 1));
    if (amount > 0) surcharges.push({ item: pages.label, cost: amount });
  }

  const preDiscount = basePrice * urgency.multiplier * acad.multiplier * pages.multiplier;
  const discount = Math.max(0, round(preDiscount * LAUNCH_DISCOUNT_RATE));
  const finalPrice = round(Math.max(0, preDiscount - discount));

  const budget = Number(input.budget ?? input.budgetMin ?? 0);
  const accepted = budget <= 0 || budget >= finalPrice;
  const breakdown: LineItem[] = [
    { item: SERVICE_LABELS[serviceTag] ?? "Selected service", cost: round(basePrice) },
    ...surcharges,
  ];

  if (discount > 0) {
    breakdown.push({ item: "Launch discount (50%)", cost: -discount });
  }

  return {
    accepted,
    counterOffer: accepted ? null : finalPrice,
    reasoning: accepted
      ? "The selected service uses the fixed advertised checkout price."
      : "The proposed budget is below the selected service checkout price.",
    suggestions: accepted
      ? ["The checkout price is locked to the selected service."]
      : ["Use the listed service price to continue checkout."],
    breakdown,
    range: { min: finalPrice, max: finalPrice },
    deposit: { minPercent: 100, defaultPercent: 100 },
    provider: "local",
  };
}

export async function estimateSupportCost(input: CostEstimateInput): Promise<CostEstimateResult> {
  return estimateSupportCostLocal(input);
}
