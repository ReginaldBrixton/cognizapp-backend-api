export type UserSettings = {
  id: string;
  userId: string;
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  schemaVersion: number;
  featureFlags: Record<string, unknown>;
  account: {
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    backupCodesRemaining: number;
    subscriptionPlan: string;
    subscriptionStatus: string;
    billingCycle: string;
    nextBillingDate: string | null;
    paymentMethod: {
      type: string | null;
      lastFour: string | null;
      expiryDate: string | null;
    };
  };
  profile: {
    displayName: string | null;
    bio: string | null;
    location: string | null;
    website: string | null;
    company: string | null;
    jobTitle: string | null;
    socialLinks: {
      twitter: string | null;
      linkedin: string | null;
      github: string | null;
    };
  };
  appearance: {
    theme: 'light' | 'dark' | 'system';
    colorScheme: string;
    fontSize: 'small' | 'medium' | 'large';
    density: 'compact' | 'comfortable' | 'spacious';
    sidebarCollapsed: boolean;
    showPreview: boolean;
  };
  notifications: {
    email: {
      enabled: boolean;
      marketing: boolean;
      productUpdates: boolean;
      securityAlerts: boolean;
      newsletter: boolean;
      digest: 'daily' | 'weekly' | 'monthly' | 'never';
    };
    inApp: {
      enabled: boolean;
      sound: boolean;
      desktop: boolean;
      mentions: boolean;
      replies: boolean;
      reactions: boolean;
    };
    push: {
      enabled: boolean;
      mentions: boolean;
      directMessages: boolean;
      workspaceActivity: boolean;
    };
  };
  preferences: {
    language: string;
    timezone: string;
    dateFormat: string;
    timeFormat: '12h' | '24h';
    firstDayOfWeek: 'sunday' | 'monday';
    defaultWorkspace: string | null;
    autoSave: boolean;
    autoSaveInterval: number;
    spellCheck: boolean;
    grammarCheck: boolean;
  };
  security: {
    loginAlerts: boolean;
    newDeviceAlerts: boolean;
    passwordLastChanged: string | null;
    lastLoginAt: string | null;
    lastLoginIp: string | null;
    trustedDevices: Array<{
      id: string;
      name: string;
      lastUsed: string;
    }>;
  };
  onboarding: {
    completed: boolean;
    skipped: boolean;
    stepsCompleted: string[];
    currentStep: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
  privacy: {
    profileVisibility: 'public' | 'workspace' | 'private';
    activityStatus: boolean;
    readReceipts: boolean;
    analyticsOptIn: boolean;
    dataExportRequested: boolean;
    dataRetentionDays: number;
  };
  storage: {
    usedBytes: number;
    quotaBytes: number;
    warnThreshold: number;
    autoCleanup: boolean;
    deletedItemsRetention: number;
  };
  institution: {
    name: string;
    type: 'university' | 'college' | 'research_institute' | 'school' | 'government' | 'corporate' | 'ngo' | 'other';
    department: string;
    position: string;
    country: string;
    city: string;
    website: string;
    orcid: string;
    googleScholarId: string;
    researchGateId: string;
    researchInterests: string[];
    affiliationVerified: boolean;
  };
  ai: {
    enabled: boolean;
    defaultModel: string;
    preferredModels: string[];
    autoComplete: boolean;
    suggestionsEnabled: boolean;
    historyRetention: number;
    privacyMode: boolean;
  };
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type UserSection = 
  | 'account' 
  | 'profile' 
  | 'appearance' 
  | 'notifications' 
  | 'preferences' 
  | 'security' 
  | 'onboarding' 
  | 'privacy' 
  | 'storage' 
  | 'ai'
  | 'institution';

export const ALLOWED_USER_SECTIONS: UserSection[] = [
  'account', 'profile', 'appearance', 'notifications', 'preferences', 
  'security', 'onboarding', 'privacy', 'storage', 'ai', 'institution'
];

export const READ_ONLY_USER_SECTIONS: UserSection[] = [];
