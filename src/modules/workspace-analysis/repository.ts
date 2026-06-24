import type { JSONValue } from "postgres";
import { getDb } from "../../lib/db";
import type { WorkspaceAnalysis } from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

export const analysisRepository = {
  async findByWorkspaceId(workspaceId: string): Promise<WorkspaceAnalysis[]> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_analysis
      WHERE workspace_id = ${workspaceId}
      AND deleted_at IS NULL
      ORDER BY created_at DESC
    `;
    return rows.map(this.mapRowToAnalysis);
  },

  async findById(id: string): Promise<WorkspaceAnalysis | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_analysis
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    return rows[0] ? this.mapRowToAnalysis(rows[0]) : null;
  },

  async create(data: Omit<WorkspaceAnalysis, "id" | "createdAt" | "updatedAt">): Promise<WorkspaceAnalysis> {
    const db = getDb();
    const rows = await db`
      INSERT INTO workspace_analysis (
        workspace_id, owner_uid, analysis_type, title, description, status,
        input_data, result_data, confidence_score, source_reference, metadata
      ) VALUES (
        ${data.workspaceId}, ${data.ownerUid}, ${data.analysisType}, ${data.title}, ${data.description}, ${data.status},
        ${db.json(toJsonValue(data.inputData))}, ${db.json(toJsonValue(data.resultData))}, ${data.confidenceScore}, ${data.sourceReference}, ${db.json(toJsonValue(data.metadata))}
      )
      RETURNING *
    `;
    return this.mapRowToAnalysis(rows[0]);
  },

  mapRowToAnalysis(row: Record<string, unknown>): WorkspaceAnalysis {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerUid: String(row.owner_uid),
      analysisType: row.analysis_type as WorkspaceAnalysis["analysisType"],
      title: String(row.title),
      description: String(row.description ?? ""),
      status: row.status as WorkspaceAnalysis["status"],
      inputData: (row.input_data as Record<string, unknown>) ?? {},
      resultData: (row.result_data as Record<string, unknown>) ?? {},
      confidenceScore: row.confidence_score != null ? Number(row.confidence_score) : null,
      sourceReference: row.source_reference ? String(row.source_reference) : null,
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
