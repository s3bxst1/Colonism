// ==UserScript==
// @name         Colonist Card Tracker
// @namespace    catan-tracker
// @version      0.2.0
// @description  Tracks opponents' likely resource cards on colonist.io from the public game log.
// @match        https://colonist.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * HOW THE FILE IS ORGANISED
 * -------------------------
 *   1. Constants        resource names, build costs, card images
 *   2. State engine     the estimate, and the rules for updating it
 *   3. Parser           turning a line of the game log into an event object
 *   4. Overlay          the panel that gets drawn on screen
 *   5. Observers        noticing when the log changes and feeding it in
 *
 * The important boundary is between 2 and 3. The parser deals with HTML: CSS
 * class names, image tags, English sentences. The engine only ever sees plain
 * JavaScript objects like { type: "build", player: "Alice", item: "road" } and
 * has no idea a webpage exists. Keeping them separate means the engine can be
 * tested on its own (see engine.test.js), and it keeps all the fragile
 * webpage-specific code in one place.
 */

(function () {
  "use strict";

  // =========================================================================
  // 0) CONFIG
  // =========================================================================

  // When debug mode is on, every parsed event and the resulting hands get
  // printed to the browser console. Useful when a number looks wrong and you
  // need to find which log line caused it. Turn it on from the console with
  // __catanDebug(true), or with the gear button on the panel.
  let DEBUG = false;
  window.__catanDebug = (on) => { DEBUG = !!on; console.log("[catan] debug", DEBUG ? "ON" : "OFF"); };

  // =========================================================================
  // 1) CONSTANTS
  // =========================================================================

  const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];

  // What each thing costs to build. This is the only place prices are written
  // down, so if a rule variant changed them there is one place to edit.
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    devcard: { sheep: 1, wheat: 1, ore: 1 },
  };

  // colonist uses the traditional Catan card names in its image tags, so this
  // translates them into the shorter names used everywhere else in the file.
  // Doing the translation once, at the point where data enters the program,
  // means nothing downstream has to know about both sets of names.
  const RESOURCE_MAP = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };

  const RESOURCE_GLYPH = { wood: "🌲", brick: "🧱", sheep: "🐑", wheat: "🌾", ore: "⛰️" };

  // The panel reuses colonist's own card images so it looks like part of the
  // site. Those filenames contain a content hash, which changes whenever the
  // site is redeployed, so each image also has an onerror handler that swaps in
  // the emoji above. Worst case the panel looks plainer; it never shows a row
  // of broken-image boxes.
  const RESOURCE_ICON = {
    wood:  "https://cdn.colonist.io/dist/assets/card_lumber.cf22f8083cf89c2a29e7.svg",
    brick: "https://cdn.colonist.io/dist/assets/card_brick.5950ea07a7ea01bc54a5.svg",
    sheep: "https://cdn.colonist.io/dist/assets/card_wool.17a6dea8d559949f0ccc.svg",
    wheat: "https://cdn.colonist.io/dist/assets/card_grain.09c9d82146a64bce69b5.svg",
    ore:   "https://cdn.colonist.io/dist/assets/card_ore.117f64dab28e1c987958.svg",
  };
  const DEV_ICON = "https://cdn.colonist.io/dist/assets/card_devcardback.92569a1abd04a8c1c17e.svg";

  const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

  // =========================================================================
  // 2) STATE ENGINE
  // =========================================================================
  /*
   * HOW THE ESTIMATE IS STORED
   *
   * Every player gets two hands instead of one:
   *
   *   min[r]  the smallest amount of resource r they could possibly have
   *   max[r]  the largest amount of resource r they could possibly have
   *
   * If min and max are equal we know the count exactly. If they differ, the
   * true number is somewhere in between and the panel shows a range.
   *
   * Ordinary events move both numbers together, because they are certain. If a
   * player collects two wheat from a dice roll, both min and max go up by two
   * and we are no less sure than we were before.
   *
   * A hidden steal is the only thing that pulls the two numbers apart, and it
   * does so in a lopsided way that is worth spelling out:
   *
   *   the victim's MINIMUM goes down   (they might be missing a card now)
   *   the thief's  MAXIMUM goes up     (they might have gained one)
   *   the victim's maximum stays put   (they might still have everything)
   *   the thief's  minimum stays put   (they are not guaranteed anything)
   *
   * So uncertainty only ever spreads outwards, and it is up to the rest of the
   * engine to pull the bounds back in as later moves rule possibilities out.
   *
   * A LIMITATION WORTH KNOWING ABOUT
   *
   * Each resource is tracked separately, which means the estimate cannot record
   * relationships between them. After a steal where the card was either wood or
   * brick, this representation allows both "the thief gained a wood" and "the
   * thief gained a brick" to be true at once — even though only one card
   * actually moved. The stored bounds are always wide enough to contain the
   * truth, so the panel never claims something false; they are just sometimes
   * wider than they strictly need to be.
   *
   * The alternative is to track every combination of possibilities separately,
   * which is exact but grows very quickly as steals pile up. Ranges cost five
   * numbers per player and constant time per update, and in practice most
   * steals get pinned down within a turn or two anyway.
   */

  function createState() {
    return {
      players: {},   // name -> { min, max, devCards, knights, freeRoads }
      steals: [],    // unresolved hidden steals, see recordSteal
      colors: {},    // name -> the colour colonist gave that player
      turn: null,    // whose turn it is, for the highlight
      truth: {},     // exact totals read off colonist's own player panel
      desync: false, // set if our estimate ever contradicts itself
    };
  }

  // Players are created the first time they are mentioned, so there is no need
  // to know the player list up front.
  function ensurePlayer(state, name) {
    if (!state.players[name]) {
      state.players[name] = {
        min: emptyHand(),
        max: emptyHand(),
        devCards: 0,   // development cards bought but not yet played
        knights: 0,    // knights played, which decides Largest Army
        freeRoads: 0,  // roads still owed from a Road Building card
      };
    }
    return state.players[name];
  }

  // A gain we are sure about, so both bounds move.
  function gain(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    p.min[res] += n;
    p.max[res] += n;
  }

  // A loss we are sure about, so both bounds move.
  //
  // The clamp at zero stops the counts going negative, but if it ever actually
  // does anything then our estimate has drifted away from the real game — a log
  // line was misread or missed. Rather than quietly carry on showing numbers
  // that are wrong, we set a flag that the panel displays, so the user knows to
  // hit reset instead of trusting it.
  function lose(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    if (p.max[res] < n) state.desync = true;
    p.min[res] = Math.max(0, p.min[res] - n);
    p.max[res] = Math.max(0, p.max[res] - n);
  }

  // Undo one step of the minimum that a steal took away, once we work out that
  // the steal could not have taken this resource. Capped at max so the minimum
  // can never end up above the maximum.
  function restoreFloor(p, res) {
    p.min[res] = Math.min(p.min[res] + 1, p.max[res]);
  }

  /*
   * A loss that also tells us something about the past.
   *
   * Spending a resource is proof that you had it. If a player's minimum for
   * that resource is lower than what they just spent, the only reason it is low
   * is that a steal took the number down — so the fact they could still afford
   * to spend it means the steal probably did not take this resource after all.
   *
   * Working out exactly how much that proves takes a little counting. Say there
   * are k unresolved steals against this player that list this resource as a
   * possibility, and x of them actually took it. Each of those steals dropped
   * the recorded minimum M by one, so the player's real holding is
   *
   *     actual = (M + k) - x
   *
   * Spending n requires actual >= n, and rearranging gives
   *
   *     x <= M + k - n   =   k - deficit,   where deficit = n - M
   *
   * When deficit is at least k this says x <= 0, so none of those steals took
   * the resource and every one of them can have it crossed off. When deficit is
   * smaller we only learn something about the steals as a group — "at most one
   * of these took wood" — and that is exactly the kind of relationship the
   * min/max representation cannot store. In that case we cross nothing off and
   * accept the wider estimate, because a wide estimate is fine and a wrong one
   * is not.
   *
   * In practice a player usually has at most one steal against them at a time,
   * where deficit >= 1 = k, and the crossing-off happens as you would expect.
   */
  function loseAndConstrain(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    const pending = state.steals.filter(
      (s) => !s.resolved && s.victim === name && s.candidates.includes(res)
    );
    const k = pending.length;
    const deficit = n - p.min[res];

    if (k > 0 && deficit >= k) {
      for (const steal of pending) {
        steal.candidates = steal.candidates.filter((c) => c !== res);
        const thief = state.players[steal.thief];
        if (thief) thief.max[res] = Math.max(0, thief.max[res] - 1); // they did not gain it
        restoreFloor(p, res);                                        // and we did not lose it
      }
      if (DEBUG) console.log("%c[catan] ruled out", "color:#c586c0", res, "for", k, "steal(s) against", name);
    }

    lose(state, name, res, n);
    resolveSteals(state);
  }

  // Pay for something. Every resource in the cost goes through the function
  // above, which means building is both a payment and a small piece of evidence
  // about what earlier steals could have been.
  function spend(state, name, cost) {
    for (const res of Object.keys(cost)) loseAndConstrain(state, name, res, cost[res]);
  }

  /*
   * Record a steal.
   *
   * Sometimes the log names the card — it does when you are the thief or the
   * victim, since you are allowed to know. In that case nothing is uncertain
   * and it is just a transfer.
   *
   * Otherwise we write down a list of every resource the victim could have had
   * and keep it around as an open question. The bounds widen as described at
   * the top of this section, and the list gets shorter as later events rule
   * possibilities out.
   */
  function recordSteal(state, thief, victim, knownResource) {
    const v = ensurePlayer(state, victim);
    ensurePlayer(state, thief);

    if (knownResource) {
      lose(state, victim, knownResource, 1);
      gain(state, thief, knownResource, 1);
      return;
    }

    // Only resources the victim could actually be holding are worth listing.
    const candidates = RESOURCES.filter((r) => v.max[r] > 0);
    if (!candidates.length) return; // as far as we know they had nothing to take

    state.steals.push({ thief, victim, candidates, resolved: false });
    for (const r of candidates) {
      state.players[thief].max[r] += 1;
      state.players[victim].min[r] = Math.max(0, state.players[victim].min[r] - 1);
    }
    resolveSteals(state);
  }

  /*
   * Try to close out open steals.
   *
   * Two rules, applied to every unresolved steal:
   *
   *   1. If the victim clearly has none of some resource, that resource can be
   *      crossed off the list of possibilities.
   *   2. If only one possibility is left, that must be what was taken, so the
   *      steal can be turned into an ordinary transfer.
   *
   * The whole thing sits in a loop because the rules feed each other. Closing
   * one steal turns a range into an exact number, which can show that a player
   * has none of something, which crosses that option off a different steal,
   * which might leave that one with a single option — and so on. Running the
   * rules once would leave some of that unfinished.
   *
   * The guard counter is just insurance against an infinite loop if some future
   * change made a rule oscillate.
   */
  function resolveSteals(state) {
    let changed = true;
    let guard = 0;

    while (changed && guard++ < 100) {
      changed = false;

      for (const steal of state.steals) {
        if (steal.resolved) continue;
        const v = state.players[steal.victim];
        const t = state.players[steal.thief];
        if (!v || !t) continue;

        // Rule 1: drop possibilities the victim demonstrably cannot have.
        const live = steal.candidates.filter((r) => v.max[r] > 0);
        if (live.length !== steal.candidates.length) {
          for (const r of steal.candidates) {
            if (live.includes(r)) continue;
            t.max[r] = Math.max(0, t.max[r] - 1);
            restoreFloor(v, r);
          }
          steal.candidates = live;
          changed = true;
        }

        // Rule 2: one possibility left means we know what happened.
        //
        // Both sides need their speculative adjustment undone before the real
        // transfer is applied, otherwise the same card gets counted twice. For
        // the thief that means taking back the maximum we added; for the victim
        // it means putting back the minimum we removed. Forgetting the victim's
        // half is an easy mistake to make and shows up as a range where there
        // should have been an exact number.
        if (steal.candidates.length === 1) {
          const r = steal.candidates[0];

          t.max[r] = Math.max(0, t.max[r] - 1);
          gain(state, steal.thief, r, 1);

          restoreFloor(v, r);
          lose(state, steal.victim, r, 1);

          steal.resolved = true;
          changed = true;
        }
      }
    }

    // Closed steals are never looked at again, so drop them once the list gets
    // long enough to be worth tidying.
    if (state.steals.length > 200) state.steals = state.steals.filter((s) => !s.resolved);
  }

  // The main switchboard: take one event and update the estimate.
  function applyEvent(state, ev) {
    switch (ev.type) {
      case "roll":
        // Rolling does not hand out anything by itself — colonist logs the
        // resources on separate lines. This is only used to mark whose turn it
        // is, and to expire any free roads that went unused.
        state.turn = ev.player;
        for (const p of Object.values(state.players)) p.freeRoads = 0;
        break;

      case "roll_gain":
        for (const r of Object.keys(ev.gains)) gain(state, ev.player, r, ev.gains[r]);
        break;

      case "build": {
        const p = ensurePlayer(state, ev.player);
        // Roads from a Road Building card are free, so use one of those up
        // instead of charging for it.
        if (ev.item === "road" && p.freeRoads > 0) { p.freeRoads -= 1; break; }
        spend(state, ev.player, COSTS[ev.item]);
        if (ev.item === "devcard") p.devCards += 1;
        break;
      }

      case "place_free":
        // The two opening settlements and roads do not cost anything.
        break;

      case "knight": {
        const p = ensurePlayer(state, ev.player);
        if (p.devCards > 0) p.devCards -= 1;
        p.knights += 1;
        break;
      }

      case "road_building": {
        // Grants two free roads, which the next two build events will use up.
        const p = ensurePlayer(state, ev.player);
        if (p.devCards > 0) p.devCards -= 1;
        p.freeRoads = 2;
        break;
      }

      case "play_dev": {
        // Any other development card. Whatever it does lands on later log
        // lines; all that matters here is that the card has left the hand.
        const p = ensurePlayer(state, ev.player);
        if (p.devCards > 0) p.devCards -= 1;
        break;
      }

      case "bank_trade":
        for (const r of Object.keys(ev.give)) loseAndConstrain(state, ev.player, r, ev.give[r]);
        for (const r of Object.keys(ev.receive)) gain(state, ev.player, r, ev.receive[r]);
        break;

      case "player_trade":
        // Both halves go through loseAndConstrain, so a single trade can tell
        // us something about earlier steals against either player.
        for (const r of Object.keys(ev.gave)) { loseAndConstrain(state, ev.from, r, ev.gave[r]); gain(state, ev.to, r, ev.gave[r]); }
        for (const r of Object.keys(ev.got))  { loseAndConstrain(state, ev.to, r, ev.got[r]);   gain(state, ev.from, r, ev.got[r]); }
        resolveSteals(state);
        break;

      case "steal":
        recordSteal(state, ev.thief, ev.victim, ev.resource || null);
        break;

      case "discard":
        for (const r of Object.keys(ev.cards)) loseAndConstrain(state, ev.player, r, ev.cards[r]);
        resolveSteals(state);
        break;

      case "year_of_plenty":
        for (const r of Object.keys(ev.cards)) gain(state, ev.player, r, ev.cards[r]);
        break;

      case "monopoly_haul":
        // Monopoly takes every card of one type from everyone else, so we know
        // for certain that they now have none. That is a strong statement, and
        // it often lets several open steals be resolved at once.
        for (const name of Object.keys(state.players)) {
          if (name === ev.player) continue;
          state.players[name].min[ev.resource] = 0;
          state.players[name].max[ev.resource] = 0;
        }
        gain(state, ev.player, ev.resource, ev.count);
        resolveSteals(state);
        break;

      default:
        break;
    }
    return state;
  }

  /*
   * Narrow the ranges using a player's exact total card count.
   *
   * colonist's own side panel shows how many cards each player is holding,
   * though not which ones. That total constrains the individual ranges:
   *
   *   you cannot have more of one resource than the total minus everything you
   *   are known to hold of the others, and you must have at least the total
   *   minus the most the others could account for.
   *
   * Applying both repeatedly tightens the estimate, sometimes a lot.
   *
   * This deliberately returns copies instead of editing the stored estimate.
   * The side panel can lag the log by a moment, and if a stale total were
   * written into the state there would be no way to undo it later — the
   * estimate would stay wrong for the rest of the game. Recalculating at draw
   * time costs nothing at this scale and cannot corrupt anything. If the total
   * and the log flatly disagree the tightening would push a minimum above a
   * maximum, so in that case we throw the result away and let the panel's
   * mismatch warning tell the user instead.
   */
  function tightenWithTotal(min, max, total) {
    const lo = { ...min }, hi = { ...max };
    if (total == null) return { lo, hi };

    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (const r of RESOURCES) {
        let otherMin = 0, otherMax = 0;
        for (const o of RESOURCES) if (o !== r) { otherMin += lo[o]; otherMax += hi[o]; }
        const newHi = Math.max(0, total - otherMin);
        const newLo = Math.max(0, total - otherMax);
        if (newHi < hi[r]) { hi[r] = newHi; changed = true; }
        if (newLo > lo[r]) { lo[r] = newLo; changed = true; }
      }
      if (!changed) break;
    }

    for (const r of RESOURCES) if (lo[r] > hi[r]) return { lo: { ...min }, hi: { ...max } };
    return { lo, hi };
  }

  // =========================================================================
  // 3) PARSER
  // =========================================================================
  /*
   * This section turns one line of the game log into one event object, or into
   * null if the line is not something we care about.
   *
   * Everything that knows about HTML lives here. colonist builds its class
   * names with a tool that appends a hash to each one, so ".messagePart-XeUsOgLX"
   * will change the next time the site is rebuilt. That is the main thing that
   * can break this script. Collecting the selectors in one object at the top,
   * and keeping the engine free of any HTML, means fixing it afterwards is a
   * matter of updating names here rather than reworking the logic.
   */
  const SEL = {
    messagePart: ".messagePart-XeUsOgLX",
    scrollItem: ".scrollItemContainer-WXX2rkzf",
    scroller: ".virtualScroller-lSkdkGJi",
    icon: "img.lobbyChatTextIcon",
    playerRow: ".playerRow-RMhJ5mpg",
    opponentRow: "opponentPlayerRow-AYNGolhx",
    username: ".username-M7Jbo6j0",
    count: ".count-Dh6MtdiN",
    vp: ".victoryPoints-u0xGd7sj",
    achievement: ".achievementItem-frxefOzP .achievementCount-CobfrMoe",
  };

  function mapResource(alt) {
    if (!alt) return null;
    return RESOURCE_MAP[alt.toLowerCase()] || null;
  }

  // The plain text of a log line, with the whitespace tidied up.
  function msgText(node) {
    let t = "";
    for (const p of node.querySelectorAll(SEL.messagePart)) t += " " + p.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  // Player names are the coloured spans. The first one is whoever the line is
  // about, since colonist always writes lines as "<name> did something".
  function leadName(node) {
    const span = node.querySelector('span[style*="color"]');
    return span ? span.textContent.trim() : null;
  }

  function colorOf(node) {
    const span = node.querySelector('span[style*="color"]');
    if (!span) return null;
    const m = (span.getAttribute("style") || "").match(/color:\s*(#[0-9a-fA-F]{3,6})/);
    return m ? m[1] : null;
  }

  /*
   * Flatten a log line into a single ordered list of pieces, where each piece
   * is either some text or a resource.
   *
   * This is needed because a trade line looks like
   *
   *     Alice gave [wood][wood] and got [ore] from Bob
   *
   * and simply collecting the images tells you the trade involved two wood and
   * an ore but not who ended up with what. The direction is carried by the
   * words sitting between the images, and those words are scattered across
   * nested elements. Walking the tree into a flat list keeps the order, which
   * is the part that matters, and throws away the nesting, which is not.
   *
   * Images that are not resources become empty text so they do not shift the
   * positions of anything else; every check below skips empty strings.
   */
  function tokenize(node) {
    const tokens = [];
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent && child.textContent.trim()) tokens.push({ text: child.textContent });
        } else if (child.tagName === "IMG") {
          const res = mapResource(child.getAttribute("alt"));
          tokens.push(res ? { res } : { text: "" });
        } else {
          walk(child);
        }
      }
    };
    for (const p of node.querySelectorAll(SEL.messagePart)) walk(p);
    return tokens;
  }

  function countTokens(tokens) {
    const c = {};
    for (const tk of tokens) if (tk.res) c[tk.res] = (c[tk.res] || 0) + 1;
    return c;
  }

  // Count only the resources sitting between two phrases, for example
  // everything between "gave" and "and got".
  function between(node, startRe, endRe) {
    const tokens = tokenize(node);
    let started = false;
    const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started && tk.text && endRe.test(tk.text)) break;
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }

  // Same idea, but everything after a phrase to the end of the line.
  function after(node, startRe) {
    const tokens = tokenize(node);
    let started = false;
    const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }

  // Every resource on the line, ignoring position. Only safe on lines where
  // there is nothing to be ambiguous about, like "Alice got [wheat][wheat]".
  function allResources(node) {
    const c = {};
    for (const img of node.querySelectorAll(SEL.icon)) {
      const r = mapResource(img.getAttribute("alt"));
      if (r) c[r] = (c[r] || 0) + 1;
    }
    return c;
  }

  function firstResource(node) {
    for (const img of node.querySelectorAll(SEL.icon)) {
      const r = mapResource(img.getAttribute("alt"));
      if (r) return r;
    }
    return null;
  }

  /*
   * Match a log line against each pattern in turn and build the matching event.
   *
   * The order of these checks matters in a few places, noted where it does.
   * Broadly, the more specific patterns have to come before the more general
   * ones, otherwise a general pattern swallows a line it should not.
   *
   * Anything unrecognised returns null and gets listed in the panel's log under
   * "skips", so it is easy to spot a phrasing that is not handled yet rather
   * than having lines disappear silently.
   */
  function parseLogLine(node) {
    const text = msgText(node);
    if (!text) return null;
    const player = leadName(node);

    if (/\brolled\b/.test(text)) {
      return player ? { type: "roll", player } : null;
    }

    // A trade being offered, not one that happened. This has to be checked
    // before the trade patterns further down, or every offer would be counted
    // as a completed trade.
    if (/\bwants to give\b/.test(text)) return null;

    if (/blocked by the Robber/i.test(text)) return null;
    if (/moved Robber/i.test(text)) return null;

    // Monopoly, which reads "Alice stole 5 [wheat]". The only thing separating
    // this from a robber steal is that there is no "from", so the two checks
    // have to stay in this order.
    if (/\bstole\b/.test(text) && !/\bfrom\b/.test(text)) {
      // The local player's own monopoly line may not have a coloured name span,
      // in which case the sentence starts with "You".
      const who = player || (/^You stole/i.test(text) ? "You" : null);
      if (!who) return null;
      const m = text.match(/stole\s+(\d+)/i);
      const count = m ? parseInt(m[1], 10) : 0;
      const res = firstResource(node);
      return res ? { type: "monopoly_haul", player: who, resource: res, count } : null;
    }

    // A robber steal. There are three phrasings, because colonist writes the
    // local player as "you" rather than by name:
    //
    //   "You stole [wheat] from Bob"      we are the thief, and we can see it
    //   "Alice stole [wheat] from you"    we are the victim, and we can see it
    //   "Alice stole a card from Bob"     someone else, and the card is hidden
    if (/\bstole\b/.test(text)) {
      const spans = node.querySelectorAll(SEL.messagePart + ' span[style*="color"]');
      const names = Array.from(spans).map((s) => s.textContent.trim());
      const keys = Object.keys(allResources(node));
      const resource = keys.length === 1 ? keys[0] : null;

      let thief, victim;
      if (/^You stole/i.test(text))      { thief = "You";            victim = names[0] || null; }
      else if (/from you\b/i.test(text)) { thief = names[0] || null; victim = "You"; }
      else                               { thief = names[0] || null; victim = names[1] || null; }

      if (!thief || !victim || thief === victim) return null;
      return { type: "steal", thief, victim, resource: resource || undefined };
    }

    // "got" on its own is a plain gain. Trade lines contain both "gave" and
    // "got", so excluding "gave" here lets them fall through to the trade
    // pattern further down.
    if (player && /\bgot\b/.test(text) && !/\bgave\b/.test(text)) {
      const gains = allResources(node);
      if (!Object.keys(gains).length) return null;
      return { type: "roll_gain", player, gains };
    }

    if (player && /received starting resources/i.test(text)) {
      const gains = allResources(node);
      if (!Object.keys(gains).length) return null;
      return { type: "roll_gain", player, gains };
    }

    // "placed" is the opening setup, which is free. "built" is a normal build,
    // which costs resources.
    if (player && /\bplaced a\b/.test(text)) {
      const m = text.match(/placed a (Settlement|Road|City)/i);
      return m ? { type: "place_free", player, item: m[1].toLowerCase() } : null;
    }
    if (player && /\bbuilt a\b/.test(text)) {
      const m = text.match(/built a (Road|Settlement|City)/i);
      return m ? { type: "build", player, item: m[1].toLowerCase() } : null;
    }
    if (player && /\bbought\b/.test(text)) {
      return { type: "build", player, item: "devcard" };
    }

    // Bank trades say "gave bank ... and took ...". This has to come before the
    // player-to-player trade pattern, which is looser.
    if (player && /\bgave bank\b/.test(text)) {
      return {
        type: "bank_trade",
        player,
        give: between(node, /gave bank/i, /and took/i),
        receive: after(node, /and took/i),
      };
    }

    if (player && /took from bank/i.test(text)) {
      return { type: "year_of_plenty", player, cards: after(node, /took from bank/i) };
    }

    if (player && /\bdiscarded\b/.test(text)) {
      return { type: "discard", player, cards: after(node, /discarded/i) };
    }

    // A trade between two players. The second coloured name is the other party.
    if (player && /\bgave\b/.test(text) && /\bgot\b/.test(text) && /\bfrom\b/.test(text)) {
      const spans = node.querySelectorAll(SEL.messagePart + ' span[style*="color"]');
      const to = spans.length >= 2 ? spans[spans.length - 1].textContent.trim() : null;
      const gave = between(node, /\bgave\b/i, /\band got\b/i);
      const got = between(node, /\band got\b/i, /\bfrom\b/i);
      if (to && to !== player) return { type: "player_trade", from: player, to, gave, got };
      return null;
    }

    // A development card being played. What it actually does shows up on later
    // lines; the only thing to record here is that the card left the hand, plus
    // which card it was for the two that need special treatment. The card name
    // sits in a tooltip on the line.
    if (player && /\bused\b/.test(text)) {
      if (/\bKnight\b/i.test(text)) return { type: "knight", player };
      if (/Road Building/i.test(text)) return { type: "road_building", player };
      return { type: "play_dev", player };
    }

    return null;
  }

  // =========================================================================
  // 4) OVERLAY
  // =========================================================================
  // The panel itself: one row per opponent, showing the estimated count of each
  // resource, their total, victory points and development cards. It can be
  // dragged around, collapsed and reset, and it has a built-in log of every
  // event that has been parsed.

  const PANEL_ID = "catan-tracker-panel";

  function buildPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) return existing;

    const el = document.createElement("div");
    el.id = PANEL_ID;
    // All the styles are scoped under the panel's id so they cannot leak out
    // and affect colonist's own layout.
    el.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;top:84px;right:14px;z-index:99999;
          width:300px;font-family:"Segoe UI",system-ui,sans-serif;
          background:rgba(17,21,28,.94);backdrop-filter:blur(7px);
          color:#e8eaed;border:1px solid #2b3340;border-radius:12px;
          box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden;font-size:13px;}
        #${PANEL_ID} .ctt-head{display:flex;align-items:center;justify-content:space-between;
          padding:10px 13px;background:#0e1116;border-bottom:1px solid #2b3340;cursor:move;}
        #${PANEL_ID} .ctt-title{font-weight:700;letter-spacing:.4px;font-size:12px;color:#cdd3db;}
        #${PANEL_ID} .ctt-btn{cursor:pointer;color:#7d8794;font-size:13px;padding:0 5px;user-select:none;}
        #${PANEL_ID} .ctt-btn:hover{color:#e8eaed;}
        #${PANEL_ID} .ctt-body{padding:8px 9px 10px;}
        #${PANEL_ID} .ctt-row{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;
          border:1px solid transparent;}
        #${PANEL_ID} .ctt-row + .ctt-row{margin-top:4px;}
        #${PANEL_ID} .ctt-row.active{background:rgba(240,180,41,.09);border-color:rgba(240,180,41,.35);}
        #${PANEL_ID} .ctt-namecol{flex:0 0 80px;display:flex;flex-direction:column;gap:2px;min-width:0;}
        #${PANEL_ID} .ctt-name{font-weight:700;font-size:13px;white-space:nowrap;overflow:hidden;
          text-overflow:ellipsis;display:flex;align-items:center;gap:4px;}
        #${PANEL_ID} .ctt-badges{display:flex;gap:3px;height:13px;}
        #${PANEL_ID} .ctt-badge{font-size:9px;line-height:13px;padding:0 4px;border-radius:4px;
          font-weight:700;letter-spacing:.2px;}
        #${PANEL_ID} .ctt-badge.army{background:#7c2d12;color:#fdba74;}
        #${PANEL_ID} .ctt-badge.road{background:#1e3a5f;color:#93c5fd;}
        #${PANEL_ID} .ctt-badge.turn{background:#f0b429;color:#1a1d23;}
        #${PANEL_ID} .ctt-cards{display:flex;gap:9px;flex:1;justify-content:flex-end;align-items:center;}
        #${PANEL_ID} .ctt-card{display:flex;flex-direction:column;align-items:center;gap:1px;
          font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-icon{width:13px;height:18px;object-fit:contain;opacity:.92;display:block;}
        #${PANEL_ID} .ctt-glyph{font-size:12px;line-height:18px;}
        #${PANEL_ID} .ctt-num{font-size:12px;font-weight:600;text-align:center;color:#e8eaed;}
        #${PANEL_ID} .ctt-num.zero{color:#3f4754;font-weight:400;}
        #${PANEL_ID} .ctt-num.range{color:#f0b429;}
        #${PANEL_ID} .ctt-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;
          gap:1px;margin-left:4px;min-width:30px;}
        #${PANEL_ID} .ctt-total{font-size:13px;font-weight:700;color:#e8eaed;font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-total.range{color:#f0b429;}
        #${PANEL_ID} .ctt-total.mismatch{color:#ef4444;text-decoration:underline dotted;cursor:help;}
        #${PANEL_ID} .ctt-sub{display:flex;align-items:center;gap:5px;margin-top:1px;}
        #${PANEL_ID} .ctt-vp{font-size:10px;color:#fcd34d;}
        #${PANEL_ID} .ctt-dev{font-size:10px;color:#a78bfa;display:flex;align-items:center;gap:2px;}
        #${PANEL_ID} .ctt-dev img{width:8px;height:11px;object-fit:contain;}
        #${PANEL_ID} .ctt-empty{padding:18px 12px;color:#7d8794;font-size:12px;text-align:center;line-height:1.6;}
        #${PANEL_ID}.ctt-collapsed .ctt-body{display:none;}
        #${PANEL_ID} .ctt-foot{padding:6px 13px;border-top:1px solid #2b3340;color:#5b6470;font-size:10px;
          display:flex;justify-content:space-between;}
        #${PANEL_ID} .ctt-foot .desync{color:#ef4444;font-weight:700;}
        #${PANEL_ID} .ctt-log{display:none;border-top:1px solid #2b3340;background:#0b0e13;}
        #${PANEL_ID}.ctt-logopen .ctt-log{display:block;}
        #${PANEL_ID} .ctt-log-head{display:flex;align-items:center;justify-content:space-between;
          padding:6px 11px;border-bottom:1px solid #1b2129;}
        #${PANEL_ID} .ctt-log-title{font-size:10px;font-weight:700;letter-spacing:.4px;color:#7d8794;}
        #${PANEL_ID} .ctt-log-actions{display:flex;gap:8px;}
        #${PANEL_ID} .ctt-log-btn{cursor:pointer;font-size:10px;color:#7d8794;user-select:none;
          padding:1px 6px;border:1px solid #2b3340;border-radius:4px;}
        #${PANEL_ID} .ctt-log-btn:hover{color:#e8eaed;border-color:#3a4452;}
        #${PANEL_ID} .ctt-log-btn.on{color:#f0b429;border-color:#5b4a1a;}
        #${PANEL_ID} .ctt-log-list{max-height:200px;overflow-y:auto;padding:6px 11px;
          font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11px;line-height:1.55;
          color:#aeb6c0;white-space:pre-wrap;word-break:break-word;}
        #${PANEL_ID} .ctt-log-line{padding:1px 0;}
        #${PANEL_ID} .ctt-log-line.skip{color:#5b6470;}
        #${PANEL_ID} .ctt-log-list::-webkit-scrollbar{width:8px;}
        #${PANEL_ID} .ctt-log-list::-webkit-scrollbar-thumb{background:#2b3340;border-radius:4px;}
      </style>
      <div class="ctt-head">
        <span class="ctt-title">CARD TRACKER</span>
        <span>
          <span class="ctt-btn" data-act="log" title="Show/hide game log">📋</span>
          <span class="ctt-btn" data-act="debug" title="Toggle console debug logging">⚙</span>
          <span class="ctt-btn" data-act="reset" title="Reset counts">⟳</span>
          <span class="ctt-btn" data-act="toggle" title="Collapse">–</span>
        </span>
      </div>
      <div class="ctt-body"><div class="ctt-empty">Waiting for the game log…<br>Play or refresh after a few actions.</div></div>
      <div class="ctt-log">
        <div class="ctt-log-head">
          <span class="ctt-log-title">GAME LOG</span>
          <span class="ctt-log-actions">
            <span class="ctt-log-btn" data-act="log-skips" title="Include lines the tracker ignored">skips</span>
            <span class="ctt-log-btn" data-act="log-copy" title="Copy log to clipboard">copy</span>
            <span class="ctt-log-btn" data-act="log-clear" title="Clear log">clear</span>
          </span>
        </div>
        <div class="ctt-log-list"></div>
      </div>
      <div class="ctt-foot"><span data-foot="status">idle</span><span data-foot="count">0 events</span></div>
    `;
    document.body.appendChild(el);

    // Dragging: remember where inside the panel the mouse grabbed it, then keep
    // that same point under the cursor as it moves.
    const head = el.querySelector(".ctt-head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ctt-btn")) return; // let buttons be buttons
      const r = el.getBoundingClientRect();
      drag = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = (e.clientX - drag.x) + "px";
      el.style.top = (e.clientY - drag.y) + "px";
      el.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (drag = null));

    const on = (act, fn) => el.querySelector(`[data-act="${act}"]`).addEventListener("click", fn);

    on("toggle", () => {
      el.classList.toggle("ctt-collapsed");
      el.querySelector('[data-act="toggle"]').textContent = el.classList.contains("ctt-collapsed") ? "+" : "–";
    });
    on("reset", () => {
      if (confirm("Reset all tracked counts? Use this if the tracker started mid-game and is out of sync.")) {
        window.__catanReset && window.__catanReset();
      }
    });
    on("debug", () => {
      DEBUG = !DEBUG;
      el.querySelector('[data-act="debug"]').style.color = DEBUG ? "#f0b429" : "";
      console.log("[catan] debug", DEBUG ? "ON — open console to watch parsed events" : "OFF");
    });
    on("log", () => {
      el.classList.toggle("ctt-logopen");
      el.querySelector('[data-act="log"]').style.color = el.classList.contains("ctt-logopen") ? "#f0b429" : "";
      renderLog();
    });
    on("log-skips", (e) => {
      showSkips = !showSkips;
      e.target.classList.toggle("on", showSkips);
      renderLog();
    });
    on("log-copy", () => {
      const btn = el.querySelector('[data-act="log-copy"]');
      const text = logEntries.filter((en) => showSkips || en.kind !== "skip").map((en) => en.text).join("\n");
      navigator.clipboard.writeText(text).then(() => flash(btn, "copied!"), () => flash(btn, "blocked"));
    });
    on("log-clear", () => { logEntries.length = 0; renderLog(); });

    return el;
  }

  // Briefly change a button's label so a click has visible feedback.
  function flash(btn, msg) {
    const prev = btn.textContent;
    btn.textContent = msg;
    setTimeout(() => (btn.textContent = prev), 1100);
  }

  // Player names come from the page, so they get escaped before being put back
  // into HTML.
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Work out who holds Largest Army and Longest Road from the counts colonist
  // shows. Army needs at least three knights and road at least five segments,
  // which is why the running maximums start at two and four. A tie clears the
  // badge; the real rule is that whoever got there first keeps it, but the log
  // does not say who that was.
  function computeHolders(names, truth) {
    let armyHolder = null, armyMax = 2, roadHolder = null, roadMax = 4;
    for (const name of names) {
      const a = truth[name]?.army, r = truth[name]?.road;
      if (a != null) { if (a > armyMax) { armyMax = a; armyHolder = name; } else if (a === armyMax) armyHolder = null; }
      if (r != null) { if (r > roadMax) { roadMax = r; roadHolder = name; } else if (r === roadMax) roadHolder = null; }
    }
    return { armyHolder, roadHolder };
  }

  function renderPanel(state, meta) {
    const el = buildPanel();
    const body = el.querySelector(".ctt-body");
    const truth = state.truth || {};

    // Show everyone we have heard of from either source, minus ourselves —
    // you can see your own hand, so there is nothing to estimate.
    const names = Array.from(new Set([...Object.keys(state.players), ...Object.keys(truth)]))
      .filter((n) => n !== "You" && n !== youName);

    el.querySelector('[data-foot="status"]').innerHTML = state.desync
      ? `<span class="desync">desync — try reset</span>`
      : escapeHtml(meta.status || "tracking");
    el.querySelector('[data-foot="count"]').textContent = meta.events + " events";

    if (!names.length) return;
    const { armyHolder, roadHolder } = computeHolders(names, truth);

    let html = "";
    for (const name of names) {
      const p = state.players[name] || { min: emptyHand(), max: emptyHand(), devCards: 0, knights: 0 };
      const t = truth[name] || {};
      const color = state.colors[name] || "#9aa4b2";

      // The raw totals, before any tightening. These are what get compared
      // against the game's own count further down.
      let rawMin = 0, rawMax = 0;
      for (const r of RESOURCES) { rawMin += p.min[r]; rawMax += p.max[r]; }

      // Narrow the displayed ranges using the exact total, if we have it.
      const { lo, hi } = tightenWithTotal(p.min, p.max, t.cards);

      // Each resource gets an icon and a number. Exact counts are white, zeros
      // are dimmed so the eye skips them, and anything uncertain is amber and
      // shown as a range. That colour is the main thing the panel communicates:
      // amber means the tracker does not know.
      let cards = "";
      for (const r of RESOURCES) {
        const exact = lo[r] === hi[r];
        const cls = exact ? (lo[r] === 0 ? "zero" : "") : "range";
        const val = exact ? String(lo[r]) : `${lo[r]}–${hi[r]}`;
        cards += `<span class="ctt-card">` +
          `<img class="ctt-icon" src="${RESOURCE_ICON[r]}" alt="" ` +
          `onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ctt-glyph',textContent:'${RESOURCE_GLYPH[r]}'}))">` +
          `<span class="ctt-num ${cls}">${val}</span></span>`;
      }

      // The total prefers the game's own number when there is one, since that
      // is exact. Comparing it against our estimate gives a free correctness
      // check: if our guaranteed minimum is already above the real total, or
      // the real total sits outside our range entirely, something has gone
      // wrong upstream and the number turns red rather than pretending.
      const realTotal = t.cards;
      let totLabel, totCls = "", totTitle = "";
      if (realTotal != null) {
        totLabel = String(realTotal);
        if (rawMin > realTotal || (rawMax < realTotal && rawMin !== rawMax)) {
          totCls = "mismatch";
          totTitle = `breakdown ${rawMin}–${rawMax} vs game ${realTotal} (out of sync?)`;
        } else if (realTotal > rawMin) {
          totTitle = `${realTotal} cards; ${realTotal - rawMin} not yet attributed`;
        }
      } else {
        totLabel = rawMin === rawMax ? `${rawMin}` : `${rawMin}–${rawMax}`;
        totCls = rawMin === rawMax ? "" : "range";
      }

      const devCount = t.dev != null ? t.dev : p.devCards;
      const dev = devCount > 0
        ? `<span class="ctt-dev" title="${devCount} dev card(s)"><img src="${DEV_ICON}" alt="dev">${devCount}</span>`
        : "";
      const vp = t.vp != null ? `<span class="ctt-vp" title="Victory points">${t.vp}★</span>` : "";

      const display = escapeHtml(name.length > 10 ? name.slice(0, 9) + "…" : name);
      const isTurn = state.turn === name;
      const badges =
        (isTurn ? `<span class="ctt-badge turn" title="Current turn">TURN</span>` : "") +
        (armyHolder === name ? `<span class="ctt-badge army" title="Largest Army">ARMY</span>` : "") +
        (roadHolder === name ? `<span class="ctt-badge road" title="Longest Road">ROAD</span>` : "");

      html += `<div class="ctt-row ${isTurn ? "active" : ""}">
        <span class="ctt-namecol">
          <span class="ctt-name" style="color:${escapeHtml(color)}" title="${escapeHtml(name)}">${display}</span>
          <span class="ctt-badges">${badges}</span>
        </span>
        <span class="ctt-cards">${cards}</span>
        <span class="ctt-meta">
          <span class="ctt-total ${totCls}" title="${escapeHtml(totTitle)}">${totLabel}</span>
          <span class="ctt-sub">${vp}${dev}</span>
        </span>
      </div>`;
    }
    body.innerHTML = html;
  }

  // =========================================================================
  // 5) OBSERVERS
  // =========================================================================
  // Watching the page for changes, feeding new log lines into the engine, and
  // reading the exact totals off colonist's own player panel.

  let state = createState();
  let processed = new Set(); // log lines already handled, by their data-index
  let eventCount = 0;
  let youName = null;        // the local player's real username, once known

  // ---- the panel's own game log --------------------------------------------
  // Every parsed event is also written out in plain English inside the panel.
  // This started as a debugging aid and turned out to be the most useful thing
  // to have around: when a number looks wrong, you can read back through what
  // the tracker thought was happening and find the line that caused it, instead
  // of guessing.

  const logEntries = [];
  let showSkips = false;
  const MAX_LOG = 500;

  function fmtCards(obj) {
    if (!obj) return "";
    const parts = [];
    for (const r of RESOURCES) if (obj[r]) parts.push(`${obj[r]} ${r}`);
    return parts.join(", ") || "nothing";
  }

  function describeEvent(ev) {
    switch (ev.type) {
      case "roll": return `— ${ev.player}'s turn —`;
      case "roll_gain": return `${ev.player} got ${fmtCards(ev.gains)}`;
      case "build": return ev.item === "devcard" ? `${ev.player} bought a dev card` : `${ev.player} built a ${ev.item}`;
      case "place_free": return `${ev.player} placed a ${ev.item} (free)`;
      case "bank_trade": return `${ev.player} traded ${fmtCards(ev.give)} → ${fmtCards(ev.receive)} (bank)`;
      case "player_trade": return `${ev.from} gave ${fmtCards(ev.gave)} → got ${fmtCards(ev.got)} from ${ev.to}`;
      case "steal": return ev.resource
        ? `${ev.thief} stole ${ev.resource} from ${ev.victim}`
        : `${ev.thief} stole 1 (hidden) from ${ev.victim}`;
      case "discard": return `${ev.player} discarded ${fmtCards(ev.cards)}`;
      case "year_of_plenty": return `${ev.player} took ${fmtCards(ev.cards)} (Year of Plenty)`;
      case "monopoly_haul": return `${ev.player} monopolized ${ev.count} ${ev.resource}`;
      case "knight": return `${ev.player} played a Knight`;
      case "road_building": return `${ev.player} played Road Building (2 free roads)`;
      case "play_dev": return `${ev.player} played a dev card`;
      default: return ev.type;
    }
  }

  function pushLog(kind, text) {
    logEntries.push({ kind, text });
    if (logEntries.length > MAX_LOG) logEntries.splice(0, logEntries.length - MAX_LOG);
  }

  function renderLog() {
    const el = document.getElementById(PANEL_ID);
    const list = el && el.querySelector(".ctt-log-list");
    if (!list) return;
    const rows = logEntries.filter((en) => showSkips || en.kind !== "skip");
    list.innerHTML = rows.map((en) =>
      `<div class="ctt-log-line ${en.kind === "skip" ? "skip" : ""}">${escapeHtml(en.text)}</div>`
    ).join("") || `<div class="ctt-log-line skip">No events yet.</div>`;
    list.scrollTop = list.scrollHeight; // keep the newest line in view
  }

  // Start over. Mostly useful if the tracker was opened partway through a game
  // and never had the earlier history to work from.
  window.__catanReset = function () {
    state = createState();
    processed = new Set();
    eventCount = 0;
    youName = null;
    logEntries.length = 0;
    renderLog();
    renderPanel(state, { status: "reset", events: 0 });
  };

  // Remember the colour colonist assigned each player so the panel can match.
  function recordColor(node, ev) {
    const c = colorOf(node);
    if (!c) return;
    const who = ev.player || ev.from || ev.thief;
    if (who && !state.colors[who]) state.colors[who] = c;

    const spans = node.querySelectorAll(SEL.messagePart + ' span[style*="color"]');
    if (spans.length >= 2 && ev.to) {
      const m = (spans[spans.length - 1].getAttribute("style") || "").match(/color:\s*(#[0-9a-fA-F]{3,6})/);
      if (m && !state.colors[ev.to]) state.colors[ev.to] = m[1];
    }
  }

  /*
   * Handle one line of the log.
   *
   * The skip-if-already-seen check at the top is essential. colonist's log is a
   * virtual scroller: rather than keeping every message in the page, it renders
   * only the ones currently visible and reuses those elements as you scroll.
   * That means the same message gets added to the page over and over — on
   * scroll, on resize, and every time a new message arrives — and without a
   * guard the counts climb every time.
   *
   * The scroller labels each line with a data-index, which stays the same
   * across all that re-rendering, so remembering which indexes have been
   * handled makes the whole pipeline safe to run as often as we like.
   */
  function processNode(node) {
    const idx = node.getAttribute("data-index");
    if (idx === null || processed.has(idx)) return;
    processed.add(idx);

    let ev;
    try {
      ev = parseLogLine(node);
    } catch (e) {
      if (DEBUG) console.warn("[catan] parse error on", idx, e);
      return;
    }

    // Lines we do not handle still get recorded, so nothing vanishes without a
    // trace and unhandled phrasings are easy to find.
    if (!ev) {
      const t = msgText(node);
      if (t) {
        pushLog("skip", `· (ignored) ${t}`);
        renderLog();
        if (DEBUG) console.log("%c[catan] no-event", "color:#7d8794", `#${idx}`, JSON.stringify(t.slice(0, 80)));
      }
      return;
    }

    recordColor(node, ev);
    applyEvent(state, ev);
    resolveYou();
    eventCount++;
    pushLog("event", describeEvent(ev));
    renderLog();

    if (DEBUG) {
      console.log("%c[catan] event", "color:#5b9bd5", `#${idx}`, ev);
      console.log("%c[catan] hands", "color:#70ad47", snapshotForLog(state));
    }
    renderPanel(state, { status: "tracking", events: eventCount });
  }

  // A short summary of everyone's hand, for the console in debug mode.
  function snapshotForLog(state) {
    const out = {};
    for (const [name, p] of Object.entries(state.players)) {
      const parts = [];
      for (const r of RESOURCES) {
        const v = p.min[r] === p.max[r] ? p.min[r] : `${p.min[r]}-${p.max[r]}`;
        if (v !== 0) parts.push(`${r}:${v}`);
      }
      out[name] = parts.join(" ") || "—";
    }
    return out;
  }

  /*
   * Working out who "You" is.
   *
   * colonist writes the local player in the second person on some lines — "You
   * stole a card from Bob" — but uses their username everywhere else. That is
   * one person with two names, and the mapping is not always available at the
   * moment the first "You" line shows up.
   *
   * Rather than wait, the tracker just accumulates under the placeholder name
   * and folds it into the real one as soon as the username is known. That way
   * it does not matter which comes first.
   */
  function mergePlayers(state, fromName, intoName) {
    if (fromName === intoName) return;
    const from = state.players[fromName];
    if (!from) return;

    const into = ensurePlayer(state, intoName);
    for (const r of RESOURCES) { into.min[r] += from.min[r]; into.max[r] += from.max[r]; }
    into.devCards += from.devCards || 0;
    into.knights += from.knights || 0;
    into.freeRoads = Math.max(into.freeRoads || 0, from.freeRoads || 0);
    delete state.players[fromName];

    // The open steals have to be updated too, not just the hands. A steal still
    // waiting to be resolved points at a player by name, and if that name no
    // longer exists the steal can never be closed out.
    for (const s of state.steals) {
      if (s.thief === fromName) s.thief = intoName;
      if (s.victim === fromName) s.victim = intoName;
    }

    if (state.colors[fromName] && !state.colors[intoName]) state.colors[intoName] = state.colors[fromName];
    delete state.colors[fromName];
    if (state.turn === fromName) state.turn = intoName;

    resolveSteals(state);
  }

  // A manual override, in case the automatic detection below ever fails:
  //   __catanSetName("YourColonistName#1234")
  window.__catanSetName = function (name) {
    youName = name;
    mergePlayers(state, "You", name);
    renderPanel(state, { status: "tracking", events: eventCount });
    console.log("[catan] local player set to", name);
  };

  function resolveYou() {
    if (!state.players["You"] || !youName) return;
    mergePlayers(state, "You", youName);
  }

  function scanAll(container) {
    for (const node of container.querySelectorAll(SEL.scrollItem)) processNode(node);
  }

  /*
   * Read colonist's own player panel.
   *
   * The side panel already shows each player's exact card count, development
   * cards, victory points and achievement counts. Those numbers are worth
   * having, because they are certain — but only for the total. The panel never
   * says which cards make up that total, and the breakdown is the entire point
   * of this script, so the exact numbers are used alongside our estimate rather
   * than replacing it.
   *
   * The panel also solves the "You" problem: every row except the local
   * player's is marked as an opponent, so the local player is identified by not
   * being tagged.
   */
  const COLOR_CLASS = {
    red: "#CF4449", orange: "#CF6B2E", blue: "#285FBD", green: "#228103",
    white: "#d8dde3", brown: "#8a5a2b",
  };

  function readPlayerPanel() {
    const rows = document.querySelectorAll(SEL.playerRow);
    if (!rows.length) return;
    state.truth = state.truth || {};
    let detectedYou = null;

    for (const row of rows) {
      const nameEl = row.querySelector(SEL.username);
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();
      if (!row.classList.contains(SEL.opponentRow)) detectedYou = name;

      const num = (el) => { const n = parseInt((el?.textContent || "").trim(), 10); return isNaN(n) ? null : n; };
      const achs = row.querySelectorAll(SEL.achievement);

      state.truth[name] = {
        cards: num(row.querySelector(`[data-resource-card="true"] ${SEL.count}`)),
        dev: num(row.querySelector(`[data-development-card="true"] ${SEL.count}`)),
        vp: num(row.querySelector(SEL.vp)),
        army: achs[0] ? num(achs[0]) : null,
        road: achs[1] ? num(achs[1]) : null,
      };

      // The player's colour is part of a class name on the avatar, like
      // "blue-JPbw6Gaq", so take the part before the hash.
      if (!state.colors[name]) {
        const bg = row.querySelector("[class*='hasBackground']");
        for (const cls of (bg?.className || "").split(/\s+/)) {
          const key = cls.split("-")[0];
          if (COLOR_CLASS[key]) { state.colors[name] = COLOR_CLASS[key]; break; }
        }
      }
    }

    if (detectedYou && !youName) youName = detectedYou;
    resolveYou();
    renderPanel(state, { status: "tracking", events: eventCount });
  }

  // ---- starting up ---------------------------------------------------------

  let logObs = null, panelObs = null, activeContainer = null;

  function teardown() {
    if (logObs) { logObs.disconnect(); logObs = null; }
    if (panelObs) { panelObs.disconnect(); panelObs = null; }
    activeContainer = null;
  }

  function start() {
    const container = document.querySelector(SEL.scroller);
    if (!container) return false;                     // no game loaded yet
    if (container === activeContainer) return true;   // already set up

    // A different container means colonist has loaded a new game. Stop watching
    // the old one and clear the counts, otherwise the previous game's numbers
    // carry over into a game they have nothing to do with.
    if (activeContainer) { teardown(); window.__catanReset(); }
    activeContainer = container;

    buildPanel();
    scanAll(container);

    // Watch the log for new messages.
    logObs = new MutationObserver(() => scanAll(container));
    logObs.observe(container, { childList: true, subtree: true });

    // Watch the player panel for changes to the exact totals.
    //
    // Two things to be careful about here. First, this observer's callback
    // redraws our own panel, and our panel is part of the page, so changes we
    // caused would trigger it again — hence the check that ignores anything
    // coming from inside it. Second, redrawing on every single mutation is
    // wasteful, so the work is deferred to the next animation frame and
    // repeated triggers in the meantime collapse into one.
    readPlayerPanel();
    let pending = false;
    panelObs = new MutationObserver((records) => {
      const ours = document.getElementById(PANEL_ID);
      const relevant = records.some((r) => !(ours && r.target instanceof Node && ours.contains(r.target)));
      if (!relevant || pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; readPlayerPanel(); });
    });
    const panelRoot =
      document.querySelector(SEL.playerRow)?.closest("[class*='ScrollContainer']") || document.body;
    panelObs.observe(panelRoot, { childList: true, subtree: true, characterData: true });

    renderPanel(state, { status: "tracking", events: eventCount });
    return true;
  }

  // The log only exists once a game has loaded, and the script runs as soon as
  // the page does, so keep checking. Leaving the timer running also means a
  // second game in the same tab gets picked up without a refresh.
  setInterval(start, 1500);
  start();

})();
