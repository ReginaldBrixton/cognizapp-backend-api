export type ProjectDiagram = {
  id: string;
  projectId: string;
  ownerUid: string;
  title: string;
  diagramType: "mermaid" | "drawio" | "plantuml" | "excalidraw" | "svg";
  diagramData: Record<string, unknown>;
  version: number;
  collaborators: string[];
  isPublic: boolean;
  status: "active" | "archived" | "trashed";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateDiagramInput = {
  title?: string;
  diagramType?: ProjectDiagram["diagramType"];
  diagramData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type UpdateDiagramInput = Partial<CreateDiagramInput> & {
  status?: ProjectDiagram["status"];
  isPublic?: boolean;
};

export type DiagramFilter = {
  search?: string;
  diagramType?: ProjectDiagram["diagramType"];
  status?: ProjectDiagram["status"];
  sortBy?: "created_at" | "updated_at" | "title";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};