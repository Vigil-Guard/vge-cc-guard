import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import {
  loadConfig,
  resolveToolPolicy,
  getCurrentConfig,
  startWatcher,
  stopWatcher,
} from './tool-policy.js';
import { checkPath } from './path-deny.js';
import {
  createSession,
  getSession,
  deleteSession,
  addToAllowlist,
  transitionState,
  enqueueEscalation,
  gcIdleSessions,
  resetSession,
} from './session-state.js';
import { canonicalizeKey } from './allowlist.js';
import { routeResponse } from './confidence-router.js';
import { hasPending, applyDecision, formatDenyReason } from './ask-dialog.js';
import { isBinaryBuffer } from './truncate.js';
import { analyzeToolOutput, postUserPrompt, initClient } from './vge-client.js';
import {
  logToolOutputEscalated,
  logEscalationResolved,
  logToolOutputAnalyzed,
  logCredentialPathDenied,
  cleanupOldLogs,
} from './audit-logger.js';
import { parseReply } from './reply-parser.js';
import type { CCPreToolPayload, CCPostToolPayload, CCUserPromptPayload } from '../shared/types.js';
import { DEFAULT_CONFIG } from '../shared/config-schema.js';

function getDefaultSocketPath(): string {
  const base =
    process.env['VGE_CC_GUARD_CONFIG_DIR'] ?? path.join(os.homedir(), '.vge-cc-guard');
  return path.join(base, 'daemon.sock');
}

function denyResponse(res: Response, reason: string): void {
  res.json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

function allowResponse(res: Response): void {
  res.json({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
  });
}

function handleSessionStart(req: Request, res: Response): void {
  const body = req.body as { session_id: string; parent_session_id?: string };
  createSession(body.session_id, body.parent_session_id ?? null);
  res.json({ ok: true });
}

function handleSessionEnd(req: Request, res: Response): void {
  const body = req.body as { session_id: string };
  deleteSession(body.session_id);
  res.json({ ok: true });
}

async function handleUserPrompt(req: Request, res: Response): Promise<void> {
  const payload = req.body as CCUserPromptPayload;
  const session = getSession(payload.session_id);

  if (session && hasPending(session)) {
    const parsed = parseReply(payload.prompt);
    if (!parsed) {
      res.json({
        ccOutput: {
          decision: 'block',
          reason:
            'VGE Agent Guard: unclear reply. Please respond with: once / session / block / quarantine.',
        },
      });
      return;
    }
    const resolved = applyDecision(session, parsed.decision, { transitionState, addToAllowlist });
    if (resolved) {
      logEscalationResolved({
        escalationId: resolved.escalationId,
        sessionId: session.sessionId,
        decision: parsed.decision,
        enqueuedAt: resolved.enqueuedAt,
      });
    }
    res.json({ ccOutput: null });
    return;
  }

  // Fire-and-forget — intentionally not awaited
  postUserPrompt(payload.prompt, payload.session_id);
  res.json({ ccOutput: null });
}

function handlePreTool(req: Request, res: Response): void {
  try {
    handlePreToolInner(req, res);
  } catch (err) {
    // PR-review C2: daemon must NEVER let an exception bubble to Express's
    // default 500 handler. The shim's fail-closed contract relies on a parseable
    // hookSpecificOutput response; a 500 with HTML body would silently fail-open.
    console.error('[handlePreTool] unhandled exception:', err);
    denyResponse(res, 'VGE Agent Guard: internal error — denying for safety.');
  }
}

function handlePreToolInner(req: Request, res: Response): void {
  const payload = req.body as CCPreToolPayload;
  const session = getSession(payload.session_id) ?? createSession(payload.session_id, null);
  const config = getCurrentConfig() ?? DEFAULT_CONFIG;

  // Step 1: Credential path protection
  const pathTools = new Set(['Read', 'Edit', 'Write']);
  if (pathTools.has(payload.tool_name) && config.policy.credential_protection) {
    const rawPath = (payload.tool_input['file_path'] as string | undefined) ?? '';
    const { denied, resolvedPath } = checkPath(rawPath);
    if (denied) {
      logCredentialPathDenied({
        sessionId: payload.session_id,
        resolvedPath,
        credentialProtectionEnabled: true,
      });
      denyResponse(
        res,
        `VGE Agent Guard: ${resolvedPath} is on the credential protection deny list.`,
      );
      return;
    }
  }

  // Step 2: Pending escalation blocks next tool
  if (hasPending(session)) {
    const pending = session.pendingEscalations[0];
    if (pending) {
      denyResponse(res, formatDenyReason(pending, ''));
      return;
    }
  }

  // Step 3: Allowlist check
  const key = canonicalizeKey(payload.tool_name, payload.tool_input);
  if (session.allowlist.has(key)) {
    allowResponse(res);
    return;
  }

  // Step 4: Tainted session blocks destructive tools
  const destructiveTools = new Set(['Bash', 'Write', 'Edit', 'Task']);
  if (session.state === 'tainted' && destructiveTools.has(payload.tool_name)) {
    denyResponse(
      res,
      'VGE Agent Guard: session is tainted. Use `vge-cc-guard reset-session` to continue.',
    );
    return;
  }

  // Step 5: Per-tool gate from config
  const policy = resolveToolPolicy(payload.tool_name);
  if (policy.gate === 'allow') { allowResponse(res); return; }
  if (policy.gate === 'block') {
    denyResponse(res, `VGE Agent Guard: ${payload.tool_name} is blocked by policy.`);
    return;
  }
  // gate === 'ask'
  res.json({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `VGE Agent Guard: ${payload.tool_name} requires user approval.`,
    },
  });
}

