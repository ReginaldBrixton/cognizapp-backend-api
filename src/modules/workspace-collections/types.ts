export type Collection = {
  id: string;
  workspaceId: string;
  ownerUid: string;
  name: string;
  description: string;
  collectionType: 'folder' | 'tag' | 'smart';
  parentId: string | null;
  items: CollectionItem[];
  filters: Record<string, unknown> | null;
  sortOrder: number;
  isDefault: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CollectionItem = {
  id: string;
  collectionId: string;
  itemType: 'project' | 'document' | 'slide' | 'note' | 'task';
  itemId: string;
  addedBy: string;
  addedAt: string;
  sortOrder: number;
  metadata: Record<string, unknown>;
};
