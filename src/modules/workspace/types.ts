export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const ASSIGNABLE_WORKSPACE_ROLES = [
  "admin",
  "member",
  "viewer",
] as const;

export type AssignableWorkspaceRole =
  (typeof ASSIGNABLE_WORKSPACE_ROLES)[number];

export type WorkspaceConfig = {
  defaultProjectVisibility?: string;
  allowMemberInvites?: boolean;
  requireApproval?: boolean;
  notificationsEnabled?: boolean;
  notificationChannels?: {
    email: boolean;
    inApp: boolean;
    push: boolean;
  };
  emailDigest?: {
    enabled: boolean;
    frequency: string;
    time: string;
  };
  theme?: string;
  language?: string;
  dateFormat?: string;
  timeZone?: string;
  enabledFeatures?: string[];
  disabledFeatures?: string[];
  integrations?: Record<string, unknown>;
  aiSettings?: {
    defaultModel?: string;
    allowedModels?: string[];
    maxTokensPerDay?: number;
    enableCodeExecution?: boolean;
    enableWebSearch?: boolean;
  };
  security?: {
    twoFactorRequired?: boolean;
    sessionTimeout?: number;
    dataRetentionDays?: number;
    requirePasswordChange?: boolean;
    passwordChangeInterval?: number;
    ipWhitelist?: string[];
    allowedCountries?: string[];
  };
  driveFolderId?: string;
  driveFolderPath?: string;
};

export type WorkspaceLimits = {
  maxMembers: number;
  maxProjects: number;
  maxStorage: number;
  maxApiCallsPerDay: number;
  maxAiTokensPerDay: number;
};

export type WorkspaceCounters = {
  projects: number;
  collections: number;
  automations: number;
  chats: number;
  members: number;
  files: number;
  tasks: number;
  notes: number;
  storageUsed: number;
  apiCallsToday: number;
  aiTokensToday: number;
};

export type Workspace = {
  id: string;
  ownerUid: string;
  name: string;
  slug: string;
  description: string;
  plan: string;
  status: string;
  isDefault: boolean;
  color: string | null;
  icon: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  settings: WorkspaceConfig | null;
  metadata: Record<string, unknown> | null;
  limits: WorkspaceLimits | null;
  counters: WorkspaceCounters;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type WorkspaceMember = {
  id: string;
  workspaceId: string;
  userUid: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  role: WorkspaceRole;
  invitedBy: string | null;
  invitedAt: string | null;
  inviteToken: string | null;
  inviteStatus: string | null;
  joinedAt: string | null;
  lastSeenAt: string | null;
  status: string;
  activityCount: number;
  lastActivityAt: string | null;
  preferences: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type WorkspaceActivity = {
  id: string;
  workspaceId: string;
  userUid: string;
  type: string;
  description: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type WorkspaceInvitation = {
  id: string;
  workspaceId: string;
  invitedBy: string;
  email: string;
  role: WorkspaceRole;
  token: string;
  tokenExpiresAt: string;
  status: string;
  acceptedBy: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
