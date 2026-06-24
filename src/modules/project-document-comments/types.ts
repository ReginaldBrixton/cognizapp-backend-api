export type DocumentCommentAnchor = {
  type: "text";
  from: number;
  to: number;
  excerpt: string;
};

export type DocumentCommentReply = {
  id: string;
  text: string;
  author: string;
  authorId?: string;
  createdAt: string;
  updatedAt?: string;
};

export type ProjectDocumentComment = {
  id: string;
  documentId: string;
  projectId: string;
  userId: string;
  body: string;
  anchor: DocumentCommentAnchor;
  resolved: boolean;
  replies: DocumentCommentReply[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type ReplaceCommentsInput = {
  comments: Array<{
    id?: string;
    text?: string;
    selectedText?: string;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
    authorId?: string;
    from?: number;
    to?: number;
    resolved?: boolean;
    replies?: DocumentCommentReply[];
  }>;
};
