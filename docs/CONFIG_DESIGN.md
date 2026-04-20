# vge-cc-guard Configurator Design

**TUI-based configuration for Phase 1 sidecar.**

Command: `vge-cc-guard config` — interactive terminal UI for API keys and policies.

---

## 1. Screen Flow

```
┌─────────────────────────────────────────┐
│          MAIN MENU                      │
│                                         │
│  ▶ API Keys Configuration               │
│    Tools Policy (NEW)                   │
│    VGE Decision Handling                │
│    Advanced Settings (Phase 2)          │
│    View Current Config                  │
│    Exit                                 │
└─────────────────────────────────────────┘
         ↓ (select API Keys)
┌─────────────────────────────────────────┐
│      API KEYS CONFIGURATION             │
│                                         │
│  VGE API URL                            │
│  [https://api.vigilguard_____________]│
│                                         │
│  Input API Key *                        │
│  [vg_test_________________________]    │
│                                         │
│  Output API Key (optional)              │
│  [                                   ]  │
│  ℹ️  Leave empty to use input key      │
│                                         │
│  □ Test Connection  [Save]  [Cancel]   │
└─────────────────────────────────────────┘
    ↓ (save)
┌─────────────────────────────────────────┐
│      BLOCK HANDLING POLICY              │
│                                         │
│  How to handle BLOCK decisions:         │
│                                         │
│  ○ Auto-block                           │
│    (immediately block tool execution)   │
│                                         │
│  ○ Human-in-the-loop                    │
│    (ask user for decision via popup)    │
│    Timeout: 30 seconds                  │
│                                         │
│            [Save]  [Cancel]             │
└─────────────────────────────────────────┘
    ↓ (save)
┌─────────────────────────────────────────┐
│      ✓ CONFIGURATION SAVED              │
│                                         │
│  Settings saved to:                     │
│  ~/.vge-cc-guard/config.json               │
│                                         │
│  Next steps:                            │
│  • Run: vge-cc-guard daemon                │
│  • Check logs: tail -f /tmp/vge-*.log   │
│                                         │
│              [OK - Return to Menu]      │
└─────────────────────────────────────────┘
```

---

## 2. Screens in Detail

### 2.1 Main Menu

**Navigation:** Arrow keys up/down, Enter to select, Ctrl+C to quit

```
┌──────────────────────────────────────┐
│    VGE Guard Configuration            │
│    v1.0.0                             │
│                                      │
│  ▶ API Keys Configuration             │
│    Block Handling Policy              │
│    Advanced Settings                  │
│    View Current Config                │
│    Exit                               │
│                                      │
│  Current config: ~/.vge-cc-guard/        │
│  Status: ✓ configured                 │
└──────────────────────────────────────┘
```

### 2.2 API Keys Configuration Screen

**Fields:**

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `VGE_API_URL` | Text input | No | `https://api.vigilguard` | Hostname/port of VGE |
| `VGE_API_KEY_INPUT` | Password input | Yes | — | Format: `vg_(test\|live)_*` |
| `VGE_API_KEY_OUTPUT` | Password input | No | — | If empty, uses INPUT key |
| Test Connection | Button | — | — | POST /health before save |

**UI:**

```
┌──────────────────────────────────────────────┐
│  API KEYS CONFIGURATION                      │
│                                              │
│  VGE API URL *                               │
│  ┌──────────────────────────────────────┐   │
│  │ https://api.vigilguard_____________│   │
│  └──────────────────────────────────────┘   │
│                                              │
│  Input API Key (for prompts) *               │
│  ┌──────────────────────────────────────┐   │
│  │ vg_test_**************************│   │
│  └──────────────────────────────────────┘   │
│  Format: vg_(test|live)_[a-zA-Z0-9_-]{32}   │
│                                              │
│  Output API Key (for tool responses)         │
│  ┌──────────────────────────────────────┐   │
│  │ ___________________________________│   │
│  └──────────────────────────────────────┘   │
│  ℹ️  Leave empty to use Input key for both  │
│                                              │
│  ┌─────────┬──────────┬───────────┐         │
│  │[Test]   │[Save]    │[Cancel]   │         │
│  └─────────┴──────────┴───────────┘         │
│                                              │
│  Tab: next field | Shift+Tab: prev | ESC    │
└──────────────────────────────────────────────┘
```

