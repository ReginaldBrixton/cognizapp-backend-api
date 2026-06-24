import { getDb } from "../../lib/db";
import { toJsonValue } from "../../lib/repository-helpers";
import type { ProjectSlide, CreateSlideInput, UpdateSlideInput, SlideFilter } from "./types";

const SLIDE_SORT_COLUMNS: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  title: "title",
};

function buildSlideFilter(filter?: SlideFilter) {
  const clauses = ["project_id = $1", "deleted_at IS NULL"];
  const params: Array<string | boolean> = [];

  if (filter?.status) {
    params.push(filter.status);
    clauses.push(`status = $${params.length + 1}`);
  }
  if (filter?.isTemplate !== undefined) {
    params.push(filter.isTemplate);
    clauses.push(`is_template = $${params.length + 1}`);
  }
  if (filter?.search) {
    params.push(`%${filter.search}%`);
    clauses.push(`title ILIKE $${params.length + 1}`);
  }

  return { clauses, params };
}

export const slideRepository = {
  async findByProjectId(projectId: string, filter?: SlideFilter): Promise<ProjectSlide[]> {
    const db = getDb();
    const { clauses, params } = buildSlideFilter(filter);
    const sortBy = SLIDE_SORT_COLUMNS[filter?.sortBy || "created_at"] ?? "created_at";
    const sortOrder = filter?.sortOrder === "asc" ? "ASC" : "DESC";

    let query = `
      SELECT * FROM project_slides
      WHERE ${clauses.join(" AND ")}
      ORDER BY "${sortBy}" ${sortOrder}
    `;

    const queryParams: Array<string | number | boolean> = [projectId, ...params];

    if (filter?.limit) {
      const offset = ((filter.page || 1) - 1) * filter.limit;
      queryParams.push(filter.limit);
      query += ` LIMIT $${queryParams.length}`;
      queryParams.push(offset);
      query += ` OFFSET $${queryParams.length}`;
    }

    const rows = await db.unsafe(query, queryParams);
    return rows.map(this.mapRowToSlide);
  },

  async countByProjectId(projectId: string, filter?: SlideFilter): Promise<number> {
    const db = getDb();
    const { clauses, params } = buildSlideFilter(filter);
    const query = `
      SELECT COUNT(*)::int AS count FROM project_slides
      WHERE ${clauses.join(" AND ")}
    `;

    const [result] = await db.unsafe(query, [projectId, ...params]);
    return result?.count ?? 0;
  },

  async findById(id: string): Promise<ProjectSlide | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM project_slides
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToSlide(rows[0]) : null;
  },

  async create(projectId: string, ownerUid: string, data: CreateSlideInput): Promise<ProjectSlide> {
    const db = getDb();
    const slideData = data.slideData || [];
    const collaborators: string[] = [];

    const rows = await db`
      INSERT INTO project_slides (
        project_id, owner_uid, title, slide_data, slide_count, version, collaborators, is_template, metadata
      ) VALUES (
        ${projectId}, ${ownerUid}, ${data.title || 'Untitled'}, ${db.json(toJsonValue(slideData))},
        ${slideData.length}, 1, ${collaborators}, ${data.isTemplate || false}, ${db.json(toJsonValue(data.metadata || {}))}
      )
      RETURNING *
    `;
    return this.mapRowToSlide(rows[0]);
  },

  async update(id: string, data: UpdateSlideInput): Promise<ProjectSlide> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Slide not found");
    }

    const setClauses: ReturnType<typeof db>[] = [];
    const updates: Record<string, unknown> = {};

    if (data.title !== undefined) updates.title = data.title;
    if (data.slideData !== undefined) {
      updates.slide_data = db.json(toJsonValue(data.slideData));
      updates.slide_count = Array.isArray(data.slideData) ? data.slideData.length : 0;
    }
    if (data.status !== undefined) updates.status = data.status;
    if (data.isPublic !== undefined) updates.is_public = data.isPublic;
    if (data.isTemplate !== undefined) updates.is_template = data.isTemplate;
    if (data.metadata !== undefined) updates.metadata = db.json(toJsonValue(data.metadata));

    if (Object.keys(updates).length === 0) {
      return current;
    }

    for (const [key, value] of Object.entries(updates)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      setClauses.push(db`${db(col)} = ${value as any}`);
    }

    setClauses.push(db`version = version + 1`);

    const fragments = setClauses.flatMap((f, i) => (i === 0 ? [f] : [db`, `, f]));

    const rows = await db`
      UPDATE project_slides
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToSlide(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE project_slides
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  mapRowToSlide(row: Record<string, unknown>): ProjectSlide {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ownerUid: String(row.owner_uid),
      title: String(row.title),
      slideData: Array.isArray(row.slide_data) ? row.slide_data : [],
      slideCount: Number(row.slide_count ?? 0),
      version: Number(row.version ?? 1),
      collaborators: Array.isArray(row.collaborators) ? (row.collaborators as string[]) : [],
      isPublic: Boolean(row.is_public),
      status: row.status as ProjectSlide["status"],
      isTemplate: Boolean(row.is_template),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
