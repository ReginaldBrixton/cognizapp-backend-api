import { HttpError } from "../../lib/errors";
import { getDb } from "../../lib/db";
import { workspaceRepository } from "../workspace/repository";
import { analysisRepository } from "./repository";

/**
 * Verifies that the user has access to the workspace.
 * User must be either the owner or a member of the workspace.
 */
async function verifyWorkspaceAccess(userId: string, workspaceId: string): Promise<void> {
  const workspace = await workspaceRepository.getById(workspaceId);
  if (!workspace) {
    throw new HttpError(404, "workspace_not_found", "Workspace not found");
  }
  if (workspace.ownerUid === userId) {
    return; // Owner has full access
  }
  const member = await workspaceRepository.getMember(workspaceId, userId);
  if (!member) {
    throw new HttpError(403, "forbidden", "Access denied to this workspace");
  }
}

function currentUsagePeriod() {
  const now = new Date();
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
  };
}

async function assertAnalysisAllowance(userId: string, workspaceId: string) {
  const db = getDb();
  const { start, end } = currentUsagePeriod();
  const [row] = await db`
    SELECT p.id AS plan_id, p.name, p.analysis_limit_monthly,
      COALESCE(SUM(l.quantity), 0)::int AS used
    FROM workspaces w
    LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id AND s.status = 'active'
    LEFT JOIN subscription_plans p ON p.id = COALESCE(s.plan_id, w.plan, 'free')
    LEFT JOIN workspace_usage_ledger l
      ON l.workspace_id = w.id
      AND l.usage_type = 'analysis_request'
      AND l.period_start = ${start.toISOString().slice(0, 10)}::date
      AND l.period_end = ${end.toISOString().slice(0, 10)}::date
    WHERE w.id = ${workspaceId}::uuid
    GROUP BY p.id, p.name, p.analysis_limit_monthly
    LIMIT 1
  `;
  const limit = Number(row?.analysis_limit_monthly ?? 10);
  const used = Number(row?.used ?? 0);
  if (used >= limit) {
    throw new HttpError(402, "plan_limit_reached", "Your monthly analysis limit has been reached. Upgrade your plan to continue.", {
      usageType: "analysis_request",
      used,
      limit,
      planId: row?.plan_id ?? "free",
      planName: row?.name ?? "Free",
    });
  }
}

async function recordAnalysisUsage(userId: string, workspaceId: string, analysisId: string) {
  const db = getDb();
  const { start, end } = currentUsagePeriod();
  await db`
    INSERT INTO workspace_usage_ledger (
      workspace_id, user_key_id, usage_type, quantity, period_start, period_end,
      source_table, source_id, metadata
    )
    VALUES (
      ${workspaceId}::uuid, ${userId}, 'analysis_request', 1,
      ${start.toISOString().slice(0, 10)}::date, ${end.toISOString().slice(0, 10)}::date,
      'workspace_analysis', ${analysisId}::uuid, ${db.json({ source: "workspace-analysis" })}
    )
  `;
}

export const analysisService = {
  async listAnalysis(userId: string, workspaceId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    return await analysisRepository.findByWorkspaceId(workspaceId);
  },

  async createHumanise(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    await assertAnalysisAllowance(userId, workspaceId);
    const analysis = await analysisRepository.create({
      workspaceId,
      ownerUid: userId,
      analysisType: "humanise",
      title: data.title as string,
      description: "",
      status: "pending",
      inputData: { originalText: data.originalText },
      resultData: {},
      confidenceScore: null,
      sourceReference: null,
      metadata: {},
      deletedAt: null,
    });
    await recordAnalysisUsage(userId, workspaceId, analysis.id);
    return analysis;
  },

  async createTextCompare(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    await assertAnalysisAllowance(userId, workspaceId);
    const analysis = await analysisRepository.create({
      workspaceId,
      ownerUid: userId,
      analysisType: "textcompare",
      title: data.title as string,
      description: "",
      status: "pending",
      inputData: { textA: data.textA, textB: data.textB },
      resultData: {},
      confidenceScore: null,
      sourceReference: null,
      metadata: {},
      deletedAt: null,
    });
    await recordAnalysisUsage(userId, workspaceId, analysis.id);
    return analysis;
  },

  async createTextIdentify(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    await assertAnalysisAllowance(userId, workspaceId);
    const analysis = await analysisRepository.create({
      workspaceId,
      ownerUid: userId,
      analysisType: "textidentify",
      title: data.title as string,
      description: "",
      status: "pending",
      inputData: { inputText: data.inputText },
      resultData: {},
      confidenceScore: null,
      sourceReference: null,
      metadata: {},
      deletedAt: null,
    });
    await recordAnalysisUsage(userId, workspaceId, analysis.id);
    return analysis;
  },

  async createFactCheck(userId: string, workspaceId: string, data: Record<string, unknown>) {
    await verifyWorkspaceAccess(userId, workspaceId);
    await assertAnalysisAllowance(userId, workspaceId);
    const analysis = await analysisRepository.create({
      workspaceId,
      ownerUid: userId,
      analysisType: "factcheck",
      title: data.title as string,
      description: "",
      status: "pending",
      inputData: { claimText: data.claimText },
      resultData: {},
      confidenceScore: null,
      sourceReference: null,
      metadata: {},
      deletedAt: null,
    });
    await recordAnalysisUsage(userId, workspaceId, analysis.id);
    return analysis;
  },

  async getAnalysis(userId: string, workspaceId: string, analysisId: string) {
    await verifyWorkspaceAccess(userId, workspaceId);
    const analysis = await analysisRepository.findById(analysisId);
    if (!analysis || analysis.workspaceId !== workspaceId) {
      throw new HttpError(404, "analysis_not_found", "Analysis not found");
    }
    return analysis;
  },
};
