import postgres, { type Sql } from "postgres";

import { env } from "../config/env";

let dbInstance: Sql | null = null;

export function getDb() {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = postgres(env.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 30,
    prepare: false,
    // Suppress migration NOTICE messages (42P06, 42P07, 42710) from logs
    onnotice: (notice) => {
      if (!["42P06", "42P07", "42710"].includes(notice.code ?? "")) {
        console.warn("[pg notice]", notice.message);
      }
    },
    transform: {
      undefined: null,
    },
  });

  return dbInstance;
}

export async function closeDb() {
  if (!dbInstance) {
    return;
  }
  await dbInstance.end();
  dbInstance = null;
}
