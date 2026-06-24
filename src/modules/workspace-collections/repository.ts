import type { JSONValue } from "postgres";
import { getDb } from "../../lib/db";
import type { Collection, CollectionItem } from "./types";

function toJsonValue(value: unknown): JSONValue {
  return value as JSONValue;
}

export const collectionRepository = {
  async findByWorkspaceId(workspaceId: string): Promise<Collection[]> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_collections
      WHERE workspace_id = ${workspaceId}
      AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at DESC
    `;
    return rows.map(this.mapRowToCollection);
  },

  async findById(id: string): Promise<Collection | null> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM workspace_collections
      WHERE id = ${id}
      AND deleted_at IS NULL
    `;
    if (!rows[0]) return null;

    const collection = this.mapRowToCollection(rows[0]);
    collection.items = await this.findItemsByCollectionId(id);
    return collection;
  },

  async findItemsByCollectionId(collectionId: string): Promise<CollectionItem[]> {
    const db = getDb();
    const rows = await db`
      SELECT * FROM collection_items
      WHERE collection_id = ${collectionId}
      ORDER BY sort_order ASC
    `;
    return rows.map(this.mapRowToCollectionItem);
  },

  async create(data: Omit<Collection, "id" | "createdAt" | "updatedAt">): Promise<Collection> {
    const db = getDb();
    const rows = await db`
      INSERT INTO workspace_collections (
        workspace_id, owner_uid, name, description, collection_type,
        parent_id, filters, sort_order, is_default, metadata
      ) VALUES (
        ${data.workspaceId}, ${data.ownerUid}, ${data.name}, ${data.description}, ${data.collectionType},
        ${data.parentId}, ${db.json(toJsonValue(data.filters))}, ${data.sortOrder}, ${data.isDefault}, ${db.json(toJsonValue(data.metadata))}
      )
      RETURNING *
    `;
    return this.mapRowToCollection(rows[0]);
  },

  async update(id: string, data: Record<string, unknown>): Promise<Collection> {
    const db = getDb();
    const current = await this.findById(id);
    if (!current) {
      throw new Error("Collection not found");
    }

    const setClauses: ReturnType<typeof db>[] = [];
    const camelToSnake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

    for (const [key, value] of Object.entries(data)) {
      const col = camelToSnake(key);
      if (col === "metadata" || col === "filters") {
        setClauses.push(db`${db(col)} = ${db.json(value as any)}`);
      } else {
        setClauses.push(db`${db(col)} = ${value as any}`);
      }
    }

    const fragments = setClauses.flatMap((f, i) => (i === 0 ? [f] : [db`, `, f]));

    const rows = await db`
      UPDATE workspace_collections
      SET ${fragments}, updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return this.mapRowToCollection(rows[0]);
  },

  async delete(id: string): Promise<void> {
    const db = getDb();
    await db`
      UPDATE workspace_collections
      SET deleted_at = NOW()
      WHERE id = ${id}
    `;
  },

  async addItem(data: Omit<CollectionItem, "id" | "addedAt">): Promise<CollectionItem> {
    const db = getDb();
    const rows = await db`
      INSERT INTO collection_items (
        collection_id, item_type, item_id, added_by, sort_order, metadata
      ) VALUES (
        ${data.collectionId}, ${data.itemType}, ${data.itemId}, ${data.addedBy}, ${data.sortOrder}, ${db.json(toJsonValue(data.metadata))}
      )
      RETURNING *
    `;
    return this.mapRowToCollectionItem(rows[0]);
  },

  async removeItem(itemId: string): Promise<void> {
    const db = getDb();
    await db`
      DELETE FROM collection_items
      WHERE id = ${itemId}
    `;
  },

  mapRowToCollection(row: Record<string, unknown>): Collection {
    return {
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      ownerUid: String(row.owner_uid),
      name: String(row.name),
      description: String(row.description ?? ""),
      collectionType: row.collection_type as Collection["collectionType"],
      parentId: row.parent_id ? String(row.parent_id) : null,
      items: (row.items as CollectionItem[]) ?? [],
      filters: (row.filters as Record<string, unknown> | null) ?? null,
      sortOrder: Number(row.sort_order ?? 0),
      isDefault: Boolean(row.is_default),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  },

  mapRowToCollectionItem(row: Record<string, unknown>): CollectionItem {
    return {
      id: String(row.id),
      collectionId: String(row.collection_id),
      itemType: row.item_type as CollectionItem["itemType"],
      itemId: String(row.item_id),
      addedBy: String(row.added_by),
      addedAt: String(row.added_at),
      sortOrder: Number(row.sort_order ?? 0),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
    };
  },
};
