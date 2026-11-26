# Feature requests

Gaps we hit while building Breakpoint, in the order they'd help most.

## 1. Even Hub SDK: a way to surface an urgent card when the app isn't open

A plugin only runs while it's open on the phone. A destructive command waiting for approval is invisible unless the wearer happens to have Breakpoint in front of them. A high-priority notification that a plugin can raise from the background, even a single line that opens the app, would close the biggest gap in the product.

## 2. Even Hub SDK: an "urgent" display primitive

The SDK exposes no haptic or audio output and no animation. A system-level way to mark a card as urgent, such as a border pulse or a brief brightness change, would let apps signal "read this now" without inventing their own conventions.

## 3. Claude Code hooks: let a `PermissionRequest` allow approve a plan

A hook that returns `{"behavior": "allow"}` for `ExitPlanMode` leaves the plan dialog open, and so does an allow that adds a `setMode` permission update. The dialog only closes when the hook echoes the plan back unchanged as `updatedInput`. Tested on v2.1.332. This is a known gap rather than a one-off: [#90498](https://github.com/anthropics/claude-code/issues/90498) reports the same behaviour (closed as a duplicate, then as stale), [#57799](https://github.com/anthropics/claude-code/issues/57799) notes that the hooks reference documents no `tool_input` schema for `ExitPlanMode`, and [Plannotator](https://github.com/backnotprop/plannotator) echoes the plan as `updatedInput` for the same reason. A plain allow should be enough, or the docs should say echoing the input is required.

## 4. Claude Code channels: permission relay without an org-wide switch

We built the channel version first. On a Team account, `--dangerously-load-development-channels` is blocked unless an admin sets `channelsEnabled` for the whole organisation, and the flag can't get around it. A way for a team to allow one trusted permission-relay channel, without turning on channels for everyone or using a development flag, would make channels usable for tools like this one.

## 5. Claude Code: put plans first in remote approval

Anthropic reports that people reject 39% of plans but only 3% of individual permission requests. Plans are where human judgement actually changes outcomes, so remote-approval surfaces (channels, hooks, mobile) should treat plan approval as a first-class event with structured fields (title, steps), rather than a tool call that carries raw markdown.