**Validation:**
- `VGE_API_KEY_INPUT` required, format `vg_(test|live)_[a-zA-Z0-9_-]{32}`
- `VGE_API_URL` must be valid HTTPS URL
- Test Connection: `curl -s https://api.vigilguard/health`

**Test Connection Response:**
```
✓ Connected to VGE (version 1.6.3)
  Authenticated as: vg_test_***
  Available endpoints: /v1/guard/input, /v1/guard/output
```

Or error:
```
✗ Connection failed
  Error: 401 Unauthorized
  Check your API key in VGE Web UI → API Keys
```

### 2.3 Tools Policy Screen (NEW — Dynamic Tool Configuration)

**Scan available tools** in the repo and allow user to configure each one.

Sources for tool discovery:
- Built-in Claude Code tools (Read, Write, Bash, Edit, Glob, Grep, Agent, etc.)
- Custom MCP tools (from `.mcp.json` or `.claude/.mcp.json`)
- Installed plugins/skills (from `~/.claude/agents/`, `~/.claude/skills/`)

```
┌──────────────────────────────────────────────────────┐
│  TOOLS POLICY CONFIGURATION                          │
│                                                      │
│  Detected tools in this repo: 12                     │
│  Scanning: ~/.mcp.json, .claude/.mcp.json, ...       │
│                                                      │
│  Configure each tool action:                         │
│  [block] [allow] [ask]                               │
│                                                      │
│  ▶ HIGH-RISK TOOLS (6)                               │
│    ├─ [block]  Bash (command execution)              │
│    ├─ [block]  Write (file creation)                 │
│    ├─ [block]  Edit (file modification)              │
│    ├─ [block]  Agent (spawn agents)                  │
│    ├─ [ask  ]  Task (background tasks)               │
│    └─ [block]  Python (code execution)               │
│                                                      │
│  ▼ MEDIUM-RISK TOOLS (3)                             │
│    ├─ [allow]  Read (file reading)                   │
│    ├─ [allow]  Glob (file search)                    │
│    └─ [allow]  Grep (code search)                    │
│                                                      │
│  ▼ LOW-RISK TOOLS (2)                                │
│    ├─ [allow]  WebFetch (HTTP get)                   │
│    └─ [allow]  WebSearch (search)                    │
│                                                      │
│  ▼ CUSTOM TOOLS (1)                                  │
│    └─ [ask  ]  my-custom-mcp (unknown risk)          │
│                                                      │
│  ┌────────────┬──────────┬───────────┐               │
│  │[Save]      │[Reset]   │[Cancel]   │               │
│  └────────────┴──────────┴───────────┘               │
│                                                      │
│  Navigation: ↑↓ select | [space] toggle | ESC quit   │
└──────────────────────────────────────────────────────┘
```

**Tool Actions:**
- `[block]` — Tool does NOT execute; user sees "Tool blocked"
- `[allow]` — Tool executes immediately (no check)
- `[ask]` — Show popup: user decides [Allow] [Block] [Report]

### 2.4 Block Handling Policy Screen (for VGE decisions)

**Decision:** When VGE returns BLOCK decision, how to enforce:

```
┌──────────────────────────────────────────────┐
│  VGE DECISION HANDLING                       │
│                                              │
│  When VGE detects prompt injection:          │
│                                              │
│  ○ Auto-block (recommended)                  │
│    Immediately block tool execution          │
│    User sees: "Tool blocked: injection"      │
│    No prompt, no wait time                   │
│                                              │
│  ○ Human-in-the-loop                         │
│    Ask user for manual decision              │
│    Popup appears in Claude Code              │
│    User can: [Allow] [Block] [Report]        │
│    Timeout: ┌──┐ seconds (5-60)              │
│             │30│                             │
│             └──┘                             │
│    On timeout: Block (fail-safe)             │
│                                              │
│  ┌──────────┬──────────┬───────────┐         │
│  │[Save]    │[Cancel]  │[Help]     │         │
│  └──────────┴──────────┴───────────┘         │
│                                              │
│  Arrow keys: select | Number: set timeout    │
└──────────────────────────────────────────────┘
```

