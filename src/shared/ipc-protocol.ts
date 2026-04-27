// Shim → Daemon: shim forwards the raw CC hook payload plus the event name.
export interface ShimRequest {
  event: 'sessionstart' | 'userprompt' | 'pretool' | 'posttool' | 'sessionend';
  payload: Record<string, unknown>;
}

export interface SessionStartResponse {
  event: 'sessionstart';
  ccOutput: null;
}

export interface SessionEndResponse {
  event: 'sessionend';
  ccOutput: null;
}

// null ccOutput means write nothing to stdout — prompt passes through.
export interface UserPromptResponse {
  event: 'userprompt';
  ccOutput: { decision: 'block'; reason: string } | null;
}

// PreToolUse MUST use hookSpecificOutput — never a top-level decision field.
// Claude Code ignores top-level decision for PreToolUse events.
export interface PreToolResponse {
  event: 'pretool';
  ccOutput: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse';
      permissionDecision: 'allow' | 'deny' | 'ask';
      permissionDecisionReason?: string;
    };
  };
}

// Tool already ran — block provides advisory feedback to Claude, not enforcement.
export interface PostToolResponse {
  event: 'posttool';
  ccOutput: { decision: 'block'; reason: string } | null;
}

export type DaemonResponse =
  | SessionStartResponse
  | SessionEndResponse
  | UserPromptResponse
  | PreToolResponse
  | PostToolResponse;
