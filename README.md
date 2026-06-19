# Colonist Card Tracker

A browser overlay that tracks every player's likely resource cards while you play
Catan on [colonist.io](https://colonist.io). It reads the public game log and
maintains a live, per-player count of each resource — including the uncertainty
introduced by robber steals, which it resolves automatically as the game unfolds.

![status](https://img.shields.io/badge/status-beta-yellow) ![license](https://img.shields.io/badge/license-proprietary-red)

## What it does

Strong Catan players already track opponents' hands in their heads: every dice
roll, build, trade, and robbery is public information. This tool automates that
bookkeeping. It does **not** use any hidden information — it only watches the same
game log every player can see, and deduces what each hand must contain.

The interesting part is the **robber**. When someone steals a card from another
player, the log shows that a card moved but not which one. The tracker records the
set of possibilities and **resolves it retroactively**: when a later action proves
a card couldn't have been the stolen one, that possibility is eliminated, often
collapsing the steal to a certainty several turns later. Uncertain amounts display
as a range (e.g. `0–1`) until they resolve.

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
   (Chrome, Edge, Firefox, Safari).
2. Open the Tampermonkey dashboard → **Create a new script**.
3. Delete the template and paste the contents of
   [`colonist-tracker.user.js`](./colonist-tracker.user.js). Save with `Ctrl+S`.
4. Open a game on colonist.io. A **CARD TRACKER** panel appears top-right once the
   game log starts producing lines.

## Using it

- The panel shows one row per player, color-matched to their in-game color, with a
  count per resource and a running total (Σ).
- **White** numbers are known exactly. **Amber** numbers are ranges still uncertain
  from an unresolved steal. **Dimmed** numbers are zero.
- The panel is draggable (grab the header), collapsible (`–`), and resettable (`⟳`).
- `⚙` toggles **debug logging** — open the browser console (F12) to watch each
  parsed event and the resulting hands. Useful for spotting any log format the
  parser doesn't yet handle.

### Important: start from the beginning

The tracker is only accurate if it sees the game **from the opening placements**.
If you load it mid-game it can't know existing hands, and counts will be wrong. Use
`⟳` to reset if it ever drifts out of sync.

### "You"

When you steal or are robbed, colonist's log says "you," so the local player appears
in the panel as **You**. That's expected.

## How it works

Three layers, each independently testable:

1. **Parser** (`src/parser.js`) — turns one colonist log line (a DOM node) into a
   structured event like `{ type: "build", player, item: "city" }`. colonist renders
   resources as icons, so the parser reads image `alt` text, not sentences.
2. **Engine** (`src/engine.js`) — applies events to a model where each player's hand
   is a `[min, max]` range per resource. Deterministic events move both bounds;
   steals widen them and are narrowed by the retroactive resolver.
3. **Userscript** (`colonist-tracker.user.js`) — a self-contained Tampermonkey
   bundle of the above plus a `MutationObserver` on the game log and the overlay UI.
   (The `src/` modules are the same logic in testable form; the userscript inlines
   them so it can run without a build step.)

The log uses a **virtual scroller** that recycles DOM nodes as it grows, so the
observer de-duplicates by each line's stable `data-index`.

## Development

```bash
npm install            # installs node-html-parser (for parser tests)
node src/test.js       # engine logic tests
node src/parser.test.js  # parser tests against a real captured log fixture
```

See [DEVELOPMENT.md](./DEVELOPMENT.md) for how to add support for a new log format
(the capture-and-map workflow used to build this).

## Supported events

Confirmed against real colonist.io logs: dice-roll gains, starting resources, free
opening placements, paid builds (road/settlement/city), dev-card purchase, bank
trades, player-to-player trades, robber moves, steals (all three variants: you as
thief, you as victim, and hidden opponent-on-opponent), Year of Plenty, Monopoly,
Knight, and discards.

**Not yet handled:** Road Building (the dev card that grants two free roads). Its
roads may currently be charged as if paid. See DEVELOPMENT.md for how to add it.

## Caveats

- colonist.io may change its log markup at any time; if tracking breaks, the parser
  selectors likely need updating (turn on `⚙` debug to see what's failing).
- Check colonist.io's Terms of Service regarding userscripts before using this in
  ranked play. This is provided for learning and casual use.

## Authors

Sebastian Tovar (s3bxs@outlook.com),
Jay Weil (weiljt@mail.uc.edu)

## License

Proprietary — all rights reserved. See [LICENSE](./LICENSE). This code is shared for viewing only; it may not be reused, redistributed, or sold without written permission.