**Options:**

| Option | Behavior | Use Case |
|--------|----------|----------|
| **Auto-block** | Immediately block tool, no prompt | Production (enforce security) |
| **Human-in-the-loop** | Show popup, user decides | Development (reduce false positives) |

**Default:** Auto-block (security-first)

### 2.4 View Current Config

Read-only view of `~/.vge-cc-guard/config.json`:

```
┌──────────────────────────────────────────────┐
│  CURRENT CONFIGURATION                       │
│                                              │
│  VGE API URL:                                │
│    https://api.vigilguard                    │
│                                              │
│  Input API Key:                              │
│    vg_test_OMHLNHkxlyXamLM9p9ODUemA6JCc    │
│                                              │
│  Output API Key:                             │
│    (same as input)                           │
│                                              │
│  Block Handling:                             │
│    auto-block                                │
│                                              │
│  Session Timeout (human-in-the-loop):        │
│    N/A (auto-block enabled)                  │
│                                              │
│  Config file:                                │
│    ~/.vge-cc-guard/config.json                  │
│                                              │
│  Last modified:                              │
│    2026-04-20 20:15:33                       │
│                                              │
│              [Edit]  [Export]  [Back]        │
└──────────────────────────────────────────────┘
```

---

## 3. Data Model

### 3.1 config.json

Stored in `~/.vge-cc-guard/config.json` (readable by vge-cc-guard daemon):

```json
{
  "version": "1.0.0",
  "vge": {
    "api_url": "https://api.vigilguard",
    "api_key_input": "vg_test_OMHLNHkxlyXamLM9p9ODUemA6JCcgi3u",
    "api_key_output": null,
    "verified_at": "2026-04-20T20:15:33Z"
  },
  "tools": {
    "Bash": "block",
    "Write": "block",
    "Edit": "block",
    "Agent": "block",
    "Task": "ask",
    "Read": "allow",
    "Glob": "allow",
    "Grep": "allow",
    "WebFetch": "allow",
    "WebSearch": "allow",
    "my-custom-mcp": "ask"
  },
  "policy": {
    "vge_block_handling": "auto-block",
    "human_timeout_seconds": 30,
    "unknown_tool_default": "ask"
  },
  "advanced": {
    "log_level": "info",
    "log_file": "/tmp/vge-cc-guard.log"
  }
}
```

**Notes:**
- `tools.<tool_name>`: one of `"block"`, `"allow"`, `"ask"`
  - `"block"`: Tool does NOT execute; blocked message shown
  - `"allow"`: Tool executes immediately (no check)
  - `"ask"`: Show popup to user for manual decision (with timeout)
- `unknown_tool_default`: What to do with newly discovered custom tools (default: `"ask"`)
- `vge_block_handling`: When VGE returns BLOCK decision (separate from tool-level policies)
- `api_key_output`: if null, daemon uses `api_key_input` for both input and output
- `verified_at`: timestamp of last successful VGE connection test
- All keys stored plaintext (file permission 0600)

### 3.2 Runtime Config Resolution

```
Priority (highest first):
1. ~/.vge-cc-guard/config.json (user persisted config)
2. Environment variables (VGE_API_KEY, VGE_API_URL)
3. Hardcoded defaults (URL only)

Example:
  If config.json has api_key_input but env has VGE_API_KEY:
    → Use env VGE_API_KEY (env wins)
```

---

## 4. User Flows

### Flow 1: First-time setup

