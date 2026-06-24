import { getDb } from "../../lib/db";
import { toJsonValue } from "../../lib/repository-helpers";
import type { ProjectDocument, DocumentVersion, CreateDocumentInput, UpdateDocumentInput, DocumentFilter } from "./types";

const DOCUMENT_SORT_COLUMNS: Record<string, string> = {
  created_at: "created_at",
  updated_at: "updated_at",
  title: "title",
};

function buildDocumentFilter(filter?: DocumentFilter) {
  const clauses = ["project_id = $1", "deleted_at IS NULL"];
  const params: Array<string | boolean> = [];

  if (filter?.docType) {
    params.push(filter.docType);
    clauses.push(`doc_type = $${params.length + 1}`);
  }
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

export const documentRepository = {
  async findByProjectId(projectId: string, filter?: DocumentFilter): Promise<ProjectDocument[]> {
    const db = getDb();
    const { clauses, params } = buildDocumentFilter(filter);
    const sortBy = DOCUMENT_SORT_COLUMNS[filter?.sortBy || "created_at"] ?? "created_at";
    const sortOrder = filter?.sortOrder === "asc" ? "ASC" : "DESC";

    let query = `
      SELECT * FROM project_documents
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
    return rows.map(this.mapRowToDocument);
  },

  async countByProjectId(projectId: string, filter?: DocumentFilter): Promise<number> {
    const db = getDb();
    const { clauses, params } = buildDocumentFilter(filter);
    const query = `
      SELECT COUNT(*)::int AS count FROM project_documents
      WHERE ${clauses.join(" AND ")}
    `;

    const [result] = await db.unsafe(query, [projectId, ...params]);
    return result?.count ?? 0;
  },

  async findById(id: string): Promise<ProjectDocument | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM project_documents
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToDocument(rows[0]) : null;
  },

  async create(projectId: string, ownerUid: string, data: CreateDocumentInput): Promise<ProjectDocument> {
    const db = getDb();
    const keywords = data.keywords || [];
    const collaborators: string[] = [];

    const rows = await db`
      INSERT INTO project_documents (
        project_id, owner_uid, title, doc_type, content, content_json,
        word_count, char_count, is_template, parent_id, abstract, keywords, metadata
      ) VALUES (
        ${projectId}, ${ownerUid}, ${data.title || 'Untitled'}, ${data.docType || 'document'},
        ${data.content || ''}, ${db.json(toJsonValue(data.contentJson || {}))},
        ${data.content ? data.content.split(/\s+/).length : 0}, ${data.content?.length || 0},
        ${data.isTemplate || false}, ${data.parentId || null}, ${data.abstract || null},
        ${keywords}, ${db.json(toJsonValue(data.metadata || {}))}
      )
      RETURNING *
    `;
    return this.mapRowToDocument(rows[0]);
  },

  async update(id: string, data: UpdateDocumentInput): Promise<ProjectDocument> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Document not found");
    }

    const setClauses: ReturnType<typeof db>[] = [];
    const updates: Record<string, unknown> = {};

    if (data.title !== undefined) updates.title = data.title;
    if (data.docType !== undefined) updates.doc_type = data.docType;
    if (data.content !== undefined) {
      updates.content = data.content;
      updates.word_count = data.content.split(/\s+/).length;
      updates.char_count = data.content.length;
    }
    if (data.contentJson !== undefined) updates.content_json = toJsonValue(data.contentJson);
    if (data.status !== undefined) updates.status = data.status;
    if (data.isPublic !== undefined) updates.is_public = data.isPublic;
    if (data.isTemplate !== undefined) updates.is_template = data.isTemplate;
    if (data.abstract !== undefined) updates.abstract = data.abstract;
    if (data.keywords !== undefined) updates.keywords = data.keywords;
    if (data.metadata !== undefined) updates.metadata = toJsonValue(data.metadata);

    if (Object.keys(updates).length === 0) {
      return current;
    }

    for (const [key, value] of Object.entries(updates)) {
      const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
      if (key === "content_json" || key === "metadata") {
        setClauses.push(db`${db(col)} = ${db.json(value as any)}`);
      } else if (key === "keywords") {
        setClauses.push(db`${db(col)} = ${value as any}`);
      } else {
        setClauses.push(db`${db(col)} = ${value as any}`);
      }
    }

    setClauses.push(db`version = version + 1`);

    const fragments = setClauses.flatMap((f, i) => (i === 0 ? [f] : [db`, `, f]));

    const rows = await db`
      UPDATE project_documents
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToDocument(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE project_documents
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  async createVersion(documentId: string, content: string, contentJson: Record<string, unknown>, createdBy: string): Promise<DocumentVersion> {
    const db = getDb();
    const rows = await db`
      INSERT INTO document_versions (document_id, version, content, content_json, word_count, created_by)
      SELECT id, version, content, content_json, word_count, ${createdBy}
      FROM project_documents
      WHERE id = ${documentId}
      RETURNING id, document_id, version, content, content_json, word_count, created_at AS created_at, created_by
    `;
    
    if (rows.length === 0) {
      throw new Error("Document not found");
    }

    const row = rows[0];
    return {
      id: String(row.id),
      documentId: String(row.document_id),
      version: Number(row.version),
      content: String(row.content),
      contentJson: row.content_json as Record<string, unknown>,
      wordCount: Number(row.word_count),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    };
  },

  async getVersions(documentId: string): Promise<DocumentVersion[]> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM document_versions
      WHERE document_id = ${documentId}
      ORDER BY version DESC
    `;
    return rows.map(row => ({
      id: String(row.id),
      documentId: String(row.document_id),
      version: Number(row.version),
      content: String(row.content),
      contentJson: row.content_json as Record<string, unknown>,
      wordCount: Number(row.word_count),
      createdAt: String(row.created_at),
      createdBy: String(row.created_by),
    }));
  },

  async restoreVersion(documentId: string, version: number): Promise<ProjectDocument> {
    const db = getDb();
    const versionRow = await db`
      SELECT content, content_json FROM document_versions
      WHERE document_id = ${documentId} AND version = ${version}
    `;

    if (versionRow.length === 0) {
      throw new Error("Version not found");
    }

    const content = String(versionRow[0].content);
    const contentJson = versionRow[0].content_json as Record<string, unknown>;

    return await this.update(documentId, { content, contentJson });
  },

  mapRowToDocument(row: Record<string, unknown>): ProjectDocument {
    return {
      id: String(row.id),
      projectId: String(row.project_id),
      ownerUid: String(row.owner_uid),
      title: String(row.title),
      docType: row.doc_type as ProjectDocument["docType"],
      content: String(row.content ?? ""),
      contentJson: (row.content_json as Record<string, unknown>) ?? {},
      wordCount: Number(row.word_count ?? 0),
      charCount: Number(row.char_count ?? 0),
      pageCount: Number(row.page_count ?? 1),
      version: Number(row.version ?? 1),
      plagiarismScore: row.plagiarism_score ? Number(row.plagiarism_score) : null,
      aiContentScore: row.ai_content_score ? Number(row.ai_content_score) : null,
      readabilityScore: row.readability_score ? Number(row.readability_score) : null,
      collaborators: Array.isArray(row.collaborators) ? (row.collaborators as string[]) : [],
      isPublic: Boolean(row.is_public),
      status: row.status as ProjectDocument["status"],
      isTemplate: Boolean(row.is_template),
      parentId: row.parent_id ? String(row.parent_id) : null,
      abstract: row.abstract ? String(row.abstract) : null,
      keywords: Array.isArray(row.keywords) ? (row.keywords as string[]) : [],
      citationStyle: String(row.citation_style ?? "apa"),
      language: String(row.language ?? "en"),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
