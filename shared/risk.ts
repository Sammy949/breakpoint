// Deterministic risk tiers for Claude Code tool calls. No model involved.
//
// T3 destructive or irreversible -> interrupt now, multi-step confirm
// T2 effects outside the project  -> wait for a break, tap
// T1 local and reversible         -> batch, long press
// Anything unrecognised is T2.
//
// Pure: no Node or DOM APIs, so it runs in the hook, the relay or the glasses.

export type Tier = 1 | 2 | 3

export type Risk = {
  tier: Tier
  /** Short label for the card's first line. */
  label: 'DESTRUCTIVE' | 'OUTSIDE PROJECT' | 'NETWORK' | 'INSTALL' | 'LOCAL' | 'UNKNOWN'
  /** Plain-English consequence, one line. */
  reason: string
  /** The thing the user should check: branch, path, host or package. */
  token?: string
}

export type ToolCall = { tool: string; input: Record<string, unknown>; cwd?: string }

const t3 = (reason: string, token?: string): Risk => ({ tier: 3, label: 'DESTRUCTIVE', reason, token })
const t2 = (label: Risk['label'], reason: string, token?: string): Risk => ({ tier: 2, label, reason, token })
const t1 = (reason: string, token?: string): Risk => ({ tier: 1, label: 'LOCAL', reason, token })
const UNKNOWN: Risk = { tier: 2, label: 'UNKNOWN', reason: 'Not a command Breakpoint recognises.' }

function worst(risks: Risk[]): Risk {
  return risks.reduce((a, b) => (b.tier > a.tier ? b : a), risks[0] ?? UNKNOWN)
}

// --- Paths -------------------------------------------------------------------

const SENSITIVE_FILE =
  /(^|\/)(\.env(\.[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials(\.json)?|[^/]*\.(pem|key|p12|pfx|keystore))$/i
const SENSITIVE_DIR = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker)(\/|$)/

const TEMPLATE_FILE = /\.(example|sample|template|dist)$/i

export function isSensitivePath(p: string) {
  if (TEMPLATE_FILE.test(p)) return false // .env.example is meant to be committed
  return SENSITIVE_FILE.test(p) || SENSITIVE_DIR.test(p)
}

function normalise(parts: string[]) {
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** True if `path` resolves inside `cwd`. Relative paths are taken from cwd. */
export function isInside(path: string, cwd?: string) {
  if (!cwd) return !path.startsWith('/') && !path.startsWith('~') && !path.split('/').includes('..')
  if (path.startsWith('~')) return false
  const abs = normalise((path.startsWith('/') ? path : `${cwd}/${path}`).split('/'))
  const root = normalise(cwd.split('/'))
  return abs === root || abs.startsWith(root === '/' ? '/' : root + '/')
}

function baseName(p: string) {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

// --- File tools ----------------------------------------------------------------

function classifyWrite(tool: string, path: string, cwd?: string): Risk {
  if (!path) return UNKNOWN
  const verb = tool === 'Write' ? 'Writes' : 'Edits'
  if (isSensitivePath(path)) return t3(`${verb} a secrets or key file.`, baseName(path))
  if (!isInside(path, cwd)) return t2('OUTSIDE PROJECT', `${verb} a file outside the project.`, path)
  return t1(`${verb} ${baseName(path)} in the project.`, baseName(path))
}

// --- Shell -------------------------------------------------------------------------

/** Split a command line into words, honouring quotes and backslashes. */
export function words(cmd: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      started = true
    } else if (c === '\\' && i + 1 < cmd.length) {
      cur += cmd[++i]
      started = true
    } else if (/\s/.test(c)) {
      if (started || cur) out.push(cur)
      cur = ''
      started = false
    } else {
      cur += c
      started = true
    }
  }
  if (started || cur) out.push(cur)
  return out
}

/** Split on ; && || | and newlines outside quotes. Pipes are kept as segment boundaries too. */
export function segments(cmd: string): { text: string; pipedFrom?: string }[] {
  const out: { text: string; pipedFrom?: string }[] = []
  let cur = ''
  let quote: string | null = null
  let pipedFrom: string | undefined
  const push = (nextPiped?: string) => {
    if (cur.trim()) out.push({ text: cur.trim(), pipedFrom })
    pipedFrom = nextPiped
    cur = ''
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === ';' || c === '\n') push()
    else if (c === '&' && cmd[i + 1] === '&') {
      push()
      i++
    } else if (c === '|' && cmd[i + 1] === '|') {
      push()
      i++
    } else if (c === '|') push(cur.trim())
    else cur += c
  }
  push()
  return out
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const INTERPRETERS = new Set([...SHELLS, 'python', 'python3', 'node', 'perl', 'ruby', 'bun', 'deno'])

/** Drop sudo, env assignments and wrappers so the real program is first. */
function strip(w: string[]): { argv: string[]; sudo: boolean } {
  let sudo = false
  let i = 0
  while (i < w.length) {
    const x = w[i]
    if (x === 'sudo' || x === 'doas') {
      sudo = true
      i++
      while (i < w.length && w[i].startsWith('-')) i++
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)) i++
    else if (x === 'env' || x === 'command' || x === 'exec' || x === 'nohup' || x === 'time') i++
    else if (x === 'npx' || x === 'bunx' || x === 'pnpx') i++
    else if ((x === 'pnpm' || x === 'yarn') && w[i + 1] === 'dlx') i += 2
    else break
  }
  return { argv: w.slice(i), sudo }
}

