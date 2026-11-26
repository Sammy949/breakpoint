#!/usr/bin/env bash
# Breakpoint demo driver. Sets up a throwaway project and triggers each kind of
# request on demand, with Claude Code (real) or without it (cards only, free).
#
#   scripts/demo.sh pair              Pair this laptop with the relay (prints a 6-digit code)
#   scripts/demo.sh sim <code>        Start the glasses app in the Even Hub simulator, paired with <code>
#   scripts/demo.sh telegram          Print the link that connects your Telegram
#   scripts/demo.sh project           (Re)create the demo project and add Breakpoint's hooks
#   scripts/demo.sh claude <scene>    Start Claude Code in tmux with a prompt that triggers <scene>
#   scripts/demo.sh cards <scene>     Post the same requests without Claude, and print the answers
#
# Scenes:
#   batch       three local edits at once (T1, batched behind a long press)
#   install     npm install left-pad (T2, outside effect)
#   force-push  git push --force origin main (T3, destructive; deny with a reply to redirect Claude)
#   delete      rm -rf build (T3, destructive)
#   plan        a plan from plan mode (approve or send feedback)
#
# The project's "origin" is a bare repo next to it, so the force push never
# leaves the machine. Relay URL: from your pairing, else $BREAKPOINT_RELAY,
# else VITE_BREAKPOINT_RELAY in glasses/.env.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO_DIR="${BREAKPOINT_DEMO_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/breakpoint-demo}"
PROJECT="$DEMO_DIR/api"
TMUX_SESSION="bp-demo"

die() { echo "demo: $*" >&2; exit 1; }

relay_url() {
  local url
  url="$(cd "$REPO" && bun -e 'import { loadConfig } from "./channel/config"; console.log(loadConfig()?.relay ?? "")')"
  [ -n "$url" ] || url="${BREAKPOINT_RELAY:-}"
  [ -n "$url" ] || url="$(grep -s '^VITE_BREAKPOINT_RELAY=' "$REPO/glasses/.env" | cut -d= -f2-)"
  [ -n "$url" ] || die "no relay URL. Deploy one (README) and set BREAKPOINT_RELAY, or pair first."
  echo "${url%/}"
}

make_project() {
  rm -rf "$DEMO_DIR"
  mkdir -p "$PROJECT/src" "$PROJECT/build" "$PROJECT/test"
  cd "$PROJECT"
  cat > package.json <<'EOF'
{
  "name": "api",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test" }
}
EOF
  cat > src/greet.js <<'EOF'
export function greet(name) {
  return `Hello, ${name}!`
}
EOF
  cat > src/time.js <<'EOF'
export function isoNow() {
  return new Date().toISOString()
}
EOF
  cat > src/math.js <<'EOF'
export function add(a, b) {
  return a + b
}
EOF
  cat > test/greet.test.js <<'EOF'
import { test } from 'node:test'
import assert from 'node:assert'
import { greet } from '../src/greet.js'

test('greets by name', () => assert.equal(greet('Ada'), 'Hello, Ada!'))
EOF
  echo "compiled output" > build/bundle.js
  printf 'node_modules/\n' > .gitignore
  git init -q -b main
  git add -A
  git -c user.name=Demo -c user.email=demo@example.invalid commit -qm "Initial commit"
  git init -q --bare "$DEMO_DIR/origin.git"
  git remote add origin "$DEMO_DIR/origin.git"
  git push -q origin main
  # Rewrite the last commit so main has diverged and only a force push will do.
  git -c user.name=Demo -c user.email=demo@example.invalid commit -q --amend -m "Initial commit, tidied"
  bun "$REPO/scripts/setup.ts" "$PROJECT" --ask
  echo
  echo "Demo project ready: $PROJECT"
}

