import type { JSONValue } from "postgres";
import { getDb } from "../../lib/db";
import type { TaskList, CreateTaskListInput, UpdateTaskListInput, TaskListFilter } from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

const TASK_LIST_SORT_COLUMNS: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  order: "display_order",
};

function buildTaskListFilter(filter?: TaskListFilter) {
  const clauses = ["project_id = $1", "deleted_at IS NULL"];
  const params: string[] = [];

  if (filter?.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length + 1}`);
  }
  if (filter?.search) {
    params.push(`%${filter.search}%`);
    clauses.push(`name ILIKE $${params.length + 1}`);
  }

  return { clauses, params };
}

export const taskListRepository = {
  async findByProjectId(projectId: string, filter?: TaskListFilter): Promise<TaskList[]> {
    const db = getDb();
    const { clauses, params } = buildTaskListFilter(filter);
    const sortBy = TASK_LIST_SORT_COLUMNS[filter?.sortBy || "order"] ?? "display_order";
    const sortOrder = filter?.sortOrder === "desc" ? "DESC" : "ASC";

    let query = `
      SELECT * FROM project_task_lists
      WHERE ${clauses.join(" AND ")}
      ORDER BY "${sortBy}" ${sortOrder}, created_at ASC
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
    return rows.map(this.mapRowToTaskList);
  },

  async countByProjectId(projectId: string, filter?: TaskListFilter): Promise<number> {
    const db = getDb();
    const { clauses, params } = buildTaskListFilter(filter);
    const query = `
      SELECT COUNT(*)::int AS count
      FROM project_task_lists
      WHERE ${clauses.join(" AND ")}
    `;

    const [result] = await db.unsafe(query, [projectId, ...params]);
    return Number(result?.count ?? 0);
  },

  async findById(id: string): Promise<TaskList | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM project_task_lists
      WHERE id = ${id}
        AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToTaskList(rows[0]) : null;
  },

  async create(projectId: string, ownerUid: string, data: CreateTaskListInput): Promise<TaskList> {
    const db = getDb();
    const rows = await db`
      INSERT INTO project_task_lists (
        project_id,
        owner_uid,
        name,
        description,
        status,
        display_order,
        metadata
      ) VALUES (
        ${projectId},
        ${ownerUid},
        ${data.name || "Untitled List"},
        ${data.description || ""},
        ${data.status || "active"},
        0,
        ${db.json(toJsonValue({}))}
      )
      RETURNING *
    `;
    return this.mapRowToTaskList(rows[0]);
  },

  async update(id: string, data: UpdateTaskListInput): Promise<TaskList> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Task list not found");
    }

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.status !== undefined) updates.status = data.status;
    if (data.order !== undefined) updates.display_order = data.order;

    if (Object.keys(updates).length === 0) {
      return current;
    }

    const setClauses: ReturnType<typeof db>[] = [];
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(db`${db(key)} = ${value as any}`);
    }
    const fragments = setClauses.flatMap((fragment, index) =>
      index === 0 ? [fragment] : [db`, `, fragment],
    );

    const rows = await db`
      UPDATE project_task_lists
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToTaskList(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE project_task_lists
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
  },

  async reorder(projectId: string, items: { id: string; order: number }[]): Promise<void> {
    const db = getDb();
    for (const item of items) {
      await db`
        UPDATE project_task_lists
        SET display_order = ${item.order}, updated_at = NOW()
        WHERE id = ${item.id}
          AND project_id = ${projectId}
          AND deleted_at IS NULL
      `;
    }
  },

  mapRowToTaskList(row: Record<string, unknown>): TaskList {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ownerUid: String(row.owner_uid),
      name: String(row.name),
      description: String(row.description ?? ""),
      status: row.status as TaskList["status"],
      order: Number(row.display_order ?? 0),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
