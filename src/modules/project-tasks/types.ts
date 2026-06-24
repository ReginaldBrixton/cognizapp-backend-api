export type ProjectTask = {
  id: string;
  projectId: string;
  documentId: string | null;
  slideId: string | null;
  noteId: string | null;
  ownerUid: string;
  assigneeUid: string | null;
  createdByUid: string;
  title: string;
  description: string;
  status:
    | "todo"
    | "in_progress"
    | "in-progress"
    | "in_review"
    | "review"
    | "blocked"
    | "done"
    | "cancelled";
  priority: "low" | "medium" | "high" | "urgent" | "critical";
  taskType: string;
  dueDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  estimatedHours: number | null;
  actualHours: number | null;
  tags: string[];
  attachments: unknown[];
  subtasks: unknown[];
  commentsCount: number;
  displayOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateTaskInput = {
  title?: string;
  description?: string;
  status?: ProjectTask["status"];
  priority?: ProjectTask["priority"];
  taskType?: string;
  dueDate?: string;
  estimatedHours?: number;
  tags?: string[];
  attachments?: unknown[];
  subtasks?: unknown[];
  documentId?: string;
  slideId?: string;
  noteId?: string;
  metadata?: Record<string, unknown>;
};

export type UpdateTaskInput = Partial<CreateTaskInput> & {
  assigneeUid?: string;
  displayOrder?: number;
  startedAt?: string;
  completedAt?: string;
  actualHours?: number;
};

export type TaskFilter = {
  search?: string;
  status?: ProjectTask["status"];
  priority?: ProjectTask["priority"];
  assigneeUid?: string;
  taskType?: string;
  sortBy?: "created_at" | "updated_at" | "due_date" | "display_order";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};