prompt_for() {
  case "$1" in
    install) echo 'Run exactly this command and nothing else: npm install left-pad' ;;
    force-push) echo 'I tidied main locally. Run exactly this command and nothing else: git push --force origin main' ;;
    delete) echo 'Delete the build folder. Run exactly this command and nothing else: rm -rf build' ;;
    plan) echo 'Plan adding a --shout option to src/greet.js that upper-cases the greeting, with a test. Keep the plan short.' ;;
    batch-1) echo 'Add a one-line comment at the top of src/greet.js saying what the file does. Change nothing else.' ;;
    batch-2) echo 'Add a one-line comment at the top of src/time.js saying what the file does. Change nothing else.' ;;
    batch-3) echo 'Add a one-line comment at the top of src/math.js saying what the file does. Change nothing else.' ;;
    *) die "unknown scene: $1 (batch, install, force-push, delete, plan)" ;;
  esac
}

claude_window() { # name, permission mode, prompt
  local name="$1" mode="$2" prompt="$3"
  local cmd="cd '$PROJECT' && claude --permission-mode $mode -n '$name' $(printf '%q' "$prompt")"
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux new-window -t "$TMUX_SESSION" -n "$name" "$cmd"
  else
    tmux new-session -d -s "$TMUX_SESSION" -n "$name" -x 200 -y 50 "$cmd"
  fi
}

case "${1:-}" in
  pair)
    bun "$REPO/scripts/pair.ts" "$(relay_url)"
    ;;
  sim)
    code="${2:-}"
    [[ "$code" =~ ^[0-9]{6}$ ]] || die "usage: demo.sh sim <6-digit code from 'demo.sh pair'>"
    relay="$(relay_url)"
    mkdir -p "$DEMO_DIR"
    (cd "$REPO/glasses" && nohup bun run dev > "$DEMO_DIR/glasses-dev.log" 2>&1 &)
    sleep 3
    echo "Glasses app on http://localhost:5180 (log: $DEMO_DIR/glasses-dev.log)."
    # The simulator is noisy under WSL (no GPU driver, no sound card), all harmless.
    echo "Simulator running (log: $DEMO_DIR/simulator.log). Ctrl-C stops it."
    exec evenhub-simulator "http://localhost:5180/?relay=$relay&code=$code" --automation-port 9898 \
      > "$DEMO_DIR/simulator.log" 2>&1
    ;;
  telegram)
    bun "$REPO/scripts/telegram.ts" link
    ;;
  project)
    make_project
    ;;
  claude)
    scene="${2:-}"
    [ -d "$PROJECT/.git" ] || die "run 'demo.sh project' first"
    command -v tmux >/dev/null || die "tmux is needed to run Claude Code sessions side by side"
    case "$scene" in
      batch)
        for i in 1 2 3; do claude_window "edit-$i" manual "$(prompt_for "batch-$i")"; done ;;
      plan)
        claude_window plan plan "$(prompt_for plan)" ;;
      *)
        claude_window "$scene" manual "$(prompt_for "$scene")" ;;
    esac
    echo "Claude Code is running in tmux. Watch it with: tmux attach -t $TMUX_SESSION"
    echo "The first run in a new folder asks whether you trust it: answer that in tmux."
    ;;
  cards)
    scene="${2:-}"
    session=api
    case "$scene" in
      batch)
        for c in "npm test" "npm run test -- --watch=false" "npm test -- test/greet.test.js"; do
          bun "$REPO/scripts/test-card.ts" "$c" "$session" --wait &
          sleep 0.3
        done
        wait ;;
      install) bun "$REPO/scripts/test-card.ts" "npm install left-pad" "$session" --wait ;;
      force-push) bun "$REPO/scripts/test-card.ts" "git push --force origin main" "$session" --wait ;;
      delete) bun "$REPO/scripts/test-card.ts" "rm -rf build" "$session" --wait ;;
      plan) die "plan cards need Claude: use 'demo.sh claude plan'" ;;
      *) die "unknown scene: $scene (batch, install, force-push, delete)" ;;
    esac
    ;;
  *)
    sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
