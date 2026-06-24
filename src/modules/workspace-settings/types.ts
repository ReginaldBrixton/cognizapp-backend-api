export type WorkspaceSettings = {
  id: string;
  workspaceId: string;
  ownerId: string;
  general: {
    name: string;
    description: string;
    visibility: 'private' | 'workspace' | 'public';
    allowMemberInvites: boolean;
    requireApproval: boolean;
    defaultRole: 'member' | 'viewer';
  };
  appearance: {
    color: string;
    icon: string;
    avatarUrl: string | null;
    coverUrl: string | null;
    theme: 'light' | 'dark' | 'system';
    customCss: string | null;
  };
  notifications: {
    enabled: boolean;
    channels: {
      email: boolean;
      inApp: boolean;
      push: boolean;
      slack: boolean;
    };
    events: {
      memberJoined: boolean;
      memberLeft: boolean;
      projectCreated: boolean;
      projectDeleted: boolean;
      taskCompleted: boolean;
      mentions: boolean;
    };
    digest: {
      enabled: boolean;
      frequency: 'daily' | 'weekly' | 'monthly';
      time: string;
      dayOfWeek: number;
    };
  };
  security: {
    twoFactorRequired: boolean;
    sessionTimeout: number;
    dataRetentionDays: number;
    ipWhitelist: string[];
    allowedCountries: string[];
    blockedCountries: string[];
    requirePasswordForSensitive: boolean;
    auditLogEnabled: boolean;
  };
  limits: {
    maxMembers: number;
    maxProjects: number;
    maxStorage: number;
    maxApiCallsPerDay: number;
    maxAiTokensPerDay: number;
    maxDocuments: number;
    maxSlides: number;
    maxNotes: number;
  };
  ai: {
    enabled: boolean;
    defaultModel: string;
    allowedModels: string[];
    maxTokensPerDay: number;
    enableCodeExecution: boolean;
    enableWebSearch: boolean;
    enableFileUpload: boolean;
    privacyMode: boolean;
    trainingOptOut: boolean;
  };
  access: {
    publicRead: boolean;
    publicWrite: boolean;
    allowGuestComments: boolean;
    inviteOnly: boolean;
    domainRestriction: string | null;
    ssoEnabled: boolean;
    ssoProvider: string | null;
  };
  features: {
    projectsEnabled: boolean;
    analysisEnabled: boolean;
    collectionsEnabled: boolean;
    tasksEnabled: boolean;
    notesEnabled: boolean;
    slidesEnabled: boolean;
    aiEnabled: boolean;
    apiAccess: boolean;
    webhooksEnabled: boolean;
    customDomains: boolean;
  };
  storage: {
    maxFileSize: number;
    allowedFileTypes: string[];
    autoCleanup: boolean;
    deletedRetentionDays: number;
  };
  integrations: Record<string, {
    enabled: boolean;
    config: Record<string, unknown>;
    connectedAt: string | null;
  }>;
  billing: {
    plan: string;
    status: string;
    trialEndsAt: string | null;
    subscriptionId: string | null;
    customerId: string | null;
    billingEmail: string | null;
    billingAddress: {
      line1: string | null;
      line2: string | null;
      city: string | null;
      state: string | null;
      postalCode: string | null;
      country: string | null;
    };
  };
  institution: {
    name: string;
    type: 'university' | 'college' | 'research_institute' | 'school' | 'government' | 'corporate' | 'ngo' | 'other';
    department: string;
    country: string;
    city: string;
    website: string;
    orcid: string;
    accreditation: string;
    affiliationVerified: boolean;
  };
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

// Alias for backward compatibility
export type WorkspaceSettingsV2 = WorkspaceSettings;

export type WorkspaceSection = 
  | 'general' 
  | 'appearance' 
  | 'notifications' 
  | 'security' 
  | 'limits' 
  | 'ai' 
  | 'access'
  | 'features'
  | 'storage'
  | 'integrations' 
  | 'billing'
  | 'institution';

export const ALLOWED_WORKSPACE_SECTIONS: WorkspaceSection[] = [
  'general', 'appearance', 'notifications', 'security', 'limits', 'ai', 'access', 'features', 'storage', 'integrations', 'billing', 'institution'
];

export const READ_ONLY_WORKSPACE_SECTIONS: WorkspaceSection[] = ['limits', 'billing'];

