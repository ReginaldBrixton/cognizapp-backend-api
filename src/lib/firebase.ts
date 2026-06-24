import { initializeApp, getApps, getApp, applicationDefault, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { env } from "../config/env";

export function getFirebaseAdminAuth() {
  if (!getApps().length) {
    if (!env.firebaseProjectId) {
      throw new Error("FIREBASE_PROJECT_ID is not defined in environment");
    }
    
    let credential;
    if (env.firebaseCredentialsBase64) {
      const decoded = Buffer.from(env.firebaseCredentialsBase64, "base64").toString("utf-8");
      credential = cert(JSON.parse(decoded));
    } else if (env.googleServiceAccountJson) {
      credential = cert(JSON.parse(env.googleServiceAccountJson));
    } else {
      console.warn("[Firebase] No service account JSON or Base64 credentials provided. Using default credentials.");
      credential = applicationDefault();
    }

    initializeApp({
      credential,
      projectId: env.firebaseProjectId,
    });
    
    console.info(`[Firebase] Initialized Admin SDK for project ${env.firebaseProjectId}`);
  }
  return getAuth(getApp());
}
