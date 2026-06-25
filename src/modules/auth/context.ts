import type { UserRecord } from "./types";

export type AuthContext = {
  actorId: string;
  userId: string;
  email: string;
  role: string;
  actorType: "human" | "system";
  permissions: string[];
  sessionId: string;
  user?: UserRecord;
};