async function handlePostTool(req: Request, res: Response): Promise<void> {
  const payload = req.body as CCPostToolPayload;
  const toolPolicy = resolveToolPolicy(payload.tool_name);
  const session = getSession(payload.session_id) ?? createSession(payload.session_id, null);
  const resourceId = canonicalizeKey(payload.tool_name, payload.tool_input);

  if (!toolPolicy.analyze_output) {
    logToolOutputAnalyzed({
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      resourceId,
      userAllowlisted: false,
      routerOutcome: 'ALLOW',
      enforcementTaken: 'none',
    });
    res.json({ ccOutput: null });
    return;
  }

  let textToAnalyze = payload.tool_response ?? '';
  // PR-review C4: convert to Buffer first so the magic-byte check operates on bytes,
  // not UTF-8 chars. Compute a real SHA-256 (was: hex-prefix mislabelled as sha256).
  const fullBuf = Buffer.from(textToAnalyze);
  if (isBinaryBuffer(fullBuf.subarray(0, 8))) {
    const sha = crypto.createHash('sha256').update(fullBuf).digest('hex');
    textToAnalyze = `[binary content, sha256=${sha}, len=${fullBuf.length}]`;
  }

  const vgeResult = await analyzeToolOutput(
    textToAnalyze,
    payload.tool_name,
    resourceId,
    payload.session_id,
  );

  if (!vgeResult) {
    res.json({ ccOutput: null });
    return;
  }

  const outcome = routeResponse(vgeResult);
  const config = getCurrentConfig() ?? DEFAULT_CONFIG;
  const fatigueCapPerSession = config.policy.fatigue_cap_per_session;

  if (outcome === 'HARD_TAINT' || outcome === 'SOFT_TAINT') {
    transitionState(payload.session_id, outcome === 'HARD_TAINT' ? 'tainted' : 'caution');
    logToolOutputAnalyzed({
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      resourceId,
      userAllowlisted: false,
      routerOutcome: outcome,
      enforcementTaken: 'tainted',
    });
  } else if (outcome === 'ESCALATE') {
    if (session.escalationCount >= fatigueCapPerSession) {
      transitionState(payload.session_id, 'tainted');
    } else {
      const escalation = {
        escalationId: `esc_${Date.now()}`,
        sessionId: payload.session_id,
        toolName: payload.tool_name,
        resourceId,
        analysisId: vgeResult.id ?? null,
        branches: {
          heuristics: vgeResult.branches.heuristics?.score ?? 0,
          semantic: vgeResult.branches.semantic?.score ?? 0,
          llmGuard: vgeResult.branches.llmGuard?.score ?? 0,
        },
        routerOutcome: outcome as 'ESCALATE',
        enqueuedAt: Date.now(),
      };
      enqueueEscalation(payload.session_id, escalation);
      logToolOutputEscalated({
        escalationId: escalation.escalationId,
        sessionId: payload.session_id,
        toolName: payload.tool_name,
        resourceId,
        analysisId: escalation.analysisId,
        branches: escalation.branches,
        routerOutcome: outcome,
      });
    }
  } else {
    logToolOutputAnalyzed({
      sessionId: payload.session_id,
      toolName: payload.tool_name,
      resourceId,
      userAllowlisted: false,
      routerOutcome: outcome,
      enforcementTaken: 'none',
    });
  }

  // Phase 1a: always return null — no decision feedback to Claude
  res.json({ ccOutput: null });
}

export async function startDaemon(socketPath?: string): Promise<{ stop: () => Promise<void> }> {
  loadConfig();
  initClient(() => getCurrentConfig() ?? DEFAULT_CONFIG);
  cleanupOldLogs();

  const sockPath = socketPath ?? getDefaultSocketPath();
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });
  try { fs.unlinkSync(sockPath); } catch { /* stale socket — ignore */ }

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  app.post('/health', (_req, res) => { res.json({ ok: true }); });
  app.post('/v1/hooks/sessionstart', handleSessionStart);
  app.post('/v1/hooks/sessionend', handleSessionEnd);
  app.post('/v1/hooks/userprompt', (req, res) => { void handleUserPrompt(req, res); });
  app.post('/v1/hooks/pretool', handlePreTool);
  app.post('/v1/hooks/posttool', (req, res) => { void handlePostTool(req, res); });

  // PR-review C1: control plane for the reset-session CLI command.
  // The Unix socket is local-only, so no auth is needed at this layer.
  app.post('/v1/control/reset-session', (req, res) => {
    const body = req.body as { session_id?: string };
    if (!body?.session_id) {
      res.status(400).json({ ok: false, error: 'missing session_id' });
      return;
    }
    const reset = resetSession(body.session_id);
    res.json({ ok: true, reset, session_id: body.session_id });
  });

  const server = http.createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });

  startWatcher();

  // PR-review C3: read TTL from config (1–168h range enforced by zod), not hardcoded.
  const gcTimer = setInterval(() => {
    const ttl = getCurrentConfig()?.policy.session_idle_ttl_hours
      ?? DEFAULT_CONFIG.policy.session_idle_ttl_hours;
    gcIdleSessions(ttl);
  }, 60_000);

  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] unhandledRejection:', reason);
  });

  return {
    stop: () =>
      new Promise<void>((resolve) => {
        clearInterval(gcTimer);
        stopWatcher();
        server.close(() => {
          try { fs.unlinkSync(sockPath); } catch { /* already gone */ }
          resolve();
        });
      }),
  };
}
