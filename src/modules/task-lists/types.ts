export type TaskList = {
  id: string;
  projectId: string;
  ownerUid: string;
  name: string;
  description: string;
  status: "active" | "archived" | "trashed";
  order: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateTaskListInput = {
  name?: string;
  description?: string;
  status?: TaskList["status"];
};

export type UpdateTaskListInput = Partial<CreateTaskListInput> & {
  order?: number;
};

export type TaskListFilter = {
  search?: string;
  status?: TaskList["status"];
  sortBy?: "created_at" | "updated_at" | "order";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};
