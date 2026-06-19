# Development Notes

Internal notes for extending this project. The most common task is teaching the
parser a colonist.io log format it does not handle yet (e.g. Road Building). This
describes that workflow — the same one used to build the existing parser.

## The architecture in one minute

- `src/parser.js` recognizes a log line and emits an **event object**.
- `src/engine.js` applies events to the `[min, max]`-per-resource hand model.
- `colonist-tracker.user.js` is the shipped bundle — it **inlines** copies of both.

When you change parsing or engine logic, edit `src/` first (it's testable), then
copy the change into the matching section of the userscript. The userscript has
clearly labeled sections: `1) TYPES`, `2) STATE ENGINE`, `3) PARSER`, etc.

## Adding a new log format

### 1. Capture the real markup

You can't write the parser rule from a guess — colonist renders resources as icons,
and the exact wording and structure matter. In a live game, open dev tools (F12) →
Console, and run:

```js
copy([...document.querySelectorAll('.scrollItemContainer-WXX2rkzf')].map(n => n.outerHTML).join('\n'))
```

This copies every currently-visible log line's HTML to your clipboard. Because the
log is a **virtual scroller** (only visible lines exist in the DOM), do the action
you want to capture and run the command while that line is still on screen.

A faster way during testing: enable the tracker's debug mode (the `⚙` button), open
the console, and watch for `no-event` lines — those are log lines the parser saw but
didn't recognize. They tell you exactly what's unhandled.

### 2. Identify the pattern

Look at the captured HTML for:

- The **connecting text** that identifies the event (e.g. `built a`, `gave bank`,
  `stole … from`). This is what your regex matches.
- Whether **resources** appear as `<img class="lobbyChatTextIcon" alt="…">` and on
  which side of the connecting words.
- Whether **player names** appear as `<span style="…color:…">` (the leading span is
  usually the actor; a trailing span is often a trade partner or victim).
- Any **counts written as numbers** in text rather than repeated icons (Monopoly
  does this: "stole 7 lumber").

Watch for collisions: e.g. both Monopoly and the robber use the word "stole" — they
are distinguished by the presence of "from".

### 3. Write the parser branch

Add a branch in `parseLogLine` (in `src/parser.js`). Order matters — more specific
patterns must come before more general ones. Return an event object matching an
engine case, or `null` to skip the line. Resource amounts come from the helpers:
`allResources(node)`, or `readResourcesBetween` / `readResourcesAfter` when
resources sit on both sides of a connector.

**Free vs. paid is a recurring trap.** Opening placements ("placed a") cost nothing;
mid-game builds ("built a") cost resources. Road Building grants two *free* roads, so
its roads must **not** be charged — handle it as `place_free`, not `build`.

### 4. Handle it in the engine if needed

If the event needs new state logic, add a `case` in `applyEvent` (`src/engine.js`).
Most events reuse existing types (`build`, `roll_gain`, `steal`, etc.).

### 5. Test it

Add a fixture and assertion to `src/parser.test.js` (for parsing) and/or
`src/test.js` (for engine behavior), then:

```bash
node src/parser.test.js
node src/test.js
```

Use a real captured HTML snippet as the fixture, not a hand-written one — the real
markup has wrapper elements and quirks that hand-written samples miss.

### 6. Port to the userscript

Copy your `src/` changes into the matching section of `colonist-tracker.user.js`,
then sanity-check syntax:

```bash
node --check colonist-tracker.user.js
```

## Known open item

**Road Building** — capture the lines following a "used Road Building" play. Confirm
whether the two free roads are logged as ordinary "built a Road" lines (in which case
the parser must suppress charging for them) or with distinct wording. There's a
`// TODO: Road Building` marker in the parser.