```
User runs: vge-cc-guard config

1. Main Menu appears
2. Select "API Keys Configuration"
3. Enter VGE_API_URL (or keep default)
4. Enter Input API Key (required)
5. Leave Output API Key empty (uses input)
6. Click [Test Connection]
   → ✓ Connected to VGE (version 1.6.3)
7. Click [Save]
8. Select "Block Handling Policy"
9. Choose "Auto-block" (recommended)
10. Click [Save]
11. ✓ Configuration Saved screen appears
12. User runs: vge-cc-guard daemon
    → Sidecar starts, ready for Claude Code
```

### Flow 2: Separate input/output keys (production)

```
User runs: vge-cc-guard config

1. Main Menu
2. API Keys Configuration
3. Input API Key: vg_test_... (dev VGE)
4. Output API Key: vg_live_... (prod VGE for tool responses)
5. Test Connection
   → Tests with input key
   → Note: Output key tested separately by daemon at runtime
6. Save
7. Block Handling: Human-in-the-loop with 20s timeout
8. Save
9. ✓ Saved

→ Daemon now:
  - POSTs user prompts to dev VGE (input key)
  - POSTs tool outputs to prod VGE (output key)
  - Waits 20s for user decision on BLOCK
```

### Flow 3: Human-in-the-loop decision popup

```
Claude Code running, user submits prompt.

1. Sidecar analyzes via L1 + VGE
2. Decision: BLOCK (suspicious prompt)
3. If human-in-the-loop enabled:

   ┌────────────────────────────────────┐
   │  🚨 Prompt Blocked                 │
   │                                    │
   │  VGE detected prompt injection.    │
   │  Threat score: 78/100              │
   │                                    │
   │  Tool: Bash                        │
   │  Risk level: High                  │
   │                                    │
   │  ┌──────────────────────────────┐  │
   │  │ Your prompt: "curl | bash"   │  │
   │  └──────────────────────────────┘  │
   │                                    │
   │  What do you want to do?           │
   │                                    │
   │  [Allow] [Block] [Report to VGE]   │
   │                                    │
   │  ⏱️  Decision timeout: 30s          │
   │  ⏳  Waiting for decision...         │
   └────────────────────────────────────┘

4. User clicks [Block] or timeout expires
   → Tool does NOT execute
   → Decision logged to VGE audit

5. User clicks [Allow]
   → Tool executes despite BLOCK signal
   → Logged as "user_override"
   → Next prompt in tainted session
```

---

## 5. Implementation Notes

### 5.1 TUI Library

**Recommended: Ink + React patterns** (Node.js)

```typescript
import React from 'react';
import { render, Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';

export function ConfigMenu() {
  const [screen, setScreen] = React.useState('main');
  
  if (screen === 'api-keys') {
    return <ApiKeysScreen onSave={() => setScreen('main')} />;
  }
  
  return <MainMenu onSelect={(s) => setScreen(s)} />;
}
```

**Alternative: Blessed** (lower-level, more control)

```typescript
import blessed from 'blessed';

const screen = blessed.screen({ mouse: true, title: 'vge-cc-guard config' });
const form = blessed.form({ parent: screen, /* ... */ });
form.addButton({ text: 'Save', ... });
```

**Preference:** Ink (modern, React-like, easier to reason about)

### 5.2 Tool Discovery & Scanning

**How configurator finds available tools:**

1. **Built-in Claude Code tools** (hardcoded list)
   ```typescript
   const builtInTools = [
     { name: 'Bash', risk: 'high', description: 'command execution' },
     { name: 'Read', risk: 'low', description: 'file reading' },
     { name: 'Write', risk: 'high', description: 'file creation' },
     { name: 'Edit', risk: 'high', description: 'file modification' },
     { name: 'Glob', risk: 'low', description: 'file search' },
     { name: 'Grep', risk: 'low', description: 'code search' },
     { name: 'Agent', risk: 'high', description: 'spawn agents' },
     { name: 'Task', risk: 'medium', description: 'background tasks' },
     { name: 'WebFetch', risk: 'low', description: 'HTTP get' },
     { name: 'WebSearch', risk: 'low', description: 'search' },
     // ... more tools
   ];
   ```

