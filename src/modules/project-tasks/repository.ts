import { getDb } from "../../lib/db";
import { toJsonValue } from "../../lib/repository-helpers";
import type { ProjectTask, CreateTaskInput, UpdateTaskInput, TaskFilter } from "./types";

const TASK_SORT_COLUMNS: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  due_date: "due_date",
  display_order: "display_order",
};

function buildTaskFilter(filter?: TaskFilter) {
  const clauses = ["project_id = $1", "deleted_at IS NULL"];
  const params: string[] = [];

  if (filter?.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length + 1}`);
  }
  if (filter?.priority) {
    params.push(filter.priority);
    clauses.push(`priority = $${params.length + 1}`);
  }
  if (filter?.assigneeUid) {
    params.push(filter.assigneeUid);
    clauses.push(`assignee_uid = $${params.length + 1}`);
  }
  if (filter?.taskType) {
    params.push(filter.taskType);
    clauses.push(`task_type = $${params.length + 1}`);
  }
  if (filter?.search) {
    params.push(`%${filter.search}%`);
    clauses.push(`title ILIKE $${params.length + 1}`);
  }

  return { clauses, params };
}

export const taskRepository = {
  async findByProjectId(projectId: string, filter?: TaskFilter): Promise<ProjectTask[]> {
    const db = getDb();
    const { clauses, params } = buildTaskFilter(filter);
    const sortBy = TASK_SORT_COLUMNS[filter?.sortBy || "display_order"] ?? "display_order";
    const sortOrder = filter?.sortOrder === "desc" ? "DESC" : "ASC";

    let query = `
      SELECT * FROM project_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY "${sortBy}" ${sortOrder}
    `;

    const queryParams: Array<string | number> = [projectId, ...params];

    if (filter?.limit) {
      const offset = ((filter.page || 1) - 1) * filter.limit;
      queryParams.push(filter.limit);
      query += ` LIMIT $${queryParams.length}`;
      queryParams.push(offset);
      query += ` OFFSET $${queryParams.length}`;
    }

    const rows = await db.unsafe(query, queryParams);
    return rows.map(this.mapRowToTask);
  },

  async countByProjectId(projectId: string, filter?: TaskFilter): Promise<number> {
    const db = getDb();
    const { clauses, params } = buildTaskFilter(filter);
    const query = `
      SELECT COUNT(*)::int AS count FROM project_tasks
      WHERE ${clauses.join(" AND ")}
    `;

    const [result] = await db.unsafe(query, [projectId, ...params]);
    return result?.count ?? 0;
  },

  async findById(id: string): Promise<ProjectTask | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM project_tasks
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToTask(rows[0]) : null;
  },

  async create(projectId: string, ownerUid: string, createdByUid: string, data: CreateTaskInput): Promise<ProjectTask> {
    const db = getDb();
    const tags = data.tags || [];
    const attachments = data.attachments || [];
    const subtasks = data.subtasks || [];

    const rows = await db`
      INSERT INTO project_tasks (
        project_id, owner_uid, created_by_uid, title, description, status, priority, task_type,
        due_date, estimated_hours, tags, attachments, subtasks, document_id, slide_id, note_id, metadata
      ) VALUES (
        ${projectId}, ${ownerUid}, ${createdByUid}, ${data.title || 'Untitled'}, ${data.description || ''},
        ${data.status || 'todo'}, ${data.priority || 'medium'}, ${data.taskType || 'task'},
        ${data.dueDate || null}, ${data.estimatedHours || null}, ${tags}, ${db.json(toJsonValue(attachments))},
        ${db.json(toJsonValue(subtasks))}, ${data.documentId || null}, ${data.slideId || null}, ${data.noteId || null},
        ${db.json(toJsonValue(data.metadata || {}))}
      )
      RETURNING *
    `;
    return this.mapRowToTask(rows[0]);
  },

  async update(id: string, data: UpdateTaskInput): Promise<ProjectTask> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Task not found");
    }

    const setClauses: ReturnType<typeof db>[] = [];
    const updates: Record<string, unknown> = {};

    if (data.title !== undefined) updates.title = data.title;
    if (data.description !== undefined) updates.description = data.description;
    if (data.status !== undefined) updates.status = data.status;
    if (data.priority !== undefined) updates.priority = data.priority;
    if (data.taskType !== undefined) updates.task_type = data.taskType;
    if (data.dueDate !== undefined) updates.due_date = data.dueDate;
    if (data.estimatedHours !== undefined) updates.estimated_hours = data.estimatedHours;
    if (data.actualHours !== undefined) updates.actual_hours = data.actualHours;
    if (data.assigneeUid !== undefined) updates.assignee_uid = data.assigneeUid;
    if (data.displayOrder !== undefined) updates.display_order = data.displayOrder;
    if (data.startedAt !== undefined) updates.started_at = data.startedAt;
    if (data.completedAt !== undefined) updates.completed_at = data.completedAt;
    if (data.tags !== undefined) updates.tags = data.tags;
    if (data.attachments !== undefined) updates.attachments = db.json(toJsonValue(data.attachments));
    if (data.subtasks !== undefined) updates.subtasks = db.json(toJsonValue(data.subtasks));
    if (data.documentId !== undefined) updates.document_id = data.documentId;
    if (data.slideId !== undefined) updates.slide_id = data.slideId;
    if (data.noteId !== undefined) updates.note_id = data.noteId;
    if (data.metadata !== undefined) updates.metadata = db.json(toJsonValue(data.metadata));

    if (Object.keys(updates).length === 0) {
      return current;
    }

    for (const [key, value] of Object.entries(updates)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      setClauses.push(db`${db(col)} = ${value as any}`);
    }

    const fragments = setClauses.flatMap((f, i) => (i === 0 ? [f] : [db`, `, f]));

    const rows = await db`
      UPDATE project_tasks
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToTask(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE project_tasks
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  mapRowToTask(row: Record<string, unknown>): ProjectTask {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      documentId: row.document_id ? String(row.document_id) : null,
      slideId: row.slide_id ? String(row.slide_id) : null,
      noteId: row.note_id ? String(row.note_id) : null,
      ownerUid: String(row.owner_uid),
      assigneeUid: row.assignee_uid ? String(row.assignee_uid) : null,
      createdByUid: String(row.created_by_uid),
      title: String(row.title),
      description: String(row.description ?? ""),
      status: row.status as ProjectTask["status"],
      priority: row.priority as ProjectTask["priority"],
      taskType: String(row.task_type ?? "task"),
      dueDate: row.due_date ? String(row.due_date) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      completedAt: row.completed_at ? String(row.completed_at) : null,
      estimatedHours: row.estimated_hours ? Number(row.estimated_hours) : null,
      actualHours: row.actual_hours ? Number(row.actual_hours) : null,
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      attachments: Array.isArray(row.attachments) ? row.attachments : [],
      subtasks: Array.isArray(row.subtasks) ? row.subtasks : [],
      commentsCount: Number(row.comments_count ?? 0),
      displayOrder: Number(row.display_order ?? 0),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
