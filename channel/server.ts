#!/usr/bin/env bun
// Breakpoint channel: an MCP server that Claude Code spawns over stdio.
// It receives permission prompts from Claude Code and sends verdicts back.
// Adapted from the "Full webhook.ts with permission relay" example in the
// Claude Code channels reference (code.claude.com/docs/en/channels-reference).
//
// stdout is the MCP transport. Never write anything else to it.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const SESSION = basename(process.cwd())
const LOG_FILE = process.env.BREAKPOINT_LOG ?? '/tmp/breakpoint-channel.log'
const DEBUG_PORT = Number(process.env.BREAKPOINT_DEBUG_PORT ?? 8788)
// Local debug endpoint is loopback-only and still needs this token, because
// anyone who can post a verdict can approve tool use.
const DEBUG_TOKEN = process.env.BREAKPOINT_DEBUG_TOKEN ?? randomBytes(12).toString('hex')

function log(...parts: unknown[]) {
  const line = `${new Date().toISOString()} [${SESSION}] ${parts
    .map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ')}\n`
  process.stderr.write(line)
  try {
    appendFileSync(LOG_FILE, line)
  } catch {}
}

export type PermissionRequest = {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
  received_at: number
  session: string
}

// Only IDs Claude Code sent us are answerable. Claude Code also enforces this.
const open = new Map<string, PermissionRequest>()

const mcp = new Server(
  { name: 'breakpoint', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      'Breakpoint relays tool permission prompts to the user on their Even G2 glasses. ' +
      'It does not send chat messages. If a tool call is denied, choose a safer approach or ask the user.',
  },
)

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const req: PermissionRequest = { ...params, received_at: Date.now(), session: SESSION }
  open.set(params.request_id, req)
  log('permission_request', req)
})

export async function sendVerdict(request_id: string, behavior: 'allow' | 'deny') {
  const id = request_id.toLowerCase()
  if (!open.has(id)) {
    log('verdict rejected: unknown id', id)
    return false
  }
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: id, behavior },
  })
  open.delete(id)
  log('verdict sent', { request_id: id, behavior })
  return true
}

await mcp.connect(new StdioServerTransport())
log('channel connected', { pid: process.pid, cwd: process.cwd() })

// --- Local debug endpoint (kill-point test; the relay replaces it) ----------
// GET  /pending           -> open requests as JSON
// POST /verdict "yes abcde" | "no abcde"
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

function serve(port: number) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1',
    async fetch(req) {
      if (req.headers.get('x-breakpoint-token') !== DEBUG_TOKEN) {
        return new Response('forbidden', { status: 403 })
      }
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/pending') {
        return Response.json([...open.values()])
      }
      if (req.method === 'POST' && url.pathname === '/verdict') {
        const m = VERDICT_RE.exec(await req.text())
        if (!m) return new Response('expected "yes <id>" or "no <id>"', { status: 400 })
        const ok = await sendVerdict(m[2], m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny')
        return ok ? new Response('verdict sent\n') : new Response('unknown id\n', { status: 404 })
      }
      return new Response('not found', { status: 404 })
    },
  })
}

let http
try {
  http = serve(DEBUG_PORT)
} catch {
  // Several Claude sessions each spawn their own channel; fall back to a free port.
  http = serve(0)
}
log('debug endpoint', { url: `http://127.0.0.1:${http.port}`, token: DEBUG_TOKEN })
