// ==UserScript==
// @name         Colonist Card Tracker
// @namespace    catan-tracker
// @version      0.1.0
// @description  Tracks opponents' likely resource cards on colonist.io from the public game log.
// @match        https://colonist.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  // =========================================================================
  // 0) CONFIG
  // =========================================================================
  // Debug mode: logs every parsed event and the resulting hands to the console.
  // Toggle at runtime from the browser console with:  __catanDebug(true|false)
  // or flip this default to true.
  let DEBUG = false;
  window.__catanDebug = (on) => { DEBUG = !!on; console.log("[catan] debug", DEBUG ? "ON" : "OFF"); };

  // =========================================================================
  // 1) TYPES / CONSTANTS
  // =========================================================================
  const RESOURCES = ["wood", "brick", "sheep", "wheat", "ore"];
  const COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { ore: 3, wheat: 2 },
    devcard: { sheep: 1, wheat: 1, ore: 1 },
  };
  const RESOURCE_MAP = { lumber: "wood", brick: "brick", wool: "sheep", grain: "wheat", ore: "ore" };
  const RESOURCE_GLYPH = { wood: "🌲", brick: "🧱", sheep: "🐑", wheat: "🌾", ore: "⛰️" };

  const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

  // =========================================================================
  // 2) STATE ENGINE  (range-per-resource with retroactive steal resolution)
  // =========================================================================
  function createState() {
    return { players: {}, steals: [], colors: {} };
  }
  function ensurePlayer(state, name) {
    if (!state.players[name]) state.players[name] = { min: emptyHand(), max: emptyHand() };
    return state.players[name];
  }
  function gain(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    p.min[res] += n; p.max[res] += n;
  }
  function lose(state, name, res, n = 1) {
    const p = ensurePlayer(state, name);
    p.min[res] = Math.max(0, p.min[res] - n);
    p.max[res] = Math.max(0, p.max[res] - n);
  }
  function loseAndConstrain(state, name, res, n = 1) {
    for (const steal of state.steals) {
      if (steal.resolved || steal.victim !== name) continue;
      if (!steal.candidates.includes(res)) continue;
      const p = state.players[name];
      if (p.min[res] < n) {
        steal.candidates = steal.candidates.filter((c) => c !== res);
        state.players[steal.thief].max[res] -= 1;
        p.min[res] = Math.min(p.min[res] + 1, p.max[res]);
      }
    }
    lose(state, name, res, n);
    resolveSteals(state);
  }
  function spend(state, name, cost) {
    for (const res of Object.keys(cost)) loseAndConstrain(state, name, res, cost[res]);
  }
  function recordSteal(state, thief, victim, knownResource) {
    const v = ensurePlayer(state, victim);
    ensurePlayer(state, thief);
    if (knownResource) {
      lose(state, victim, knownResource, 1);
      gain(state, thief, knownResource, 1);
      return;
    }
    const candidates = RESOURCES.filter((r) => v.max[r] > 0);
    const steal = { thief, victim, candidates, resolved: false };
    state.steals.push(steal);
    for (const r of candidates) {
      state.players[thief].max[r] += 1;
      state.players[victim].min[r] = Math.max(0, state.players[victim].min[r] - 1);
    }
    resolveSteals(state);
  }
  function resolveSteals(state) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const steal of state.steals) {
        if (steal.resolved) continue;
        const v = state.players[steal.victim];
        const t = state.players[steal.thief];
        const live = steal.candidates.filter((r) => v.max[r] > 0);
        if (live.length !== steal.candidates.length) {
          for (const r of steal.candidates) if (!live.includes(r)) t.max[r] -= 1;
          steal.candidates = live;
          changed = true;
        }
        if (steal.candidates.length === 1) {
          const r = steal.candidates[0];
          t.max[r] -= 1; gain(state, steal.thief, r, 1);
          v.min[r] = Math.max(0, v.min[r] - 1); lose(state, steal.victim, r, 1);
          steal.resolved = true;
          changed = true;
        }
      }
    }
  }
  function applyEvent(state, ev) {
    switch (ev.type) {
      case "roll_gain":
        for (const r of Object.keys(ev.gains)) gain(state, ev.player, r, ev.gains[r]);
        break;
      case "build":
        spend(state, ev.player, COSTS[ev.item]);
        break;
      case "place_free":
        break; // free opening placement, no cost
      case "bank_trade":
        for (const r of Object.keys(ev.give)) loseAndConstrain(state, ev.player, r, ev.give[r]);
        for (const r of Object.keys(ev.receive)) gain(state, ev.player, r, ev.receive[r]);
        break;
      case "player_trade":
        for (const r of Object.keys(ev.gave)) { loseAndConstrain(state, ev.from, r, ev.gave[r]); gain(state, ev.to, r, ev.gave[r]); }
        for (const r of Object.keys(ev.got)) { loseAndConstrain(state, ev.to, r, ev.got[r]); gain(state, ev.from, r, ev.got[r]); }
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

  // =========================================================================
  // 3) PARSER  (colonist DOM log line -> engine event)
  // =========================================================================
  function mapResource(alt) {
    if (!alt) return null;
    return RESOURCE_MAP[alt.toLowerCase()] || null;
  }
  function msgText(node) {
    const parts = node.querySelectorAll(".messagePart-XeUsOgLX");
    let t = "";
    for (const p of parts) t += " " + p.textContent;
    return t.replace(/\s+/g, " ").trim();
  }
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
  // Flat ordered token stream of {text} / {res} to split resources by connectors.
  function tokenize(node) {
    const tokens = [];
    const parts = node.querySelectorAll(".messagePart-XeUsOgLX");
    const walk = (el) => {
      for (const child of el.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (child.textContent && child.textContent.trim()) tokens.push({ text: child.textContent });
        } else if (child.tagName === "IMG") {
          const res = mapResource(child.getAttribute("alt"));
          if (res) tokens.push({ res }); else tokens.push({ text: "" });
        } else {
          walk(child);
        }
      }
    };
    for (const p of parts) walk(p);
    // include tooltip spans (dev card names) — harmless, they carry no resources
    return tokens;
  }
  function countTokens(tokens) {
    const c = {};
    for (const tk of tokens) if (tk.res) c[tk.res] = (c[tk.res] || 0) + 1;
    return c;
  }
  function between(node, startRe, endRe) {
    const tokens = tokenize(node);
    let started = false; const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started && tk.text && endRe.test(tk.text)) break;
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }
  function after(node, startRe) {
    const tokens = tokenize(node);
    let started = false; const slice = [];
    for (const tk of tokens) {
      if (tk.text && startRe.test(tk.text)) { started = true; continue; }
      if (started) slice.push(tk);
    }
    return countTokens(slice);
  }
  function allResources(node) {
    const c = {};
    for (const img of node.querySelectorAll("img.lobbyChatTextIcon")) {
      const r = mapResource(img.getAttribute("alt"));
      if (r) c[r] = (c[r] || 0) + 1;
    }
    return c;
  }

  function parseLogLine(node) {
    const text = msgText(node);
    if (!text) return null;
    const player = leadName(node);

    if (/\brolled\b/.test(text)) return null;
    if (/\bwants to give\b/.test(text)) return null;
    if (/blocked by the Robber/i.test(text)) return null;
    if (/moved Robber/i.test(text)) return null;

    // MONOPOLY HAUL: "<name> stole <N> <res>" (no "from").
    if (player && /\bstole\b/.test(text) && !/\bfrom\b/.test(text)) {
      const m = text.match(/stole\s+(\d+)/i);
      const count = m ? parseInt(m[1], 10) : 0;
      let res = null;
      for (const img of node.querySelectorAll("img.lobbyChatTextIcon")) {
        const r = mapResource(img.getAttribute("alt"));
        if (r) { res = r; break; }
      }
      if (res) return { type: "monopoly_haul", player, resource: res, count };
      return null;
    }

    // STEAL: "You stole <res> from <V>" / "<T> stole <res> from you" / "<T> stole <hidden> from <V>".
    if (/\bstole\b/.test(text)) {
      const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
      const names = Array.from(spans).map((s) => s.textContent.trim());
      const res = allResources(node);
      const keys = Object.keys(res);
      const resource = keys.length === 1 ? keys[0] : null;
      let thief, victim;
      if (/^You stole/i.test(text)) { thief = "You"; victim = names[0] || null; }
      else if (/from you\b/i.test(text)) { thief = names[0] || null; victim = "You"; }
      else { thief = names[0] || null; victim = names[1] || null; }
      if (!thief || !victim) return null;
      return { type: "steal", thief, victim, resource: resource || undefined };
    }

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
    if (player && /\bplaced a\b/.test(text)) {
      const m = text.match(/placed a (Settlement|Road|City)/i);
      if (m) return { type: "place_free", player, item: m[1].toLowerCase() };
      return null;
    }
    if (player && /\bbuilt a\b/.test(text)) {
      const m = text.match(/built a (Road|Settlement|City)/i);
      if (m) return { type: "build", player, item: m[1].toLowerCase() };
      return null;
    }
    if (player && /\bbought\b/.test(text)) {
      return { type: "build", player, item: "devcard" };
    }
    if (player && /\bgave bank\b/.test(text)) {
      const give = between(node, /gave bank/i, /and took/i);
      const receive = after(node, /and took/i);
      return { type: "bank_trade", player, give, receive };
    }
    if (player && /took from bank/i.test(text)) {
      const cards = after(node, /took from bank/i);
      return { type: "year_of_plenty", player, cards };
    }
    if (player && /\bdiscarded\b/.test(text)) {
      const cards = after(node, /discarded/i);
      return { type: "discard", player, cards };
    }
    if (player && /\bgave\b/.test(text) && /\bgot\b/.test(text) && /\bfrom\b/.test(text)) {
      const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
      const from = spans.length >= 2 ? spans[spans.length - 1].textContent.trim() : null;
      const gave = between(node, /\bgave\b/i, /\band got\b/i);
      const got = between(node, /\band got\b/i, /\bfrom\b/i);
      if (from) return { type: "player_trade", from: player, to: from, gave, got };
    }
    if (player && /\bused\b/.test(text)) return null; // dev-card announcement
    // TODO: Road Building (2 free roads) — capture wording, must not charge cost.
    return null;
  }

  // =========================================================================
  // 4) OVERLAY
  // =========================================================================
  const PANEL_ID = "catan-tracker-panel";
  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);
    const el = document.createElement("div");
    el.id = PANEL_ID;
    el.innerHTML = `
      <style>
        #${PANEL_ID}{position:fixed;top:84px;right:14px;z-index:99999;
          width:236px;font-family:"Segoe UI",system-ui,sans-serif;
          background:rgba(17,21,28,.93);backdrop-filter:blur(6px);
          color:#e8eaed;border:1px solid #2b3340;border-radius:10px;
          box-shadow:0 6px 24px rgba(0,0,0,.45);overflow:hidden;font-size:13px;}
        #${PANEL_ID} .ctt-head{display:flex;align-items:center;justify-content:space-between;
          padding:8px 11px;background:#0e1116;border-bottom:1px solid #2b3340;cursor:move;}
        #${PANEL_ID} .ctt-title{font-weight:600;letter-spacing:.3px;font-size:12px;color:#cdd3db;}
        #${PANEL_ID} .ctt-btn{cursor:pointer;color:#7d8794;font-size:12px;padding:0 4px;user-select:none;}
        #${PANEL_ID} .ctt-btn:hover{color:#e8eaed;}
        #${PANEL_ID} .ctt-body{padding:6px 8px 9px;}
        #${PANEL_ID} .ctt-row{display:flex;align-items:center;gap:6px;padding:4px 3px;border-radius:6px;}
        #${PANEL_ID} .ctt-row + .ctt-row{margin-top:1px;}
        #${PANEL_ID} .ctt-name{flex:0 0 64px;font-weight:600;font-size:12px;
          white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        #${PANEL_ID} .ctt-cards{display:flex;gap:7px;flex:1;justify-content:flex-end;}
        #${PANEL_ID} .ctt-card{display:flex;align-items:center;gap:1px;font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-glyph{font-size:11px;opacity:.85;}
        #${PANEL_ID} .ctt-num{font-size:12px;min-width:8px;text-align:right;color:#e8eaed;}
        #${PANEL_ID} .ctt-num.zero{color:#4b5563;}
        #${PANEL_ID} .ctt-num.range{color:#f0b429;}
        #${PANEL_ID} .ctt-total{flex:0 0 auto;margin-left:5px;font-size:11px;color:#7d8794;
          font-variant-numeric:tabular-nums;}
        #${PANEL_ID} .ctt-empty{padding:14px 10px;color:#7d8794;font-size:12px;text-align:center;line-height:1.5;}
        #${PANEL_ID}.ctt-collapsed .ctt-body{display:none;}
        #${PANEL_ID} .ctt-foot{padding:5px 11px;border-top:1px solid #2b3340;color:#5b6470;font-size:10px;
          display:flex;justify-content:space-between;}
      </style>
      <div class="ctt-head">
        <span class="ctt-title">CARD TRACKER</span>
        <span>
          <span class="ctt-btn" data-act="debug" title="Toggle console debug logging">⚙</span>
          <span class="ctt-btn" data-act="reset" title="Reset counts">⟳</span>
          <span class="ctt-btn" data-act="toggle" title="Collapse">–</span>
        </span>
      </div>
      <div class="ctt-body"><div class="ctt-empty">Waiting for the game log…<br>Play or refresh after a few actions.</div></div>
      <div class="ctt-foot"><span data-foot="status">idle</span><span data-foot="count">0 events</span></div>
    `;
    document.body.appendChild(el);

    // dragging
    const head = el.querySelector(".ctt-head");
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.classList.contains("ctt-btn")) return;
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

    el.querySelector('[data-act="toggle"]').addEventListener("click", () => {
      el.classList.toggle("ctt-collapsed");
      el.querySelector('[data-act="toggle"]').textContent = el.classList.contains("ctt-collapsed") ? "+" : "–";
    });
    el.querySelector('[data-act="reset"]').addEventListener("click", () => {
      if (confirm("Reset all tracked counts? Use this if the tracker started mid-game and is out of sync.")) {
        window.__catanReset && window.__catanReset();
      }
    });
    el.querySelector('[data-act="debug"]').addEventListener("click", () => {
      DEBUG = !DEBUG;
      const btn = el.querySelector('[data-act="debug"]');
      btn.style.color = DEBUG ? "#f0b429" : "";
      console.log("[catan] debug", DEBUG ? "ON — open console to watch parsed events" : "OFF");
    });
    return el;
  }

  function renderPanel(state, meta) {
    const el = buildPanel();
    const body = el.querySelector(".ctt-body");
    const names = Object.keys(state.players);
    el.querySelector('[data-foot="status"]').textContent = meta.status || "tracking";
    el.querySelector('[data-foot="count"]').textContent = meta.events + " events";

    if (!names.length) return;
    let html = "";
    for (const name of names) {
      const p = state.players[name];
      const color = state.colors[name] || "#9aa4b2";
      let cards = "", total = 0, totalMax = 0;
      for (const r of RESOURCES) {
        const lo = p.min[r], hi = p.max[r];
        total += lo; totalMax += hi;
        const exact = lo === hi;
        const cls = exact ? (lo === 0 ? "zero" : "") : "range";
        const val = exact ? String(lo) : `${lo}–${hi}`;
        cards += `<span class="ctt-card"><span class="ctt-glyph">${RESOURCE_GLYPH[r]}</span>` +
                 `<span class="ctt-num ${cls}">${val}</span></span>`;
      }
      const totLabel = total === totalMax ? `${total}` : `${total}–${totalMax}`;
      const display = name.length > 9 ? name.slice(0, 8) + "…" : name;
      html += `<div class="ctt-row">
        <span class="ctt-name" style="color:${color}" title="${name}">${display}</span>
        <span class="ctt-cards">${cards}</span>
        <span class="ctt-total">Σ${totLabel}</span>
      </div>`;
    }
    body.innerHTML = html;
  }

  // =========================================================================
  // 5) OBSERVER  (virtual-scroller aware: dedupe by data-index)
  // =========================================================================
  let state = createState();
  let processed = new Set();   // data-index values already applied
  let eventCount = 0;

  window.__catanReset = function () {
    state = createState();
    processed = new Set();
    eventCount = 0;
    renderPanel(state, { status: "reset", events: 0 });
  };

  function recordColor(node, ev) {
    // remember each player's colonist color for the overlay
    const c = colorOf(node);
    if (!c) return;
    const who = ev.player || ev.from || ev.thief;
    if (who && !state.colors[who]) state.colors[who] = c;
    // also victim span (second colored span), if any
    const spans = node.querySelectorAll('.messagePart-XeUsOgLX span[style*="color"]');
    if (spans.length >= 2 && ev.to) {
      const m = (spans[spans.length - 1].getAttribute("style") || "").match(/color:\s*(#[0-9a-fA-F]{3,6})/);
      if (m && !state.colors[ev.to]) state.colors[ev.to] = m[1];
    }
  }

  function processNode(node) {
    const idx = node.getAttribute("data-index");
    if (idx === null) return;
    if (processed.has(idx)) return;
    processed.add(idx);
    let ev;
    try { ev = parseLogLine(node); } catch (e) {
      if (DEBUG) console.warn("[catan] parse error on", idx, e);
      return;
    }
    if (!ev) {
      if (DEBUG) {
        const t = msgText(node);
        // Only log non-trivial lines (skip separators/empties) to reduce noise.
        if (t) console.log("%c[catan] no-event", "color:#7d8794", `#${idx}`, JSON.stringify(t.slice(0, 80)));
      }
      return;
    }
    recordColor(node, ev);
    applyEvent(state, ev);
    eventCount++;
    if (DEBUG) {
      console.log("%c[catan] event", "color:#5b9bd5", `#${idx}`, ev);
      console.log("%c[catan] hands", "color:#70ad47", snapshotForLog(state));
    }
    renderPanel(state, { status: "tracking", events: eventCount });
  }

  // Compact hands snapshot for console logging.
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

  function scanAll(container) {
    for (const node of container.querySelectorAll(".scrollItemContainer-WXX2rkzf")) processNode(node);
  }

  function start() {
    const container = document.querySelector(".virtualScroller-lSkdkGJi");
    if (!container) return false;
    buildPanel();
    scanAll(container);
    const obs = new MutationObserver(() => scanAll(container));
    obs.observe(container, { childList: true, subtree: true });
    renderPanel(state, { status: "tracking", events: eventCount });
    return true;
  }

  // The log container appears only once a game is loaded. Poll until present.
  const boot = setInterval(() => {
    if (start()) clearInterval(boot);
  }, 1500);

})();
