// Session state machine (PRD_1 §4.1, §7.3)
export type SessionState = 'clean' | 'caution' | 'tainted';

// Confidence Router outcomes (PRD_1 §7.7)
export type RouterOutcome = 'HARD_TAINT' | 'SOFT_TAINT' | 'ESCALATE' | 'ALLOW';

// PreToolUse gate decision mapped to Claude Code permissionDecision
export type GateDecision = 'allow' | 'deny' | 'ask';

// Ask-dialog user decision vocabulary (PRD_1 §7.9)
export type EscalationDecision = 'once' | 'session' | 'block' | 'quarantine';

// One pending escalation (PRD_1 §7.9)
export interface Escalation {
  escalationId: string;
  sessionId: string;
  toolName: string;
  resourceId: string;
  analysisId: string | null;
  branches: { heuristics: number; semantic: number; llmGuard: number };
  routerOutcome: RouterOutcome;
  enqueuedAt: number;
}

// In-memory per-session state (PRD_1 §4.1, §7.9.3)
export interface SessionData {
  sessionId: string;
  parentSessionId: string | null;
  createdAt: number;
  lastActivity: number;
  state: SessionState;
  // Set of canonicalized "(toolName):(resourceId)" strings — O(1) lookup
  allowlist: Set<string>;
  pendingEscalations: Escalation[];
  escalationCount: number;
}

// VGE GuardResponse branches subset used by the Confidence Router.
// Full GuardResponse lives in VGE packages/shared/src/schemas/index.ts:236–334.
export interface GuardBranches {
  heuristics?: { score: number } | null;
  semantic?: { score: number } | null;
  llmGuard?: { score: number } | null;
}

export interface GuardResponseSubset {
  decision: 'ALLOWED' | 'BLOCKED' | 'SANITIZED';
  score: number;
  branches: GuardBranches;
  ruleAction?: 'ALLOW' | 'BLOCK' | 'LOG' | 'SANITIZE';
  decisionFlags?: string[];
  failOpen?: boolean;
  id?: string;
}

// Claude Code hook payload shapes (what CC sends to our shim via stdin)
export interface CCBasePayload {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  parent_session_id?: string;
}

export interface CCSessionStartPayload extends CCBasePayload {
  hook_event_name: 'SessionStart';
}

export interface CCSessionEndPayload extends CCBasePayload {
  hook_event_name: 'SessionEnd';
}

export interface CCUserPromptPayload extends CCBasePayload {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}

export interface CCPreToolPayload extends CCBasePayload {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface CCPostToolPayload extends CCBasePayload {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: string;
  tool_error: string | null;
}

export type CCHookPayload =
  | CCSessionStartPayload
  | CCSessionEndPayload
  | CCUserPromptPayload
  | CCPreToolPayload
  | CCPostToolPayload;
