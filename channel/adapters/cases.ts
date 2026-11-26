// Claude Code hook inputs and relay answers covering every output branch.

const base = { session_id: 'sess-1', cwd: '/work/api', hook_event_name: 'PermissionRequest', permission_mode: 'default' }

export const permissionInputs: Record<string, object> = {
  bash: { ...base, tool_name: 'Bash', tool_input: { command: 'git push --force origin main', description: 'Force push' } },
  rm: { ...base, tool_name: 'Bash', tool_input: { command: 'rm -rf ./dist' } },
  write: { ...base, tool_name: 'Write', tool_input: { file_path: '/work/api/.env', content: 'X=1' } },
  fetch: { ...base, tool_name: 'WebFetch', tool_input: { url: 'https://example.com', prompt: 'read' } },
  mcp: { ...base, tool_name: 'mcp__db__query', tool_input: { sql: 'drop table users' } },
  plan: {
    ...base,
    tool_name: 'ExitPlanMode',
    tool_input: { plan: '# Add login\n\n1. Add the route\n2. Hash passwords\n3. Write tests\n4. Update docs\n5. Ship' },
  },
  bare: { session_id: 'sess-2', tool_name: 'Bash' },
}

export const polls: Record<string, Record<string, unknown>> = {
  allow: { status: 'decided', behavior: 'allow' },
  deny: { status: 'decided', behavior: 'deny' },
  redirect: { status: 'decided', behavior: 'deny', redirect: 'use a branch instead' },
  elsewhere: { status: 'elsewhere' },
  unknown: { status: 'unknown' },
}

export const activityInputs: Record<string, object> = {
  postToolUse: { session_id: 'sess-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} },
  denied: { session_id: 'sess-1', hook_event_name: 'PermissionDenied', tool_name: 'Write', tool_input: { file_path: '/a' } },
  stop: { session_id: 'sess-1', hook_event_name: 'Stop', stop_hook_active: false },
  noSession: { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
}
