import { z } from 'zod';

const toolPolicySchema = z.object({
  gate: z.enum(['allow', 'block', 'ask']),
  analyze_output: z.boolean(),
});

export type ToolPolicy = z.infer<typeof toolPolicySchema>;

const vgeConfigSchema = z.object({
  api_url: z.string().url(),
  // Empty string is valid at schema level — daemon starts before user runs `vge-cc-guard config`.
  // vge-client.ts validates non-empty key at call time.
  api_key_input: z.string(),
  api_key_output: z.string().nullable().default(null),
  verified_at: z.string().datetime().nullable().default(null),
});

const policyConfigSchema = z.object({
  credential_protection: z.boolean().default(true),
  fatigue_cap_per_session: z.number().int().min(1).max(20).default(3),
  session_idle_ttl_hours: z.number().int().min(1).max(168).default(24),
});

export const configSchema = z.object({
  version: z.literal('1.0.0'),
  vge: vgeConfigSchema,
  tools: z.record(z.string(), toolPolicySchema),
  policy: policyConfigSchema,
});

export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = {
  version: '1.0.0',
  vge: {
    api_url: 'https://api.vigilguard',
    api_key_input: '',
    api_key_output: null,
    verified_at: null,
  },
  tools: {
    Bash:      { gate: 'allow', analyze_output: true  },
    Read:      { gate: 'allow', analyze_output: true  },
    Grep:      { gate: 'allow', analyze_output: true  },
    Glob:      { gate: 'allow', analyze_output: false },
    WebSearch: { gate: 'allow', analyze_output: true  },
    WebFetch:  { gate: 'allow', analyze_output: true  },
    Write:     { gate: 'block', analyze_output: false },
    Edit:      { gate: 'block', analyze_output: false },
    Task:      { gate: 'allow', analyze_output: false },
    '*':       { gate: 'ask',   analyze_output: false },
  },
  policy: {
    credential_protection: true,
    fatigue_cap_per_session: 3,
    session_idle_ttl_hours: 24,
  },
};
