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

function round(value: number) {
  return Math.round(Number(value) || 0);
}

function selectedServiceTag(input: CostEstimateInput) {
  const firstTag = Array.isArray(input.serviceTags) ? input.serviceTags[0] : undefined;
  return String(input.serviceCategory ?? firstTag ?? "");
}

function fixedServicePrice(serviceTag: string) {
  if (serviceTag === "assignment") return 10;
  const basePrice = SERVICE_STARTING_PRICES[serviceTag] ?? 0;
  return round(Math.max(0, basePrice - basePrice * LAUNCH_DISCOUNT_RATE));
}

export function estimateSupportCostLocal(input: CostEstimateInput): CostEstimateResult {
  const serviceTag = selectedServiceTag(input);
  const basePrice = serviceTag === "assignment" ? 10 : SERVICE_STARTING_PRICES[serviceTag] ?? 0;
  const price = fixedServicePrice(serviceTag);
  const discount = Math.max(0, basePrice - price);
  const budget = Number(input.budget ?? input.budgetMin ?? 0);
  const accepted = budget <= 0 || budget >= price;
  const breakdown: LineItem[] = [
    { item: SERVICE_LABELS[serviceTag] ?? "Selected service", cost: basePrice },
  ];

  if (discount > 0) {
    breakdown.push({ item: "Launch discount (50%)", cost: -discount });
  }

  return {
    accepted,
    counterOffer: accepted ? null : price,
    reasoning: accepted
      ? "The selected service uses the fixed advertised checkout price."
      : "The proposed budget is below the selected service checkout price.",
    suggestions: accepted
      ? ["The checkout price is locked to the selected service."]
      : ["Use the listed service price to continue checkout."],
    breakdown,
    range: { min: price, max: price },
    deposit: { minPercent: 100, defaultPercent: 100 },
    provider: "local",
  };
}

export async function estimateSupportCost(input: CostEstimateInput): Promise<CostEstimateResult> {
  return estimateSupportCostLocal(input);
}
