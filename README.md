# Breakpoint

I leave Claude Code running while I step away, and I often come back to find it stopped on a permission prompt, waiting for me the whole time.

The other half worries me more. Anthropic reports that people approve about 97% of Claude Code's permission prompts. When everything gets a yes, the one prompt that deserved a no gets a yes too. And the prompts that still reach a person, now that auto mode handles the routine ones, are exactly the risky ones.

So I'm putting those prompts on my Even G2 glasses, and making the dangerous ones hard to approve without reading them.

**Claude Code asks for permission, the request shows up on your glasses, and you answer with a gesture.** Safe things wait until you're not busy. Destructive things interrupt you right away, and approving one takes a gesture you have to read off the card.

> Early days: this is being built during the Heads Up hackathon (Even Realities, 23 to 29 Nov 2026). The parts marked *working* below run today. Everything else is on the way, and this README changes as it lands.

## What it does

- **Answers Claude Code from your glasses.** *(working)* Claude Code runs Breakpoint's hook whenever it's about to ask you something. The terminal dialog stays open too, so whichever answer comes first wins and you can always answer at your desk.
- **Deny talks back.** *(working)* Saying no can come with a short redirect, like "Use a new branch instead", and Claude takes that route instead of stalling.
- **Sorts every request by risk.** *(planned)* Plain rules, not a model, decide the tier:

  | Tier | For example | When it shows | To approve |
  | --- | --- | --- | --- |
  | Destructive | `rm -r`, `git push --force`, `git reset --hard`, `curl … \| sh`, writing `.env` or keys, publish and deploy | Right away | A gesture sequence that changes every time |
  | Outside effects | `git push`, installing packages, network calls, writing outside the project | At your next break, within 60 s | Tap |
  | Local | Edits inside the project, running tests | Batched at your next break | Long press approves the batch |

  Saying no is always the same: swipe down.
- **Waits for a natural break.** *(planned)* If you're talking or walking, non-urgent cards wait. Voice activity is worked out on the phone from the glasses' microphone, and the audio never leaves the phone.
- **Telegram as a second surface.** *(planned)* If the glasses app isn't open, the request goes to your Telegram instead. Every destructive decision posts a receipt to a channel you pick.

## Try what works today

You need [Bun](https://bun.sh), Claude Code and the Even Hub simulator (`npm i -g @evenrealities/evenhub-simulator`).

```bash
git clone https://github.com/Sammy949/breakpoint
cd breakpoint && bun install
cd glasses && bun install
```

**The hook.** In any test project, add this to `.claude/settings.json`, with the real path to your clone:

```json
{
  "permissions": { "ask": ["Bash(touch:*)"] },
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "bun /path/to/breakpoint/channel/hook.ts", "timeout": 600 }
        ]
      }
    ]
  }
}
```

The `ask` rule makes sure a prompt appears even in auto mode. Ask Claude to run `touch test.txt`. The request lands in `/tmp/breakpoint/pending/<id>.json` while the terminal dialog waits. Answer it from another terminal:

```bash
echo allow > /tmp/breakpoint/verdict/<id>
printf 'deny\nCreate a different file instead.\n' > /tmp/breakpoint/verdict/<id>
```

The file hand-off is temporary. The relay to the glasses replaces it.

**The glasses.** In two terminals, from `glasses/`:

```bash
bun run dev
bun run simulate
```

The card is a placeholder for now. It echoes every gesture so you can see the inputs arrive.

## Privacy

- No account, no telemetry, no analytics.
- Today nothing leaves your machine: the hook and the simulator both run locally.
- When the relay lands, it passes messages between your laptop and your phone and stores nothing. Only the command and Claude's description of it leave the laptop.

## Why hooks and not channels

Claude Code has a research-preview feature called channels, which can also relay permission prompts. I built that first (`channel/server.ts`, adapted from the [channels reference](https://code.claude.com/docs/en/channels-reference)) and it works at the protocol level. But organisations have to switch channels on, and the development flag doesn't get around that, so anyone on a company account would hit a wall.

[Permission hooks](https://code.claude.com/docs/en/hooks) are a stable, documented part of Claude Code. They work on any account, see the full command instead of a shortened preview, and need one settings entry instead of a startup flag.

## Before building it

Three bits of research shaped the design. It's *informed by* them, not a replication.

- **Interrupt at breaks.** Iqbal and Bailey found that interruptions at natural breaks in a task cost about the same as no interruption at all, while interruptions mid-task slow people down and frustrate them. Hence the name.
- **Weigh the cost of waiting against the cost of interrupting.** Horvitz, Jacobs and Hovel's attention-sensitive alerting work at Microsoft Research inferred whether someone was busy from signals including nearby conversation. Breakpoint's scheduler is a much simpler, rule-based version of that idea.
- **Warnings that change resist habituation.** Anderson, Vance and colleagues at BYU showed attention to repeated warnings drops sharply, and that warnings which change their appearance hold attention for weeks. That's why the destructive-tier gesture changes every time.

## What existed before the hackathon

Everything here was written during the build window. The starting points from elsewhere:

- `glasses/` began as the official [Even Hub minimal template](https://github.com/even-realities/evenhub-templates). It's committed unmodified first, so the history shows exactly what changed.
- `channel/server.ts` is adapted from the permission-relay example in the Claude Code channels docs.

## Credits

Built on the [Even Hub SDK](https://hub.evenrealities.com/docs) and template, the [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk), [zod](https://github.com/colinhacks/zod), [Vite](https://github.com/vitejs/vite) and TypeScript.

Not affiliated with Anthropic or Even Realities.

## License

[MIT](LICENSE)
