import { getDb } from "../../lib/db";
import { toJsonValue } from "../../lib/repository-helpers";
import type { ProjectNote, CreateNoteInput, UpdateNoteInput, NoteFilter } from "./types";

const NOTE_SORT_COLUMNS: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  title: "title",
};

function buildNoteFilter(filter?: NoteFilter) {
  const clauses = ["project_id = $1", "deleted_at IS NULL"];
  const params: string[] = [];

  if (filter?.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length + 1}`);
  }
  if (filter?.search) {
    params.push(`%${filter.search}%`);
    clauses.push(`title ILIKE $${params.length + 1}`);
  }

  return { clauses, params };
}

export const noteRepository = {
  async findByProjectId(projectId: string, filter?: NoteFilter): Promise<ProjectNote[]> {
    const db = getDb();
    const { clauses, params } = buildNoteFilter(filter);
    const sortBy = NOTE_SORT_COLUMNS[filter?.sortBy || "created_at"] ?? "created_at";
    const sortOrder = filter?.sortOrder === "asc" ? "ASC" : "DESC";

    let query = `
      SELECT * FROM project_notes
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
    return rows.map(this.mapRowToNote);
  },

  async countByProjectId(projectId: string, filter?: NoteFilter): Promise<number> {
    const db = getDb();
    const { clauses, params } = buildNoteFilter(filter);
    const query = `
      SELECT COUNT(*)::int AS count FROM project_notes
      WHERE ${clauses.join(" AND ")}
    `;

    const [result] = await db.unsafe(query, [projectId, ...params]);
    return result?.count ?? 0;
  },

  async findById(id: string): Promise<ProjectNote | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM project_notes
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToNote(rows[0]) : null;
  },

  async create(projectId: string, ownerUid: string, data: CreateNoteInput): Promise<ProjectNote> {
    const db = getDb();
    const collaborators: string[] = [];

    const rows = await db`
      INSERT INTO project_notes (
        project_id, owner_uid, title, content, content_json, collaborators, metadata
      ) VALUES (
        ${projectId}, ${ownerUid}, ${data.title || 'Untitled'}, ${data.content || ''},
        ${db.json(toJsonValue(data.contentJson || {}))}, ${collaborators}, ${db.json(toJsonValue(data.metadata || {}))}
      )
      RETURNING *
    `;
    return this.mapRowToNote(rows[0]);
  },

  async update(id: string, data: UpdateNoteInput): Promise<ProjectNote> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Note not found");
    }

    const setClauses: ReturnType<typeof db>[] = [];
    const updates: Record<string, unknown> = {};

    if (data.title !== undefined) updates.title = data.title;
    if (data.content !== undefined) updates.content = data.content;
    if (data.contentJson !== undefined) updates.content_json = db.json(toJsonValue(data.contentJson));
    if (data.status !== undefined) updates.status = data.status;
    if (data.isPublic !== undefined) updates.is_public = data.isPublic;
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
      UPDATE project_notes
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToNote(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE project_notes
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  mapRowToNote(row: Record<string, unknown>): ProjectNote {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ownerUid: String(row.owner_uid),
      title: String(row.title),
      content: String(row.content ?? ""),
      contentJson: (row.content_json as Record<string, unknown>) ?? {},
      collaborators: Array.isArray(row.collaborators) ? (row.collaborators as string[]) : [],
      isPublic: Boolean(row.is_public),
      status: row.status as ProjectNote["status"],
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
