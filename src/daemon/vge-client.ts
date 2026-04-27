import * as crypto from 'crypto';
import type { Config } from '../shared/config-schema.js';
import type { GuardResponseSubset } from '../shared/types.js';
import { truncateText } from './truncate.js';

type GetConfig = () => Config;

let getConfigFn: GetConfig | undefined;
let apiKeyWarnedOnce = false;

export function initClient(getConfig: GetConfig): void {
  getConfigFn = getConfig;
}

function cfg(): Config {
  if (!getConfigFn) throw new Error('[vge-client] initClient() not called');
  return getConfigFn();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAnalyzeBody(
  text: string,
  toolName: string,
  resourceId: string,
  sessionId: string,
): string {
  return JSON.stringify({
    text: truncateText(text),
    source: 'tool_output',
    agent: { sessionId, traceId: crypto.randomUUID() },
    tool: { name: toolName },
    metadata: {
      platform: 'claude-code',
      vgeAgentGuard: {
        resourceId,
        userAllowlisted: false,
        escalationId: null,
        subagent: false,
        parentSessionId: null,
      },
    },
  });
}

export async function analyzeToolOutput(
  text: string,
  toolName: string,
  resourceId: string,
  sessionId: string,
): Promise<GuardResponseSubset | null> {
  const config = cfg();
  if (!config.vge.api_key_input) {
    if (!apiKeyWarnedOnce) {
      console.warn(
        '[vge-client] VGE API key not configured — skipping analysis. Run `vge-cc-guard config` to set it up.',
      );
      apiKeyWarnedOnce = true;
    }
    return null;
  }

  const url = `${config.vge.api_url}/v1/guard/analyze`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.vge.api_key_input}`,
  };
  const body = buildAnalyzeBody(text, toolName, resourceId, sessionId);
  const startTime = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const remaining = 5000 - (Date.now() - startTime);
    if (remaining <= 0) break;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(remaining),
      });
      if (res.ok) return (await res.json()) as GuardResponseSubset;
      if (res.status < 500) break; // 4xx — no retry
    } catch {
      // network error or timeout — retry if budget remains
    }
    if (attempt < 2 && Date.now() - startTime < 5000) {
      await sleep(100 * Math.pow(2, attempt));
    }
  }
  console.error(`[vge-client] analyzeToolOutput failed for ${toolName}:${resourceId}`);
  return null;
}

export function postUserPrompt(prompt: string, sessionId: string): void {
  const config = cfg();
  if (!config.vge.api_key_input) return;
  const url = `${config.vge.api_url}/v1/guard/input`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.vge.api_key_input}`,
    },
    body: JSON.stringify({
      prompt,
      agent: { sessionId, traceId: crypto.randomUUID() },
      metadata: { platform: 'claude-code' },
    }),
  }).catch((err: unknown) => console.error('[vge-client] postUserPrompt error:', err));
}
