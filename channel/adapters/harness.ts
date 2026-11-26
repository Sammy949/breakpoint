// Test harness: runs a hook script against a stub relay and records what it
// sends and prints. Used to prove the Claude Code adapter changed nothing.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type Run = { stdout: string; code: number | null; posted: unknown[] }

/** Strips the random request id so runs can be compared. */
const scrub = (b: any) => (b && typeof b === 'object' && 'id' in b ? { ...b, id: '<id>' } : b)

export async function runHook(
  script: string,
  stdin: string,
  poll: Record<string, unknown> | null,
  args: string[] = [],
): Promise<Run> {
  const posted: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'POST') {
        posted.push(scrub(await req.json()))
        return Response.json({ ok: true })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/requests/')) return Response.json(poll ?? { status: 'unknown' })
      return Response.json({ ok: true })
    },
  })
  const dir = mkdtempSync(join(tmpdir(), 'bp-hook-'))
  const config = join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ relay: `http://localhost:${server.port}`, token: 't' }))
  const proc = Bun.spawn([process.execPath, script, ...args], {
    stdin: new TextEncoder().encode(stdin),
    stdout: 'pipe',
    env: { ...process.env, BREAKPOINT_CONFIG: config, BREAKPOINT_WAIT_MS: '5000', BREAKPOINT_DEBUG_DIR: '' },
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  server.stop(true)
  return { stdout, code, posted }
}