const has = (argv: string[], ...flags: string[]) => argv.some(a => flags.includes(a))
const hasShort = (argv: string[], letter: string) =>
  argv.some(a => /^-[A-Za-z]+$/.test(a) && a.includes(letter))
const positional = (argv: string[]) => argv.slice(1).filter(a => !a.startsWith('-'))

function hostOf(argv: string[]) {
  for (const a of argv.slice(1)) {
    const m = a.match(/^(?:https?|ftp|wss?):\/\/([^/:?#]+)/i)
    if (m) return m[1]
  }
  for (const a of argv.slice(1)) {
    const m = a.match(/^(?:[^@\s]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]+):/)
    if (m && !a.startsWith('-')) return m[1]
  }
  return undefined
}

function classifyGit(argv: string[]): Risk {
  const sub = argv[1]
  const rest = argv.slice(2)
  const args = rest.filter(a => !a.startsWith('-'))
  switch (sub) {
    case 'push': {
      const remote = args[0] ?? 'origin'
      const refspec = args[args.length - 1]
      const branch = args.length > 1 ? refspec.replace(/^\+/, '').split(':').pop() : undefined
      const forced =
        has(rest, '--force', '--force-with-lease', '--force-if-includes', '--mirror') ||
        rest.some(a => a.startsWith('--force-with-lease=')) ||
        hasShort(rest, 'f') ||
        args.slice(1).some(a => a.startsWith('+'))
      if (forced) return t3(`Rewrites history on ${branch ?? 'the remote'}.`, branch ?? remote)
      if (has(rest, '--delete', '-d') || args.slice(1).some(a => a.startsWith(':')))
        return t3(`Deletes a branch on ${remote}.`, (branch ?? args[1] ?? remote).replace(/^:/, ''))
      return t2('NETWORK', `Pushes ${branch ?? 'commits'} to ${remote}.`, branch ?? remote)
    }
    case 'reset':
      if (has(rest, '--hard', '--merge', '--keep'))
        return t3('Throws away uncommitted changes.', args[0] ?? 'HEAD')
      return t1('Moves the branch pointer, keeps your changes.')
    case 'clean':
      if (hasShort(rest, 'f') || has(rest, '--force')) return t3('Deletes untracked files for good.', 'untracked files')
      return t1('Lists untracked files.')
    case 'checkout':
    case 'restore':
      if (args.includes('.') || args.includes('--') || has(rest, '--worktree', '-W') || has(rest, '--force'))
        return t3('Discards uncommitted changes.', args.filter(a => a !== '--')[0] ?? '.')
      return t1(`Switches to ${args[0] ?? 'another branch'}.`, args[0])
    case 'branch':
      if (has(rest, '-D') || (has(rest, '-d', '--delete') && has(rest, '--force', '-f')))
        return t3(`Deletes branch ${args[0] ?? ''} even if unmerged.`.replace('  ', ' '), args[0])
      return t1('Manages local branches.', args[0])
    case 'stash':
      if (args[0] === 'drop' || args[0] === 'clear') return t3('Deletes stashed changes.', args[0])
      return t1('Stashes local changes.')
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
      return sub === 'rebase' ? t1('Rewrites local commits.') : t3('Rewrites the whole history.', sub)
    case 'pull':
    case 'fetch':
    case 'clone':
    case 'ls-remote':
    case 'submodule':
      return t2('NETWORK', `Talks to a remote (git ${sub}).`, args[0])
    default:
      return t1(`Runs git ${sub ?? ''}.`.trim(), sub)
  }
}

const PUBLISH: Record<string, string[]> = {
  npm: ['publish', 'unpublish', 'deprecate'],
  pnpm: ['publish'],
  yarn: ['publish', 'npm'],
  bun: ['publish'],
  cargo: ['publish', 'yank'],
  gem: ['push', 'yank'],
  twine: ['upload'],
  poetry: ['publish'],
  flit: ['publish'],
  dotnet: ['nuget'],
}

const INSTALL: Record<string, string[]> = {
  npm: ['install', 'i', 'add', 'ci', 'update', 'upgrade', 'uninstall', 'remove', 'rm'],
  pnpm: ['install', 'i', 'add', 'update', 'up', 'remove', 'rm'],
  yarn: ['install', 'add', 'upgrade', 'remove'],
  bun: ['install', 'i', 'add', 'update', 'remove', 'rm'],
  pip: ['install', 'uninstall'],
  pip3: ['install', 'uninstall'],
  uv: ['add', 'pip', 'sync', 'remove'],
  poetry: ['add', 'install', 'update', 'remove'],
  cargo: ['add', 'install', 'update'],
  go: ['get', 'install'],
  gem: ['install'],
  brew: ['install', 'upgrade', 'uninstall'],
  apt: ['install', 'remove', 'purge', 'upgrade'],
  'apt-get': ['install', 'remove', 'purge', 'upgrade'],
  dnf: ['install', 'remove'],
  yum: ['install', 'remove'],
  pacman: ['-S', '-R', '-Syu'],
  composer: ['require', 'install', 'update'],
}

function classifyDeploy(argv: string[]): Risk | null {
  const [cmd, sub] = argv
  const target = (name: string) => t3(`Deploys with ${name}.`, has(argv, '--prod', '--production') ? 'production' : name)
  if (cmd === 'vercel' && (has(argv, '--prod', '--production') || sub === 'deploy' || sub === undefined)) return target('vercel')
  if (cmd === 'netlify' && sub === 'deploy') return target('netlify')
  if ((cmd === 'wrangler' && (sub === 'deploy' || sub === 'publish')) || (cmd === 'wrangler' && sub === 'secret'))
    return target('wrangler')
  if (cmd === 'fly' || cmd === 'flyctl') return sub === 'deploy' || sub === 'destroy' ? target('fly') : null
  if (cmd === 'firebase' && sub === 'deploy') return target('firebase')
  if (cmd === 'railway' && (sub === 'up' || sub === 'deploy')) return target('railway')
  if (cmd === 'heroku' && sub !== undefined && /^(apps:destroy|releases:rollback|pg:reset)$/.test(sub)) return target('heroku')
  if (cmd === 'terraform' && (sub === 'apply' || sub === 'destroy')) return t3(`Runs terraform ${sub}.`, sub)
  if (cmd === 'pulumi' && (sub === 'up' || sub === 'destroy')) return t3(`Runs pulumi ${sub}.`, sub)
  if (cmd === 'kubectl' && sub && /^(apply|delete|replace|scale|rollout|drain|patch)$/.test(sub))
    return t3(`Changes the cluster (kubectl ${sub}).`, sub)
  if (cmd === 'helm' && sub && /^(install|upgrade|uninstall|delete|rollback)$/.test(sub)) return t3(`Runs helm ${sub}.`, sub)
  if (cmd === 'gh' && sub === 'release' && argv[2] === 'create') return t3('Publishes a GitHub release.', argv[3])
  if (cmd === 'gh' && sub === 'repo' && (argv[2] === 'delete' || argv[2] === 'archive')) return t3(`Runs gh repo ${argv[2]}.`, argv[3])
  if (cmd === 'docker' && sub === 'push') return t3('Pushes an image to a registry.', argv[2])
  return null
}

const SQL_DESTRUCTIVE = /\b(drop\s+(table|database|schema|index|view|user)|truncate(\s+table)?\s+\w|delete\s+from\s+\w+\s*(;|$|"|'))/i

function classifyArgv(argv: string[], pipedFrom?: string, cwd?: string, depth = 0): Risk {
  const [cmd] = argv
  if (!cmd) return t1('Does nothing.')
  const prog = baseName(cmd)

  // Something piped into a shell or interpreter: running code you haven't read.
  if (pipedFrom && INTERPRETERS.has(prog)) {
    const src = strip(words(pipedFrom)).argv
    const host = hostOf(src)
    if (/^(curl|wget|fetch|http|iwr)$/.test(baseName(src[0] ?? '')))
      return t3(`Runs a script downloaded from ${host ?? 'the internet'}.`, host)
    return t3(`Pipes into ${prog} to run as code.`, prog)
  }

  // bash -c "…", sh -c "…", eval "…": classify what's inside.
  if ((SHELLS.has(prog) && argv[1] === '-c' && argv[2]) || (prog === 'eval' && argv[1])) {
    const inner = prog === 'eval' ? argv.slice(1).join(' ') : argv[2]
    return depth < 3 ? classifyShell(inner, cwd, depth + 1) : UNKNOWN
  }

  if (prog === 'git') return classifyGit(argv)

  // Publishing and deploying.
  const pub = PUBLISH[prog]
  if (pub && argv[1] && pub.includes(argv[1])) {
    const name = positional(argv).slice(1)[0]
    return t3(`Publishes a package (${prog} ${argv[1]}).`, name ?? prog)
  }
  const deploy = classifyDeploy([prog, ...argv.slice(1)])
  if (deploy) return deploy

  switch (prog) {
    case 'rm':
    case 'rmdir':
    case 'shred':
    case 'unlink': {
      const targets = positional(argv)
      const recursive =
        has(argv, '--recursive', '-r', '-R') || hasShort(argv.slice(1), 'r') || hasShort(argv.slice(1), 'R')
      const wild = targets.some(t => /[*?]/.test(t) || t === '/' || t === '~' || t.startsWith('/') || t === '..')
      const outside = targets.some(t => !isInside(t, cwd))
      const token = targets[0]
      if (recursive) return t3(`Deletes ${token ?? 'files'} and everything under it.`, token)
      if (prog === 'shred') return t3(`Destroys ${token ?? 'a file'} beyond recovery.`, token)
      if (wild || outside) return t3(`Deletes ${token ?? 'files'}, outside the project or by pattern.`, token)
      return t2('OUTSIDE PROJECT', `Deletes ${token ?? 'a file'}. Not undoable from Claude.`, token)
    }
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      const target = positional(argv).slice(1)[0]
      if (argv.some(a => /^0?777$|^a\+rwx$|^o\+w/.test(a)) || hasShort(argv.slice(1), 'R') || has(argv, '--recursive'))
        return t3(`Opens up permissions on ${target ?? 'files'}.`, target)
      return isInside(target ?? '', cwd) ? t1(`Changes permissions on ${target}.`, target) : t2('OUTSIDE PROJECT', `Changes permissions on ${target}.`, target)
    }
    case 'dd':
      if (argv.some(a => a.startsWith('of=/dev/'))) return t3('Writes raw data to a disk.', argv.find(a => a.startsWith('of='))?.slice(3))
      return t2('OUTSIDE PROJECT', 'Copies raw data.')
    case 'mkfs':
    case 'fdisk':
    case 'parted':
    case 'wipefs':
      return t3('Changes a disk or partition.', argv[argv.length - 1])
    case 'shutdown':
    case 'reboot':
    case 'halt':
    case 'poweroff':
      return t3('Shuts down or restarts the machine.', prog)
    case 'kill':
    case 'pkill':
    case 'killall':
      return t2('OUTSIDE PROJECT', 'Stops running processes.', positional(argv)[0])
    case 'psql':
    case 'mysql':
    case 'sqlite3':
    case 'mongosh':
    case 'redis-cli': {
      // SQL can arrive as an argument or piped in: `echo "DROP TABLE x" | psql`.
      const text = `${argv.join(' ')} ${pipedFrom ?? ''}`
      if (SQL_DESTRUCTIVE.test(text) || /\bflushall\b|\bflushdb\b|dropDatabase/i.test(text))
        return t3('Deletes data from a database.', text.match(SQL_DESTRUCTIVE)?.[0]?.split(/\s+/).pop()?.replace(/[;"']/g, ''))
      return t2('OUTSIDE PROJECT', `Runs ${prog} against a database.`)
    }
    case 'curl':
    case 'wget':
    case 'http':
    case 'https':
    case 'xh': {
      const host = hostOf(argv)
      const upload =
        has(argv, '-T', '--upload-file') ||
        argv.some((a, i) => (a.startsWith('@') || (/^-(d|F)$|^--data(-binary|-raw)?$|^--form$/.test(argv[i - 1] ?? '') && /(^|=)@/.test(a)))) ||
        argv.some(a => /^--data(-binary)?=@/.test(a))
      if (upload) return t3(`Uploads a local file to ${host ?? 'a server'}.`, host)
      return t2('NETWORK', `Makes a request to ${host ?? 'the network'}.`, host)
    }
    case 'scp':
    case 'rsync':
    case 'sftp': {
      const dest = argv[argv.length - 1] ?? ''
      const host = dest.match(/^(?:[^@]+@)?([^:/]+):/)?.[1]
      if (host) return t3(`Copies local files to ${host}.`, host)
      return t2('NETWORK', `Copies files with ${prog}.`, hostOf(argv))
    }
    case 'ssh':
    case 'nc':
    case 'ncat':
    case 'telnet':
    case 'ftp':
      return t2('NETWORK', `Opens a connection to ${hostOf(argv) ?? positional(argv)[0] ?? 'a remote host'}.`, positional(argv)[0])
    case 'docker':
    case 'podman':
      if (argv[1] === 'system' && argv[2] === 'prune') return t3('Deletes unused containers, images and volumes.', 'prune')
      if (argv[1] === 'volume' && (argv[2] === 'rm' || argv[2] === 'prune')) return t3('Deletes container volumes.', argv[3])
      return t2('OUTSIDE PROJECT', `Runs ${prog} ${argv[1] ?? ''}.`.trim(), argv[1])
    case 'gh':
      if (argv[1] === 'gist' && argv[2] === 'create') return t3('Uploads files to a GitHub gist.', positional(argv).slice(2)[0])
      return t2('NETWORK', `Calls GitHub (gh ${argv[1] ?? ''}).`.trim(), argv[1])
    case 'mv':
    case 'cp':
    case 'ln':
    case 'mkdir':
    case 'touch':
    case 'tee': {
      const targets = positional(argv)
      const bad = targets.find(t => isSensitivePath(t))
      if (bad && prog !== 'mkdir') return t3(`Changes a secrets or key file.`, baseName(bad))
      const out = targets.find(t => !isInside(t, cwd))
      if (out) return t2('OUTSIDE PROJECT', `Changes files outside the project.`, out)
      return t1(`Runs ${prog} inside the project.`, targets[targets.length - 1])
    }
  }

  // Package installs (after publish, which shares program names).
  const inst = INSTALL[prog]
  if (inst && argv[1] && inst.includes(argv[1])) {
    const pkg = positional(argv).slice(1)[0]
    return t2('INSTALL', pkg ? `Installs ${pkg} from the network.` : 'Installs packages from the network.', pkg ?? prog)
  }

  // Tests, builds and read-only tools.
  if (LOCAL_PROGRAMS.has(prog)) return t1(`Runs ${prog} locally.`, prog)
  if (/^(npm|pnpm|yarn|bun)$/.test(prog) && /^(test|t|run|run-script|exec|build|lint|dev|start|x)$/.test(argv[1] ?? ''))
    return t1(`Runs ${prog} ${argv[1]}${argv[2] ? ' ' + argv[2] : ''}.`, argv[2] ?? argv[1])
  if (prog === 'cargo' && /^(test|build|check|clippy|fmt|run)$/.test(argv[1] ?? '')) return t1(`Runs cargo ${argv[1]}.`)
  if (prog === 'go' && /^(test|build|vet|fmt|run)$/.test(argv[1] ?? '')) return t1(`Runs go ${argv[1]}.`)
  if ((prog === 'python' || prog === 'python3') && argv[1] === '-m' && /^(pytest|unittest|mypy)$/.test(argv[2] ?? ''))
    return t1(`Runs ${argv[2]}.`)

  return UNKNOWN
}

const LOCAL_PROGRAMS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'grep', 'rg', 'find', 'fd', 'wc', 'sort', 'uniq', 'diff', 'echo', 'printf',
  'pwd', 'which', 'file', 'stat', 'tree', 'du', 'df', 'date', 'jq', 'sed', 'awk', 'cut', 'tr', 'true', 'false',
  'test', 'tsc', 'eslint', 'prettier', 'biome', 'vitest', 'jest', 'pytest', 'mocha', 'ruff', 'black', 'mypy',
  'make', 'cmake', 'vite', 'next', 'cd', 'export',
])

/** Redirections like `> .env` or `>> /etc/hosts` count as writes. */
function redirectRisk(text: string, cwd?: string): Risk | null {
  const re = /(?:^|[^<>&\d])(?:\d?>>?|&>)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/g
  let worstRisk: Risk | null = null
  for (const m of text.matchAll(re)) {
    const target = m[1].replace(/^["']|["']$/g, '')
    if (target === '/dev/null' || target.startsWith('&') || /^\/dev\/(stdout|stderr|tty)$/.test(target)) continue
    const r = classifyWrite('Write', target, cwd)
    if (!worstRisk || r.tier > worstRisk.tier) worstRisk = r
  }
  return worstRisk
}

export function classifyShell(command: string, cwd?: string, depth = 0): Risk {
  const risks: Risk[] = []
  for (const seg of segments(command)) {
    const { argv, sudo } = strip(words(seg.text))
    // Ignore the redirect operator and its target when reading the command itself.
    const clean = argv.filter((a, i) => !/^\d?>>?$|^&>$/.test(a) && !/^\d?>>?$|^&>$/.test(argv[i - 1] ?? ''))
    let r = classifyArgv(clean, seg.pipedFrom, cwd, depth)
    const redirect = redirectRisk(seg.text, cwd)
    if (redirect && redirect.tier > r.tier) r = redirect
    if (sudo && r.tier < 2) r = { ...r, tier: 2, label: 'OUTSIDE PROJECT', reason: `Runs as root: ${r.reason}` }
    risks.push(r)
  }
  return worst(risks)
}

export function classify(call: ToolCall): Risk {
  const { tool, input, cwd } = call
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  switch (tool) {
    case 'Bash':
    case 'Monitor':
      return classifyShell(str('command'), cwd)
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return classifyWrite(tool, str('file_path'), cwd)
    case 'NotebookEdit':
      return classifyWrite('Edit', str('notebook_path'), cwd)
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
      return isSensitivePath(str('file_path') || str('path'))
        ? t2('OUTSIDE PROJECT', 'Reads a secrets or key file.', baseName(str('file_path') || str('path')))
        : t1('Reads files.')
    case 'WebFetch': {
      const host = str('url').match(/^\w+:\/\/([^/:?#]+)/)?.[1]
      return t2('NETWORK', `Fetches ${host ?? 'a web page'}.`, host)
    }
    case 'WebSearch':
      return t2('NETWORK', 'Searches the web.')
    default:
      return tool.startsWith('mcp__')
        ? t2('OUTSIDE PROJECT', `Calls the ${tool.split('__')[1] ?? 'MCP'} tool server.`, tool.split('__')[2])
        : UNKNOWN
  }
}
