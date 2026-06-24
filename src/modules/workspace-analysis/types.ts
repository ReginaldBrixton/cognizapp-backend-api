export type WorkspaceAnalysis = {
  id: string;
  workspaceId: string;
  ownerUid: string;
  analysisType: 'humanise' | 'textcompare' | 'textidentify' | 'factcheck';
  title: string;
  description: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  inputData: Record<string, unknown>;
  resultData: Record<string, unknown>;
  confidenceScore: number | null;
  sourceReference: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type AnalysisHumanise = {
  id: string;
  analysisId: string;
  originalText: string;
  humanisedText: string;
  humanisationScore: number;
  changeLog: Record<string, unknown>;
  suggestions: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AnalysisTextCompare = {
  id: string;
  analysisId: string;
  textA: string;
  textB: string;
  similarityScore: number;
  differences: Record<string, unknown>;
  commonPhrases: string[];
  uniqueToA: string[];
  uniqueToB: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AnalysisTextIdentify = {
  id: string;
  analysisId: string;
  inputText: string;
  detectedLanguage: string;
  detectedTone: string;
  detectedEntities: string[];
  classificationResults: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AnalysisFactCheck = {
  id: string;
  analysisId: string;
  claimText: string;
  verificationStatus: 'verified' | 'partially_verified' | 'unverified' | 'false';
  credibilityScore: number;
  evidenceSources: Record<string, unknown>;
  supportingSources: string[];
  refutingSources: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};
