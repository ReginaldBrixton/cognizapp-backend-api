export type ProjectDocument = {
  id: string;
  projectId: string;
  ownerUid: string;
  title: string;
  docType: "document" | "spreadsheet" | "presentation" | "note" | "bibliography";
  content: string;
  contentJson: Record<string, unknown>;
  wordCount: number;
  charCount: number;
  pageCount: number;
  version: number;
  plagiarismScore: number | null;
  aiContentScore: number | null;
  readabilityScore: number | null;
  collaborators: string[];
  isPublic: boolean;
  status: "active" | "archived" | "trashed";
  isTemplate: boolean;
  parentId: string | null;
  abstract: string | null;
  keywords: string[];
  citationStyle: string;
  language: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type DocumentVersion = {
  id: string;
  documentId: string;
  version: number;
  content: string;
  contentJson: Record<string, unknown>;
  wordCount: number;
  createdAt: string;
  createdBy: string;
};

export type CreateDocumentInput = {
  title?: string;
  docType?: ProjectDocument["docType"];
  content?: string;
  contentJson?: Record<string, unknown>;
  isTemplate?: boolean;
  parentId?: string;
  abstract?: string;
  keywords?: string[];
  metadata?: Record<string, unknown>;
};

export type UpdateDocumentInput = Partial<CreateDocumentInput> & {
  status?: ProjectDocument["status"];
  isPublic?: boolean;
};

export type DocumentFilter = {
  search?: string;
  docType?: ProjectDocument["docType"];
  status?: ProjectDocument["status"];
  isTemplate?: boolean;
  sortBy?: "created_at" | "updated_at" | "title";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};