2. **Scan for custom MCP tools** (in order of precedence)
   ```
   1. project/.claude/.mcp.json
   2. project/.mcp.json
   3. ~/.claude/.mcp.json (user-level)
   4. ~/.mcp.json
   ```
   
   Parse JSON:
   ```json
   {
     "mcpServers": {
       "my-custom-tool": {
         "command": "node",
         "args": ["server.js"],
         "description": "Custom analysis tool"
       }
     }
   }
   ```
   
   Extract tool names + risk assessment (default: "unknown" → "ask")

3. **Scan for installed plugins/skills** (in `~/.claude/agents/`, `~/.claude/skills/`)
   ```
   ~/.claude/agents/my-agent.ts → tool name: "my-agent"
   ~/.claude/skills/my-skill.ts → tool name: "my-skill"
   ```

**Risk categorization:**
- `high`: Bash, Write, Edit, Agent, Task, Python, etc.
- `medium`: Read (with restrictions), Glob, Agent spawning
- `low`: WebFetch, WebSearch, Query tools
- `unknown`: Custom MCP tools (default to "ask")

### 5.3 File Storage

- **Location:** `~/.vge-cc-guard/config.json`
- **Permissions:** `0600` (readable/writable by user only)
- **Format:** JSON (human-readable, portable)
- **Backup:** Auto-backup to `~/.vge-cc-guard/config.json.bak` on save

### 5.3 Validation Rules

| Field | Rule | Example |
|-------|------|---------|
| `api_url` | Must be valid HTTPS URL | ✓ `https://api.vigilguard` |
| `api_key_input` | Format `vg_(test\|live)_[a-zA-Z0-9_-]{32}` | ✓ `vg_test_OMHLNHkxlyXamLM9p9ODUemA6JCcgi3u` |
| `api_key_output` | Same format or empty | ✓ `vg_live_...` or `` |
| `block_handling` | Enum: `auto-block`, `human-in-the-loop` | ✓ `auto-block` |
| `human_timeout_seconds` | Integer 5-60 | ✓ `30` |

### 5.4 Error Handling

```
If API key format invalid:
  "❌ Invalid API key format"
  "Expected: vg_(test|live)_[a-zA-Z0-9_-]{32}"
  "Got: vg_test_SHORT"
  
If connection fails:
  "❌ Connection failed"
  "VGE API unreachable: https://api.vigilguard"
  "Check: 1) URL is correct, 2) Network connectivity, 3) API key valid"
  
If config file corrupted:
  "❌ Config file corrupted"
  "Path: ~/.vge-cc-guard/config.json"
  "Restore backup? [Yes/No]"
```

---

## 6. Future Enhancements (Phase 2+)

- [ ] Tool-specific policies (allow/block per tool)
- [ ] Rate limiting (max requests per minute)
- [ ] Session timeout policy
- [ ] Local L1 pattern customization
- [ ] Notification webhooks (Slack, email on BLOCK)
- [ ] Multi-profile support (dev/prod configs)
- [ ] Config export/import for team sharing
- [ ] Web UI alternative (Phase 3)

---

## 7. Testing Strategy

### Unit Tests
```typescript
describe('ConfigValidator', () => {
  it('rejects invalid API key format', () => {
    expect(validateApiKey('invalid')).toThrow();
  });
  
  it('accepts valid test key', () => {
    expect(validateApiKey('vg_test_' + 'x'.repeat(32))).toPass();
  });
});
```

### Integration Tests
```typescript
describe('Config E2E', () => {
  it('saves and loads config.json correctly', async () => {
    const config = { api_url: '...', block_handling: 'auto-block' };
    await saveConfig(config);
    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });
});
```

### Manual Test Checklist
- [ ] First-time setup (no config exists)
- [ ] Edit existing config
- [ ] Test Connection succeeds
- [ ] Test Connection fails (invalid key)
- [ ] Separate input/output keys
- [ ] Block handling policy transitions
- [ ] Config file persists after exit
- [ ] Config loads on daemon startup
