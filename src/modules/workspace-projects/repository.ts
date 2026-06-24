import type { JSONValue } from "postgres";
import { getDb } from "../../lib/db";
import type { Project } from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

export const projectRepository = {
  async findByWorkspaceId(workspaceId: string): Promise<Project[]> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_projects
      WHERE workspace_id = ${workspaceId}
      AND deleted_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(this.mapRowToProject);
  },

  async findById(id: string): Promise<Project | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_projects
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToProject(rows[0]) : null;
  },

  async create(data: Omit<Project, "id" | "createdAt" | "updatedAt">): Promise<Project> {
    const db = getDb();
    const keywords = Array.isArray(data.keywords) ? data.keywords : [];
    const collaborators = Array.isArray(data.collaborators) ? data.collaborators : [];
    const rows = await db`
      INSERT INTO workspace_projects (
        workspace_id, owner_uid, title, description, status, visibility,
        field_of_study, project_type, keywords, collaborators, completion_pct,
        deadline, document_count, task_count, completed_tasks, metadata
      ) VALUES (
        ${data.workspaceId}, ${data.ownerUid}, ${data.title}, ${data.description}, ${data.status}, ${data.visibility},
        ${data.fieldOfStudy}, ${data.projectType}, ${keywords}, ${collaborators}, ${data.completionPct},
        ${data.deadline}, ${data.documentCount}, ${data.taskCount}, ${data.completedTasks}, ${db.json(toJsonValue(data.metadata))}
      )
      RETURNING *
    `;
    return this.mapRowToProject(rows[0]);
  },

  async update(id: string, data: Record<string, unknown>): Promise<Project> {
    const db = getDb();
    const setClauses: ReturnType<typeof db>[] = [];
    const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

    for (const [key, value] of Object.entries(data)) {
      const col = camelToSnake(key);
      if (col === "metadata") {
        setClauses.push(db`${db(col)} = ${db.json(value as any)}`);
      } else if (col === "keywords" || col === "collaborators") {
        setClauses.push(db`${db(col)} = ${value as any}`);
      } else {
        setClauses.push(db`${db(col)} = ${value as any}`);
      }
    }

    const fragments = setClauses.flatMap((f, i) => (i === 0 ? [f] : [db`, `, f]));

    const rows = await db`
      UPDATE workspace_projects
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      AND deleted_at IS NULL
      RETURNING *
    `;
    if (!rows[0]) {
      throw new Error("Project not found");
    }
    return this.mapRowToProject(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE workspace_projects
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  mapRowToProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerUid: String(row.owner_uid),
      title: String(row.title),
      description: String(row.description ?? ""),
      status: row.status as Project["status"],
      visibility: row.visibility as Project["visibility"],
      fieldOfStudy: row.field_of_study ? String(row.field_of_study) : null,
      projectType: row.project_type ? String(row.project_type) : null,
      keywords: Array.isArray(row.keywords) ? (row.keywords as string[]) : [],
      collaborators: Array.isArray(row.collaborators) ? (row.collaborators as string[]) : [],
      completionPct: Number(row.completion_pct ?? 0),
      deadline: row.deadline ? String(row.deadline) : null,
      documentCount: Number(row.document_count ?? 0),
      taskCount: Number(row.task_count ?? 0),
      completedTasks: Number(row.completed_tasks ?? 0),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
