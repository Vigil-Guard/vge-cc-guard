#!/usr/bin/env bash
# PRD_0 user-prompt logger for Claude Code.
# Advisory-only: always exits 0, never blocks the session.

set -u
umask 077

# log_file is set after .env is loaded (below), but log() is used inside load_env_file
# paths — default to fallback until .env is in.
log_file="/tmp/vge-prompt-logger.log"

log() {
  [ "$log_file" = "/dev/null" ] && return 0
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$log_file" 2>/dev/null || true
}

# Safe .env parser — no `source`, no shell interpolation.
load_env_file() {
  local f="$1"
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    line="${line#export }"
    [[ "$line" == *=* ]] || continue
    local key="${line%%=*}"
    local val="${line#*=}"
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    # Shell env wins if already set.
    [ -z "${!key:-}" ] && export "$key=$val"
  done <"$f"
}

# Project scope first (CC sets CLAUDE_PROJECT_DIR), then user scope.
[ -n "${CLAUDE_PROJECT_DIR:-}" ] && load_env_file "$CLAUDE_PROJECT_DIR/.claude/.env"
load_env_file "$HOME/.claude/.env"

# Re-resolve log file now that .env has had a chance to set it.
log_file="${VGE_LOG_FILE:-/tmp/vge-prompt-logger.log}"

api_url="${VGE_API_URL:-https://api.vigilguard}"
api_key="${VGE_API_KEY:-}"
timeout="${VGE_TIMEOUT_SECONDS:-5}"
[ "$timeout" -gt 10 ] 2>/dev/null && timeout=10
wire="${VGE_WIRE_FORMAT:-auto}"
dry="${VGE_DRY_RUN:-0}"

if [ -z "$api_key" ]; then
  log "WARN VGE_API_KEY missing, fail-open exit 0"
  exit 0
fi

command -v jq >/dev/null 2>&1 || { log "WARN jq missing, fail-open exit 0"; exit 0; }
command -v curl >/dev/null 2>&1 || { log "WARN curl missing, fail-open exit 0"; exit 0; }

raw_input="$(cat || true)"
[ -z "$raw_input" ] && { log "WARN empty stdin, exit 0"; exit 0; }

session_id="$(printf '%s' "$raw_input" | jq -r '.session_id // ""' 2>/dev/null || echo "")"
prompt_id="$(printf '%s' "$raw_input" | jq -r '.prompt_id // ""' 2>/dev/null || echo "")"
hook_event="$(printf '%s' "$raw_input" | jq -r '.hook_event_name // "UserPromptSubmit"' 2>/dev/null || echo "UserPromptSubmit")"
prompt_text="$(printf '%s' "$raw_input" | jq -r '.prompt // ""' 2>/dev/null || echo "")"
transcript_path="$(printf '%s' "$raw_input" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")"

[ -z "$prompt_id" ] && prompt_id="pid_$(uuidgen 2>/dev/null || date +%s%N)"
idem="idem_${prompt_id}"

# Truncate to 99 000 bytes (VGE MAX_PROMPT_LENGTH = 100 000).
truncated=false
byte_len="$(printf '%s' "$prompt_text" | wc -c | tr -d ' ')"
if [ "$byte_len" -gt 99000 ]; then
  prompt_text="$(printf '%s' "$prompt_text" | head -c 99000)"
  truncated=true
fi

# Last 10 user/assistant messages from the CC transcript, trimmed to 48 KB.
build_conversation() {
  [ -z "$transcript_path" ] || [ ! -r "$transcript_path" ] && { echo "[]"; return; }
  tail -n 60 "$transcript_path" 2>/dev/null \
    | jq -c -s '
        [.[] | select(.type == "user" or .type == "assistant")
             | {role: .type,
                content: (.message.content
                          | if type == "array"
                              then (map(select(.type == "text") | .text) | join("\n"))
                            elif type == "string" then .
                            else tostring end)}]
        | .[-10:]
        | . as $msgs
        | (reduce range(0; length) as $i ({n:0, bytes:0};
            if .bytes + ($msgs[length-1-$i] | tostring | length) > 48000
              then .
              else {n: .n+1, bytes: .bytes + ($msgs[length-1-$i] | tostring | length)}
            end)) as $fit
        | $msgs[length-$fit.n:]
      ' 2>/dev/null || echo "[]"
}

conversation_json="$(build_conversation)"
[ -z "$conversation_json" ] && conversation_json="[]"

