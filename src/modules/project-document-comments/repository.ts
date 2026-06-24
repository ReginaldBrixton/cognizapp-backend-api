import { getDb } from "../../lib/db";
import type { JSONValue } from "postgres";
import type {
  DocumentCommentReply,
  ProjectDocumentComment,
  ReplaceCommentsInput,
} from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

export const documentCommentRepository = {
  async findByDocumentId(documentId: string): Promise<ProjectDocumentComment[]> {
    const db = getDb();
    const rows = await db`
      SELECT *
      FROM project_document_comments
      WHERE document_id = ${documentId}
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `;
    return rows.map(this.mapRowToComment);
  },

  async replaceForDocument(
    documentId: string,
    projectId: string,
    userId: string,
    payload: ReplaceCommentsInput,
  ): Promise<ProjectDocumentComment[]> {
    const db = getDb();

    await db.begin(async (tx) => {
      const sql = tx as unknown as ReturnType<typeof getDb>;

      await sql`
        DELETE FROM project_document_comments
        WHERE document_id = ${documentId}
      `;

      for (const [index, comment] of payload.comments.entries()) {
        const createdAt = comment.createdAt ?? new Date().toISOString();
        const updatedAt = comment.updatedAt ?? createdAt;
        const replies = Array.isArray(comment.replies) ? comment.replies : [];
        const persistedCommentId = comment.id
          ? `${documentId}:${comment.id}`
          : `${documentId}:${Date.now()}-${index}`;
        const anchor = {
          type: "text",
          from: Number(comment.from ?? 0),
          to: Number(comment.to ?? 0),
          excerpt: String(comment.selectedText ?? ""),
        };

        await sql`
          INSERT INTO project_document_comments (
            id,
            document_id,
            project_id,
            user_id,
            body,
            anchor,
            resolved,
            replies,
            metadata,
            created_at,
            updated_at
          ) VALUES (
            ${persistedCommentId},
            ${documentId},
            ${projectId},
            ${comment.authorId || userId},
            ${comment.text || ""},
            ${sql.json(toJsonValue(anchor))},
            ${Boolean(comment.resolved)},
            ${sql.json(toJsonValue(replies))},
            ${sql.json(toJsonValue({
              authorName: comment.author || null,
              clientCommentId: comment.id || null,
            }))},
            ${createdAt},
            ${updatedAt}
          )
        `;
      }
    });

    return this.findByDocumentId(documentId);
  },

  mapRowToComment(row: Record<string, unknown>): ProjectDocumentComment {
    const metadata = (row.metadata as Record<string, unknown>) ?? {};
    const rawReplies = Array.isArray(row.replies)
      ? (row.replies as Array<Record<string, unknown>>)
      : [];

    const replies: DocumentCommentReply[] = rawReplies.map((reply, index) => ({
      id: String(reply.id ?? `${row.id}-reply-${index}`),
      text: String(reply.text ?? ""),
      author: String(reply.author ?? "Unknown"),
      authorId: reply.authorId ? String(reply.authorId) : undefined,
      createdAt: String(reply.createdAt ?? row.created_at),
      updatedAt: reply.updatedAt ? String(reply.updatedAt) : undefined,
    }));

    return {
      id: String(row.id),
      documentId: String(row.document_id),
      projectId: String(row.project_id),
      userId: String(row.user_id),
      body: String(row.body ?? ""),
      anchor: {
        type: "text",
        from: Number((row.anchor as Record<string, unknown>)?.from ?? 0),
        to: Number((row.anchor as Record<string, unknown>)?.to ?? 0),
        excerpt: String((row.anchor as Record<string, unknown>)?.excerpt ?? ""),
      },
      resolved: Boolean(row.resolved),
      replies,
      metadata,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },
};
