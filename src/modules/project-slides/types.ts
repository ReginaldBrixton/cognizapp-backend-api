export type ProjectSlide = {
  id: string;
  projectId: string;
  ownerUid: string;
  title: string;
  slideData: unknown[];
  slideCount: number;
  version: number;
  collaborators: string[];
  isPublic: boolean;
  status: "active" | "archived" | "trashed";
  isTemplate: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateSlideInput = {
  title?: string;
  slideData?: unknown[];
  isTemplate?: boolean;
  metadata?: Record<string, unknown>;
};

export type UpdateSlideInput = Partial<CreateSlideInput> & {
  status?: ProjectSlide["status"];
  isPublic?: boolean;
};

export type SlideFilter = {
  search?: string;
  status?: ProjectSlide["status"];
  isTemplate?: boolean;
  sortBy?: "created_at" | "updated_at" | "title";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};