# Tool context — populated for PreToolUse / PostToolUse events.
tool_json="$(printf '%s' "$raw_input" | jq -c '
  if (.tool_name // "") == "" then null
  else
    {name: .tool_name,
     id: (.tool_use_id // ""),
     vendor: "anthropic"}
    + (if .tool_input  != null then {args: .tool_input} else {} end)
    + (if .tool_response != null then
        {result: {content: (.tool_response | if type == "string" then . else tostring end),
                  isError: ((.tool_response_error // false) | if type == "boolean" then . else false end)}}
       else {} end)
  end
' 2>/dev/null || echo "null")"
[ -z "$tool_json" ] && tool_json="null"

# Extract last user message from conversation for original_prompt context.
extract_last_user_message() {
  printf '%s' "$conversation_json" | jq -r '
    map(select(.role == "user"))
    | last
    | .content // ""
  ' 2>/dev/null || echo ""
}

# Route per hook event.
# Phase 0+: UserPromptSubmit (detection) + PostToolUse (output analysis).
# Deferred: PreToolUse, Stop, SessionStart/End, etc. (pending audit pipeline redesign).
case "$hook_event" in
  UserPromptSubmit)
    endpoint="/v1/guard/input"
    source_field='"user_input"'
    analyze=false
    ;;
  PostToolUse)
    # Tool response analysis: send output to /v1/guard/output with original prompt context.
    endpoint="/v1/guard/output"
    source_field='"tool_output"'
    analyze=false
    original_prompt="$(extract_last_user_message)"
    ;;
  *)
    log "INFO skipped event=$hook_event (deferred to phase 1)"
    exit 0
    ;;
esac

build_payload() {
  local mode="$1"
  local endpoint="$2"
  local original_prompt="$3"

  if [ "$endpoint" = "/v1/guard/output" ]; then
    # /v1/guard/output format: output (tool response) + original_prompt (context)
    jq -n \
      --arg output "$prompt_text" \
      --arg orig_prompt "$original_prompt" \
      --arg sid "$session_id" \
      --arg pid "$prompt_id" \
      --arg ev "$hook_event" \
      --argjson tool "$tool_json" \
      --arg mode "$mode" '
      {output: $output}
      + (if ($orig_prompt | length) > 0 then {original_prompt: $orig_prompt} else {} end)
      + (if $mode == "typed" or $mode == "auto"
         then {agent: {framework: "claude-code", sessionId: $sid, promptId: $pid, hookEvent: $ev}}
         else {} end)
      + (if $tool != null then {tool: $tool} else {} end)
      + {metadata: {platform: "claude-code", session_id: $sid, prompt_id: $pid, hookEvent: $ev}
                   + (if $tool != null and $tool.name != null then {tool_name: $tool.name} else {} end)}
    '
  else
    # /v1/guard/input format: prompt + agent/tool/conversation context
    jq -n \
      --arg prompt "$prompt_text" \
      --arg sid "$session_id" \
      --arg pid "$prompt_id" \
      --arg ev "$hook_event" \
      --argjson trunc "$truncated" \
      --argjson conv "$conversation_json" \
      --argjson tool "$tool_json" \
      --argjson analyze "$analyze" \
      --arg src_raw "$source_field" \
      --arg mode "$mode" '
      (if $analyze
         then {text: (if ($prompt | length) > 0 then $prompt else "[claude-code audit] event=\($ev) tool=\($tool.name // "none")" end),
               source: ($src_raw | fromjson)}
         else {prompt: $prompt} end)
      + (if $mode == "typed" or $mode == "auto"
         then {agent: {framework: "claude-code", sessionId: $sid, promptId: $pid, hookEvent: $ev}}
         else {} end)
      + (if $tool != null then {tool: $tool} else {} end)
      + (if ($conv | length) > 0 then {conversation: $conv} else {} end)
      + (if $mode == "legacy" or $mode == "auto"
         then {metadata: ({platform: "claude-code", session_id: $sid, prompt_id: $pid, hookEvent: $ev}
                + (if $trunc then {vge_prompt_truncated: true} else {} end))}
         else (if $trunc then {metadata: {vge_prompt_truncated: true}} else {} end) end)
    '
  fi
}

post() {
  local body="$1"
  curl -sS -o /dev/null -w '%{http_code}' \
    --max-time "$timeout" \
    -X POST "$api_url$endpoint" \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -H "X-Idempotency-Key: $idem" \
    --data-binary "$body" 2>/dev/null || echo "000"
}

payload="$(build_payload "$wire" "$endpoint" "${original_prompt:-}")"

if [ "$dry" = "1" ]; then
  redacted="$(printf '%s' "$payload" | jq -c '.')"
  log "DRY_RUN url=$api_url key=vg_*** event=$hook_event session=$session_id bytes=$(printf '%s' "$payload" | wc -c | tr -d ' ')"
  log "DRY_RUN payload=$redacted"
  exit 0
fi

status="$(post "$payload")"

if [ "$status" = "400" ] && [ "$wire" = "auto" ]; then
  payload="$(build_payload "legacy" "$endpoint" "${original_prompt:-}")"
  status="$(post "$payload")"
  log "INFO retry_legacy status=$status event=$hook_event session=$session_id"
else
  log "INFO status=$status event=$hook_event session=$session_id"
fi

exit 0
