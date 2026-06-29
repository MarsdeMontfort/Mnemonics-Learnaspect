import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
} from "react";
import JSZip from "jszip";
import initSqlJs from "sql.js";
import { decompress as zstdDecompress } from "fzstd";

/* ===========================================================================
   AnatoMnemonics / Anki Learn Player — single-file React build

   Paste as src/App.js in a CodeSandbox React sandbox.

   Dependencies:
   npm install jszip sql.js fzstd

   Supported uploads:
   1. AnatoMnemonics Learning ZIP
      - learn_manifest.json
      - manifest.json
      - manifest_images.json
      - grouped image folders

   2. Anki package
      - .apkg
      - .akpg typo accepted
      - .zip containing collection.anki2 / collection.anki21 / collection.anki21b

   Supported Anki note/card styles:
   - Basic
   - Basic reversed templates
   - Cloze deletion cards

   Learning behavior:
   - AnatoMnemonics ZIP with practical images:
       Mnemonic MCQ -> Mnemonic Type -> Practical MCQ -> Practical Type
   - Anki cards and mnemonic-only ZIPs:
       MCQ -> Type
   =========================================================================== */

const CONFIG = {
  ROUND_SIZE: 16,
  POOL_TARGET: 12,
  INTRODUCE_BATCH: 5,
};

const AUTO_ADVANCE_MS = 900;

const RUNG_INTERVALS = {
  1: 0,
  2: 7,
  3: 9,
  4: 12,
};

const WRONG_INTERVAL = 3;
const MISTYPED_INTERVAL = 5;

const RUNG = {
  1: { mode: "mcq", image: "mnemonic", label: "Choose" },
  2: { mode: "type", image: "mnemonic", label: "Type" },
  3: { mode: "mcq", image: "practical", label: "Practical · choose" },
  4: { mode: "type", image: "practical", label: "Practical · type" },
};

/* ----------------------------- SOUND ------------------------------------- */

let _ac = null;

function audioCtx() {
  if (typeof window === "undefined") return null;

  if (!_ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) _ac = new AC();
  }

  if (_ac && _ac.state === "suspended") _ac.resume();

  return _ac;
}

function tone(freqs, dur = 0.12, type = "sine", gain = 0.15) {
  const ac = audioCtx();
  if (!ac) return;

  freqs.forEach((f, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();

    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    g.connect(ac.destination);

    const t0 = ac.currentTime + i * dur;

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    o.start(t0);
    o.stop(t0 + dur);
  });
}

const playCorrect = () => tone([660, 880], 0.12, "sine", 0.16);
const playWrong = () => tone([180, 130], 0.16, "square", 0.12);

function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  try {
    window.speechSynthesis.cancel();

    const u = new SpeechSynthesisUtterance(stripAnswerText(text));
    u.rate = 0.95;

    window.speechSynthesis.speak(u);
  } catch (e) {}
}

/* ----------------------------- TEXT / HTML -------------------------------- */

function decodeEntities(s) {
  const input = String(s || "");

  if (typeof document === "undefined") {
    return input
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
  }

  const el = document.createElement("textarea");
  el.innerHTML = input;
  return el.value;
}

function stripAnswerText(s) {
  return decodeEntities(String(s || ""))
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\[sound:[^\]]+\]/gi, " ")
    .replace(/\{\{c\d+::(.*?)(::.*?)?\}\}/gi, "$1")
    .replace(/\u001f/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstNonEmptyLine(s) {
  const text = stripAnswerText(s);

  const lines = text
    .split(/\n+|(?:\s{2,})/)
    .map((x) => x.trim())
    .filter(Boolean);

  return lines[0] || text || "";
}

function cleanAnswerLabel(s, max = 140) {
  const t = stripAnswerText(s)
    .replace(/^answer\s*:\s*/i, "")
    .replace(/^back\s*:\s*/i, "")
    .trim();

  if (t.length <= max) return t;

  const cut = t.slice(0, max).replace(/\s+\S*$/, "");
  return cut + "…";
}

function sanitizeHtml(html) {
  let out = String(html || "");

  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  out = out.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  out = out.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  out = out.replace(/javascript:/gi, "");

  return out;
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|a|an|of|left|right)\b/g, " ")
    .replace(/s\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lev(a, b) {
  const m = a.length;
  const n = b.length;

  if (!m) return n;
  if (!n) return m;

  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);

  for (let j = 0; j <= n; j++) d[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }

  return d[m][n];
}

function acceptedAnswers(item) {
  const out = new Set();

  const add = (value) => {
    if (!value) return;

    if (Array.isArray(value)) {
      value.forEach(add);
      return;
    }

    if (typeof value === "object") {
      add(value.term);
      add(value.name);
      add(value.answer);
      add(value.answerText);
      add(value.primaryAnswer);
      add(value.structureName);
      add(value.anatomicalStructure);
      add(value.label);
      return;
    }

    const t = stripAnswerText(value);
    if (!t) return;

    out.add(t);

    const paren = t.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      const main = stripAnswerText(paren[1]);
      const alias = stripAnswerText(paren[2]);

      if (main) out.add(main);
      if (alias) out.add(alias);
    }

    if (/[;|]/.test(t)) {
      t.split(/[;|]/).forEach((part) => {
        const p = stripAnswerText(part);
        if (p) out.add(p);
      });
    }
  };

  add(item.primaryAnswer);
  add(item.answerText);
  add(item.structureName);
  add(item.anatomicalStructure);
  add(item.term);
  add(item.name);
  add(item.answer);
  add(item.acceptedAnswers);
  add(item.aliases);

  const bc = item.basicCards && item.basicCards[0] && item.basicCards[0].back;
  if (bc)
    String(bc)
      .split(/\n+|<br\s*\/?\s*>/i)
      .forEach(add);

  if (out.size === 0) add(item.promptPreview);

  return [...out].filter(Boolean);
}

function canonicalAnswer(item) {
  const explicit =
    item.answerChoiceLabel ||
    item.primaryAnswer ||
    item.answerText ||
    item.structureName ||
    item.anatomicalStructure ||
    item.term ||
    item.answer;

  const cleaned = cleanAnswerLabel(explicit);

  if (cleaned) return cleaned;

  const a = acceptedAnswers(item);

  return (
    cleanAnswerLabel(a[0]) ||
    item.promptPreview ||
    item.name ||
    item.term ||
    "(unknown)"
  );
}

function gradeTyped(response, accepted) {
  const r = normalize(response);

  if (!r) return { correct: false, matched: null };

  for (const ans of accepted) {
    const a = normalize(ans);

    if (!a) continue;
    if (r === a) return { correct: true, matched: ans };

    const tol = Math.min(3, Math.max(1, Math.floor(a.length * 0.15)));

    if (a.length >= 5 && lev(r, a) <= tol) {
      return { correct: true, matched: ans };
    }
  }

  return { correct: false, matched: null };
}

function shuffle(arr) {
  const a = [...arr];

  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

function buildDistractors(item, allItems, n = 3) {
  const correctSet = new Set(acceptedAnswers(item).map(normalize));
  const myNum = Number(item.cardNumber) || 0;

  const pool = allItems
    .filter((it) => it.cardNumber !== item.cardNumber)
    .map((it) => ({
      label: canonicalAnswer(it),
      dist: Math.abs((Number(it.cardNumber) || 0) - myNum),
    }))
    .filter((x) => x.label && !correctSet.has(normalize(x.label)));

  const seen = new Set();
  const uniq = [];

  for (const x of pool) {
    const key = normalize(x.label);
    if (seen.has(key)) continue;

    seen.add(key);
    uniq.push(x);
  }

  const near = uniq.filter((x) => x.dist <= 8).sort((a, b) => a.dist - b.dist);
  const far = shuffle(uniq.filter((x) => x.dist > 8));

  return [...near, ...far].slice(0, n).map((x) => x.label);
}

/* ----------------------------- ENGINE ------------------------------------ */

function makeItem(card, idx) {
  const maxRung = Number(card.maxRung) || (card.hasRealPractical ? 4 : 2);

  return {
    id: card.cardNumber,
    order: idx,
    card,
    hasPractical: maxRung >= 4,
    maxRung,
    rung: 1,
    status: "dormant",
    duePos: 0,
    lastSeenPos: -999,
    seenCount: 0,
    missCount: 0,
  };
}

function createState(items) {
  return {
    items,
    pos: 0,
    answeredInRound: 0,
    roundIndex: 0,
    history: [],
  };
}

const unmatured = (items) => items.filter((i) => i.status !== "matured");
const activeItems = (items) => items.filter((i) => i.status === "active");

function topUpPool(state) {
  const activeCount = state.items.filter((i) => i.status === "active").length;

  if (activeCount >= CONFIG.POOL_TARGET) return;

  const dormant = state.items
    .filter((i) => i.status === "dormant")
    .sort((a, b) => a.order - b.order);

  const need = Math.min(
    CONFIG.INTRODUCE_BATCH,
    CONFIG.POOL_TARGET - activeCount,
    dormant.length
  );

  for (let k = 0; k < need; k++) {
    dormant[k].status = "active";
    dormant[k].duePos = Math.min(dormant[k].duePos, state.pos);
  }
}

function sortSchedulerItems(a, b) {
  if (a.duePos !== b.duePos) return a.duePos - b.duePos;
  if (a.lastSeenPos !== b.lastSeenPos) return a.lastSeenPos - b.lastSeenPos;
  if (a.rung !== b.rung) return a.rung - b.rung;
  if (a.missCount !== b.missCount) return b.missCount - a.missCount;

  return a.order - b.order;
}

function nextQuestion(state) {
  topUpPool(state);

  const pool = activeItems(state.items);

  if (pool.length === 0) return null;

  let eligible = pool.filter((i) => i.duePos <= state.pos);

  if (eligible.length === 0) {
    topUpPool(state);
    eligible = activeItems(state.items).filter((i) => i.duePos <= state.pos);
  }

  if (eligible.length === 0) {
    eligible = [...pool].sort(sortSchedulerItems);
  } else {
    eligible = [...eligible].sort(sortSchedulerItems);
  }

  const item = eligible[0];
  const rungDef = RUNG[item.rung];

  return {
    item,
    rung: item.rung,
    mode: rungDef.mode,
    image: rungDef.image,
  };
}

function commitOutcome(state, item, outcome) {
  item.lastSeenPos = state.pos;
  item.seenCount += 1;

  state.pos += 1;
  state.answeredInRound += 1;
  state.history.push({ id: item.id, rung: item.rung, outcome });

  let matured = false;

  if (outcome === "correct") {
    if (item.rung >= item.maxRung) {
      item.status = "matured";
      matured = true;
    } else {
      item.rung += 1;
      item.duePos = state.pos + (RUNG_INTERVALS[item.rung] || 0);
    }
  } else if (outcome === "wrong") {
    item.missCount += 1;
    item.rung = Math.max(1, item.rung - 1);
    item.duePos = state.pos + WRONG_INTERVAL;
  } else if (outcome === "mistyped") {
    item.duePos = state.pos + MISTYPED_INTERVAL;
  }

  return {
    matured,
    roundComplete: state.answeredInRound >= CONFIG.ROUND_SIZE,
    allComplete: unmatured(state.items).length === 0,
  };
}

function startNewRound(state) {
  state.answeredInRound = 0;
  state.roundIndex += 1;
}

function progress(state) {
  if (!state || !state.items) return { matured: 0, total: 0 };

  return {
    matured: state.items.filter((i) => i.status === "matured").length,
    total: state.items.length,
  };
}

/* ----------------------------- ZIP HELPERS ------------------------------- */

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;

function cleanPath(p) {
  return String(p || "")
    .replace(/^\.?\//, "")
    .trim();
}

function baseName(p) {
  return cleanPath(p).split("/").pop() || "";
}

function noExt(p) {
  return baseName(p).replace(/\.[^.]+$/, "");
}

function titleFromPath(p) {
  return noExt(p)
    .replace(/^card[\s._-]*\d{1,5}[\s._-]*/i, "")
    .replace(/^\d{1,5}[\s._-]+/, "")
    .replace(
      /\b(mnemonic|masked|mask|question|original|answer|highlighted|raw|edited|normal|front|back|image|img|practical)\b/gi,
      " "
    )
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return "";
}

function asArrayManifest(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.cards)) return raw.cards;
  if (Array.isArray(raw?.items)) return raw.items;
  if (Array.isArray(raw?.entries)) return raw.entries;
  if (Array.isArray(raw?.manifest)) return raw.manifest;

  return [];
}

function getNestedImageField(raw, ...keys) {
  const imgs = raw?.images && typeof raw.images === "object" ? raw.images : {};

  for (const key of keys) {
    const v = raw?.[key] || imgs?.[key];

    if (typeof v === "string" && v.trim()) return v.trim();
  }

  return "";
}

function inferGroupKeyFromImagePath(path) {
  const clean = cleanPath(path);
  const parts = clean.split("/").filter(Boolean);

  if (parts.length > 1) {
    const parent = parts[parts.length - 2];

    if (!/^(images|image|media|assets|export|exports)$/i.test(parent)) {
      return parent;
    }
  }

  const stem = noExt(clean);
  const m = stem.match(/^(\d{1,5})[\s._-]+(.+)$/);

  if (m) {
    const title = titleFromPath(m[2]);
    return `${m[1]} ${title || "card"}`;
  }

  return titleFromPath(clean) || stem;
}

function scoreImagePathForRole(path, role) {
  const s = cleanPath(path).toLowerCase();
  let score = 0;

  const has = (word) => s.includes(word);

  if (role === "mnemonicMasked") {
    if (has("mnemonic")) score += 40;
    if (has("masked") || has("mask")) score += 50;
    if (has("question")) score += 10;
    if (has("answer")) score -= 10;
    if (has("original")) score -= 15;
  }

  if (role === "mnemonicAnswer") {
    if (has("mnemonic")) score += 50;
    if (has("edited")) score += 20;
    if (has("normal") || has("unmasked")) score += 20;
    if (has("answer")) score += 10;
    if (has("masked") || has("mask")) score -= 40;
  }

  if (role === "practicalQuestion") {
    if (has("question") || has("front") || has("original")) score += 45;
    if (has("masked") || has("mask")) score += 10;
    if (has("answer") || has("highlighted")) score -= 35;
    if (has("mnemonic")) score -= 20;
  }

  if (role === "practicalAnswer") {
    if (has("answer") || has("highlighted") || has("back")) score += 50;
    if (has("raw")) score += 15;
    if (has("masked") || has("mask")) score -= 15;
    if (has("mnemonic")) score -= 10;
  }

  if (role === "any") score = 1;

  return score;
}

function pickBestImagePath(paths, role) {
  const scored = paths
    .map((p) => ({ p, score: scoreImagePathForRole(p, role) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.p || "";
}

function findAnkiCollectionEntry(zip) {
  // collection.anki2 is the REAL database only in the oldest (Legacy 1)
  // format. In Legacy 2 / Latest exports it's a compatibility dummy holding
  // the "Please update to the latest Anki version..." note, so it must rank
  // LAST. Prefer the newest real database that's present.
  const rank = {
    "collection.anki21b": 3,
    "collection.anki21": 2,
    "collection.anki2": 1,
  };

  let best = null;
  let bestRank = 0;

  zip.forEach((path, entry) => {
    if (entry.dir) return;

    const base = String(path).split("/").pop();
    const r = rank[base] || 0;

    if (r > bestRank) {
      bestRank = r;
      best = entry;
    }
  });

  return best;
}

/* ----------------------------- ZSTD / PROTOBUF --------------------------- */

function isZstdBytes(b) {
  return (
    b &&
    b.length >= 4 &&
    b[0] === 0x28 &&
    b[1] === 0xb5 &&
    b[2] === 0x2f &&
    b[3] === 0xfd
  );
}

function firstNonWhitespaceByte(b) {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return c;
  }
  return 0;
}

// Minimal protobuf varint reader. Uses arithmetic (not bitwise) so lengths
// above 2^31 are handled correctly. Returns [value, nextPos].
function readVarint(bytes, pos) {
  let result = 0;
  let shift = 0;
  let p = pos;
  let b;

  do {
    b = bytes[p++];
    result += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (b & 0x80);

  return [result, p];
}

// Walk a protobuf message, skipping every field except the length-delimited
// field whose number is `wantField`, returning the list of its raw byte
// sub-slices in order.
function collectLengthDelimitedFields(bytes, wantField) {
  const out = [];
  let pos = 0;

  while (pos < bytes.length) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;

    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x7;

    if (wireType === 0) {
      // varint
      const [, p2] = readVarint(bytes, pos);
      pos = p2;
    } else if (wireType === 1) {
      // 64-bit
      pos += 8;
    } else if (wireType === 5) {
      // 32-bit
      pos += 4;
    } else if (wireType === 2) {
      // length-delimited
      const [len, p2] = readVarint(bytes, pos);
      pos = p2;
      if (fieldNum === wantField) {
        out.push(bytes.subarray(pos, pos + len));
      }
      pos += len;
    } else {
      // group / unknown wire type — bail rather than misread
      break;
    }
  }

  return out;
}

// Read the first varint-typed field with the given number (or null).
function readProtoVarintField(bytes, wantField) {
  let pos = 0;

  while (pos < bytes.length) {
    const [tag, p1] = readVarint(bytes, pos);
    pos = p1;

    const fieldNum = Math.floor(tag / 8);
    const wireType = tag & 0x7;

    if (wireType === 0) {
      const [val, p2] = readVarint(bytes, pos);
      pos = p2;
      if (fieldNum === wantField) return val;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else if (wireType === 2) {
      const [len, p2] = readVarint(bytes, pos);
      pos = p2 + len;
    } else {
      break;
    }
  }

  return null;
}

// Parse the Latest-format `media` manifest (a MediaEntries protobuf):
//   message MediaEntries { repeated MediaEntry entries = 1; }
//   message MediaEntry   { string name = 1; uint32 size = 2; bytes sha1 = 3; }
// Entry order is positional: entries[i] corresponds to the zip file named "i".
function parseMediaEntriesProto(bytes) {
  const decoder = new TextDecoder("utf-8");
  const entryBlobs = collectLengthDelimitedFields(bytes, 1);

  return entryBlobs.map((entryBytes) => {
    const nameBlobs = collectLengthDelimitedFields(entryBytes, 1);
    return nameBlobs.length ? decoder.decode(nameBlobs[0]) : "";
  });
}

/* ----------------------------- ANKI TEMPLATE ----------------------------- */

function splitAnkiFields(flds) {
  return String(flds || "").split("\u001f");
}

function getFieldNames(model) {
  return (model?.flds || [])
    .map((f) => String(f?.name || "").trim())
    .filter(Boolean);
}

function makeFieldMap(model, flds) {
  const names = getFieldNames(model);
  const vals = splitAnkiFields(flds);
  const out = {};

  names.forEach((name, idx) => {
    out[name] = vals[idx] || "";
  });

  return out;
}

function getFieldValue(fieldMap, rawName) {
  const name = String(rawName || "").trim();

  if (!name) return "";

  if (Object.prototype.hasOwnProperty.call(fieldMap, name)) {
    return fieldMap[name] || "";
  }

  const lower = name.toLowerCase();
  const key = Object.keys(fieldMap).find((k) => k.toLowerCase() === lower);

  return key ? fieldMap[key] || "" : "";
}

function fieldNamesUsedInTemplate(tpl, fieldNames) {
  const used = new Set();
  const template = String(tpl || "");

  for (const name of fieldNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const patterns = [
      new RegExp(`{{\\s*${escaped}\\s*}}`, "i"),
      new RegExp(`{{\\s*text:${escaped}\\s*}}`, "i"),
      new RegExp(`{{\\s*type:${escaped}\\s*}}`, "i"),
      new RegExp(`{{\\s*hint:${escaped}\\s*}}`, "i"),
      new RegExp(`{{\\s*#${escaped}\\s*}}`, "i"),
      new RegExp(`{{\\s*\\^${escaped}\\s*}}`, "i"),
    ];

    if (patterns.some((re) => re.test(template))) used.add(name);
  }

  return used;
}

function renderAnkiTemplate(tpl, fieldMap, mediaMap, frontSide = "") {
  let out = String(tpl || "");

  out = out.replace(/{{\s*FrontSide\s*}}/gi, frontSide || "");

  for (let pass = 0; pass < 5; pass++) {
    let changed = false;

    out = out.replace(
      /{{\s*#([^}]+?)\s*}}([\s\S]*?){{\s*\/\1\s*}}/g,
      (_, name, body) => {
        changed = true;
        return stripAnswerText(getFieldValue(fieldMap, name)) ? body : "";
      }
    );

    out = out.replace(
      /{{\s*\^([^}]+?)\s*}}([\s\S]*?){{\s*\/\1\s*}}/g,
      (_, name, body) => {
        changed = true;
        return stripAnswerText(getFieldValue(fieldMap, name)) ? "" : body;
      }
    );

    if (!changed) break;
  }

  out = out.replace(/{{\s*type:([^}]+?)\s*}}/gi, "");
  out = out.replace(/{{\s*hint:([^}]+?)\s*}}/gi, (_, name) => {
    const v = getFieldValue(fieldMap, name);
    return v ? `<span class="anki-hint">${sanitizeHtml(v)}</span>` : "";
  });

  out = out.replace(/{{\s*text:([^}]+?)\s*}}/gi, (_, name) => {
    return stripAnswerText(getFieldValue(fieldMap, name));
  });

  out = out.replace(/{{\s*edit:([^}]+?)\s*}}/gi, (_, name) => {
    return getFieldValue(fieldMap, name);
  });

  out = out.replace(/{{\s*([^}:#^/][^}]*)\s*}}/g, (_, rawName) => {
    return getFieldValue(fieldMap, rawName);
  });

  return processAnkiMedia(sanitizeHtml(out), mediaMap);
}

function processAnkiMedia(html, mediaMap) {
  let out = String(html || "");

  const lookup = (raw) => {
    const name = decodeEntities(String(raw || "").trim());

    if (!name) return "";

    return (
      mediaMap[name] ||
      mediaMap[baseName(name)] ||
      mediaMap[decodeURIComponentSafe(name)] ||
      mediaMap[decodeURIComponentSafe(baseName(name))] ||
      ""
    );
  };

  out = out.replace(/src=(["'])(.*?)\1/gi, (m, quote, src) => {
    if (/^(data:|blob:|https?:)/i.test(src)) return m;

    const u = lookup(src);

    return u ? `src=${quote}${u}${quote}` : m;
  });

  out = out.replace(/\[sound:([^\]]+)\]/gi, (_, filename) => {
    const u = lookup(filename);
    const label = sanitizeHtml(filename);

    if (!u) return `<span class="sound-chip">🔊 ${label}</span>`;

    return `<audio controls src="${u}" class="anki-audio"></audio>`;
  });

  return sanitizeHtml(out);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function pickAnswerForTemplate(fieldMap, model, qfmt, afmt) {
  const fieldNames = getFieldNames(model);
  const used = fieldNamesUsedInTemplate(qfmt, fieldNames);
  const available = fieldNames.filter((name) =>
    stripAnswerText(fieldMap[name])
  );

  const notQuestion = available.filter((name) => !used.has(name));

  const badAnswerNames = new Set([
    "extra",
    "extras",
    "source",
    "sources",
    "reference",
    "references",
    "notes",
    "note",
    "tags",
    "lecture",
    "explanation",
    "explanations",
  ]);

  const priority = [
    "Back",
    "Answer",
    "Answers",
    "Definition",
    "Name",
    "Term",
    "Structure",
    "Front",
  ];

  const usableNotQuestion = notQuestion.filter(
    (name) => !badAnswerNames.has(name.trim().toLowerCase())
  );

  for (const p of priority) {
    const hit = usableNotQuestion.find(
      (name) => name.toLowerCase() === p.toLowerCase()
    );
    if (hit) return fieldMap[hit];
  }

  if (usableNotQuestion.length) return fieldMap[usableNotQuestion[0]];

  for (const p of priority) {
    const hit = available.find(
      (name) => name.toLowerCase() === p.toLowerCase()
    );
    if (hit) return fieldMap[hit];
  }

  const afmtText = stripAnswerText(afmt);
  const qfmtText = stripAnswerText(qfmt);

  if (afmtText && afmtText !== qfmtText) return afmt;

  return available.length ? fieldMap[available[0]] : "";
}

/* ----------------------------- CLOZE ------------------------------------- */

const CLOZE_RE = /{{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?}}/gi;

function extractClozeNumbers(text) {
  const nums = new Set();
  let m;

  CLOZE_RE.lastIndex = 0;

  while ((m = CLOZE_RE.exec(String(text || "")))) {
    nums.add(Number(m[1]));
  }

  return [...nums].sort((a, b) => a - b);
}

function extractClozeAnswers(text, target) {
  const answers = [];
  let m;

  CLOZE_RE.lastIndex = 0;

  while ((m = CLOZE_RE.exec(String(text || "")))) {
    const n = Number(m[1]);
    const answer = stripAnswerText(m[2]);

    if (n === target && answer) answers.push(answer);
  }

  return answers;
}

function renderClozePrompt(text, target, mediaMap) {
  let out = String(text || "");

  out = out.replace(CLOZE_RE, (_, nRaw, answerRaw, hintRaw) => {
    const n = Number(nRaw);

    if (n === target) {
      const hint = stripAnswerText(hintRaw);

      return `<span class="cloze-blank">${
        hint ? `[${sanitizeHtml(hint)}]` : "[...]"
      }</span>`;
    }

    return `<span class="cloze-shown">${sanitizeHtml(answerRaw)}</span>`;
  });

  return processAnkiMedia(sanitizeHtml(out), mediaMap);
}

function renderClozeAnswer(text, target, extraHtml, mediaMap) {
  let out = String(text || "");

  out = out.replace(CLOZE_RE, (_, nRaw, answerRaw) => {
    const n = Number(nRaw);

    if (n === target) {
      return `<span class="cloze-answer">${sanitizeHtml(answerRaw)}</span>`;
    }

    return `<span class="cloze-shown">${sanitizeHtml(answerRaw)}</span>`;
  });

  if (extraHtml && stripAnswerText(extraHtml)) {
    out += `<hr class="answer-hr" />${extraHtml}`;
  }

  return processAnkiMedia(sanitizeHtml(out), mediaMap);
}

/* ----------------------------- ANKI INGEST ------------------------------- */

let SQL_PROMISE = null;

async function fetchWasmBinary() {
  const urls = [
    "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm",
    "https://sql.js.org/dist/sql-wasm.wasm",
    "https://unpkg.com/sql.js@1.13.0/dist/sql-wasm.wasm",
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      lastErr = e;
      console.warn(`[sql.js] wasm fetch failed from ${url}:`, e.message);
    }
  }

  throw new Error(
    `Could not download sql-wasm.wasm from any CDN (last error: ${
      lastErr ? lastErr.message : "unknown"
    }). If you're offline or the sandbox blocks outbound requests, host the wasm locally instead.`
  );
}

function getSqlJs() {
  if (!SQL_PROMISE) {
    SQL_PROMISE = (async () => {
      const wasmBinary = await fetchWasmBinary();
      // Passing wasmBinary skips Emscripten's internal streaming fetch,
      // which sidesteps the MIME-type / instantiateStreaming failure that
      // produces "both async and sync fetching of the wasm failed".
      return initSqlJs({ wasmBinary });
    })();
  }

  return SQL_PROMISE;
}

async function buildMediaMap(zip) {
  const mediaEntry = zip.file("media");
  const mediaMap = {};

  if (!mediaEntry) return mediaMap;

  let raw = new Uint8Array(await mediaEntry.async("arraybuffer"));

  // Defensive: some exports may zstd-compress the manifest. (Normally only the
  // database is compressed, but checking is cheap and avoids a silent miss.)
  if (isZstdBytes(raw)) {
    try {
      raw = zstdDecompress(raw);
    } catch (e) {
      console.warn("[media] failed to zstd-decompress manifest:", e.message);
    }
  }

  // Build index -> original filename.
  // Legacy format: JSON object { "0": "name.png", ... }  (starts with '{')
  // Latest format: protobuf MediaEntries, positional               (starts with 0x0A)
  let nameByIndex = [];

  if (firstNonWhitespaceByte(raw) === 0x7b /* { */) {
    try {
      const json = JSON.parse(new TextDecoder("utf-8").decode(raw));
      for (const [k, v] of Object.entries(json)) {
        nameByIndex[Number(k)] = String(v);
      }
    } catch (e) {
      console.warn("[media] failed to parse legacy JSON manifest:", e.message);
    }
  } else {
    try {
      nameByIndex = parseMediaEntriesProto(raw);
    } catch (e) {
      console.warn("[media] failed to parse protobuf manifest:", e.message);
    }
  }

  for (let i = 0; i < nameByIndex.length; i++) {
    const originalName = nameByIndex[i];
    if (!originalName) continue;

    const entry = zip.file(String(i));
    if (!entry || entry.dir) continue;

    let fileBytes = await entry.async("uint8array");

    // Individual media files are uncompressed in every format; defensive check.
    if (isZstdBytes(fileBytes)) {
      try {
        fileBytes = zstdDecompress(fileBytes);
      } catch (e) {}
    }

    const url = URL.createObjectURL(new Blob([fileBytes]));

    mediaMap[originalName] = url;
    mediaMap[baseName(originalName)] = url;
    mediaMap[decodeURIComponentSafe(originalName)] = url;
    mediaMap[decodeURIComponentSafe(baseName(originalName))] = url;
    mediaMap[String(i)] = url;
  }

  return mediaMap;
}

function rowsFromExec(result) {
  if (!result || !result[0]) return [];

  const { columns, values } = result[0];

  return values.map((row) => {
    const obj = {};

    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });

    return obj;
  });
}

function isClozeModel(model) {
  if (!model) return false;

  if (Number(model.type) === 1) return true;

  const name = String(model.name || "").toLowerCase();

  return name.includes("cloze");
}

function toUint8(v) {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return new Uint8Array(v);
  if (v.buffer) return new Uint8Array(v.buffer);
  return new Uint8Array(0);
}

function getTableNames(db) {
  try {
    const r = rowsFromExec(
      db.exec("SELECT name FROM sqlite_master WHERE type='table'")
    );
    return new Set(r.map((x) => String(x.name)));
  } catch (e) {
    return new Set();
  }
}

// Deck id -> full "::" path name, from the v15+/v18 `decks` table when present,
// otherwise from the legacy col.decks JSON map (schema v11).
function readDeckNames(db, tableList) {
  const names = {};
  const tables = new Set(tableList || []);

  // v18 stores the hierarchy with the unit separator (\u001f); legacy JSON
  // uses "::". Normalize both to "::" so buildStudyStructure can split on it.
  const norm = (s) => String(s || "").replace(/\u001f/g, "::");

  if (tables.has("decks")) {
    try {
      const rows = rowsFromExec(db.exec("SELECT id, name FROM decks"));
      for (const r of rows) names[String(r.id)] = norm(r.name);
    } catch (e) {}
  }

  if (Object.keys(names).length === 0) {
    try {
      const colRows = rowsFromExec(db.exec("SELECT decks FROM col LIMIT 1"));
      const json = JSON.parse((colRows[0] && colRows[0].decks) || "{}");
      for (const [id, d] of Object.entries(json)) {
        names[String(id)] = norm(d && d.name);
      }
    } catch (e) {}
  }

  return names;
}

// NotetypeConfig protobuf: field 1 = kind (0 = normal, 1 = cloze).
function readNotetypeKind(configBlob) {
  const bytes = toUint8(configBlob);
  if (!bytes.length) return 0;

  const kind = readProtoVarintField(bytes, 1);
  return kind === null ? 0 : kind;
}

// CardTemplateConfig protobuf: field 1 = q_format, field 2 = a_format.
function readTemplateFormats(configBlob) {
  const bytes = toUint8(configBlob);
  if (!bytes.length) return { qfmt: "", afmt: "" };

  const decoder = new TextDecoder("utf-8");
  const q = collectLengthDelimitedFields(bytes, 1);
  const a = collectLengthDelimitedFields(bytes, 2);

  return {
    qfmt: q.length ? decoder.decode(q[0]) : "",
    afmt: a.length ? decoder.decode(a[0]) : "",
  };
}

// Rebuild the JSON-style `models` map your pipeline expects from the v18
// `notetypes` / `fields` / `templates` tables. Field names are plain columns;
// only the cloze flag and template formats come from protobuf `config` blobs.
function buildModelsFromV18(db) {
  const models = {};

  const ntRows = rowsFromExec(
    db.exec("SELECT id, name, config FROM notetypes")
  );

  for (const nt of ntRows) {
    models[String(nt.id)] = {
      id: nt.id,
      name: String(nt.name || ""),
      type: readNotetypeKind(nt.config),
      flds: [],
      tmpls: [],
    };
  }

  const fldRows = rowsFromExec(
    db.exec("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord")
  );

  for (const f of fldRows) {
    const m = models[String(f.ntid)];
    if (!m) continue;

    m.flds[Number(f.ord)] = {
      name: String(f.name || ""),
      ord: Number(f.ord),
    };
  }

  const tmplRows = rowsFromExec(
    db.exec("SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord")
  );

  for (const t of tmplRows) {
    const m = models[String(t.ntid)];
    if (!m) continue;

    const { qfmt, afmt } = readTemplateFormats(t.config);

    m.tmpls[Number(t.ord)] = {
      name: String(t.name || `Card ${Number(t.ord) + 1}`),
      ord: Number(t.ord),
      qfmt,
      afmt,
    };

    if (!stripAnswerText(qfmt) && !isClozeModel(m)) {
      console.warn(
        `[notetype] empty template for "${m.name}" — q/a protobuf may not have parsed`
      );
    }
  }

  // Drop holes left by sparse ord indexing.
  for (const id of Object.keys(models)) {
    models[id].flds = models[id].flds.filter(Boolean);
    models[id].tmpls = models[id].tmpls.filter(Boolean);
  }

  return models;
}

async function ingestAnkiPackageFromZip(zip) {
  const collectionEntry = findAnkiCollectionEntry(zip);

  if (!collectionEntry) {
    throw new Error("This file does not contain an Anki collection database.");
  }

  const [SQL, mediaMap] = await Promise.all([getSqlJs(), buildMediaMap(zip)]);
  const buffer = await collectionEntry.async("arraybuffer");
  let bytes = new Uint8Array(buffer);

  // collection.anki21b is a zstd-compressed SQLite DB. Detect by zstd magic
  // bytes rather than filename, then inflate before sql.js opens it.
  const wasZstd = isZstdBytes(bytes);
  if (wasZstd) {
    bytes = zstdDecompress(bytes);
  }

  // A real SQLite file begins with the 16-byte header "SQLite format 3\0".
  // If this fails, the bytes we're handing sql.js aren't a database — usually
  // a decompression or file-selection problem, not a schema problem.
  const looksLikeSqlite =
    bytes.length >= 16 &&
    bytes[0] === 0x53 &&
    bytes[1] === 0x51 &&
    bytes[2] === 0x4c &&
    bytes[3] === 0x69 &&
    bytes[4] === 0x74 &&
    bytes[5] === 0x65;

  if (!looksLikeSqlite) {
    throw new Error(
      `The selected collection "${collectionEntry.name}" is not a valid ` +
        `SQLite database after reading (zstd-compressed: ${wasZstd}, ` +
        `decoded ${bytes.length} bytes). Decompression or file selection ` +
        `failed. Please share this line.`
    );
  }

  const db = new SQL.Database(bytes);

  let models = {};
  let notes = [];
  let deckNames = {};
  const cardDeckByNote = new Map();
  const firstDidByNote = new Map();

  const diag = {
    file: collectionEntry.name,
    wasZstd,
    bytes: bytes.length,
    schemaVer: null,
    tables: [],
    notetypeCount: null,
    noteCount: null,
  };

  try {
    const tables = getTableNames(db);
    diag.tables = [...tables];

    try {
      const verRows = rowsFromExec(db.exec("SELECT ver FROM col LIMIT 1"));
      diag.schemaVer = verRows.length ? verRows[0].ver : null;
    } catch (e) {}

    if (
      tables.has("notetypes") &&
      tables.has("fields") &&
      tables.has("templates")
    ) {
      // Schema v18 (Latest export): note types live in dedicated tables;
      // col.models is empty here.
      models = buildModelsFromV18(db);
      diag.notetypeCount = Object.keys(models).length;
    }

    if (Object.keys(models).length === 0) {
      // Legacy schema (v11): note types are a JSON map in col.models.
      let colModelsJson = "{}";

      try {
        const colRows = rowsFromExec(db.exec("SELECT models FROM col LIMIT 1"));
        if (colRows.length) colModelsJson = colRows[0].models || "{}";
      } catch (e) {}

      try {
        models = JSON.parse(colModelsJson);
        diag.notetypeCount = Object.keys(models).length;
      } catch (e) {
        models = {};
      }
    }

    try {
      const cntRows = rowsFromExec(db.exec("SELECT COUNT(*) AS n FROM notes"));
      diag.noteCount = cntRows.length ? cntRows[0].n : null;
    } catch (e) {}

    console.log("[Anki ingest] diagnostics:", diag);

    // An empty exported collection is a real, distinct case — not a parse
    // failure. Report it plainly instead of blaming note-type reading.
    if (diag.noteCount === 0) {
      throw new Error(
        `This deck appears to be empty — the exported collection ` +
          `"${diag.file}" contains 0 notes (schema v${diag.schemaVer}). ` +
          `Open the deck in Anki and confirm it actually has cards, and that ` +
          `you're exporting the deck that contains them, then re-export.`
      );
    }

    if (!models || Object.keys(models).length === 0) {
      throw new Error(
        `The deck has ${diag.noteCount} notes, but no note types could be ` +
          `read. Diagnostics — schemaVer: ${diag.schemaVer}, ` +
          `tables: [${diag.tables.join(", ")}]. Please share this line.`
      );
    }

    notes = rowsFromExec(
      db.exec("SELECT id, guid, mid, flds, tags FROM notes ORDER BY id")
    );

    deckNames = readDeckNames(db, diag.tables);

    // A note can spawn several cards (cloze c1/c2/c3, Basic + reversed), and
    // occasionally they sit in different decks — so map deck by card ordinal,
    // keeping the first card's deck as a fallback.
    const cardRows = rowsFromExec(db.exec("SELECT nid, ord, did FROM cards"));
    for (const cr of cardRows) {
      const nid = String(cr.nid);
      const ord = Number(cr.ord);
      const did = String(cr.did);

      let m = cardDeckByNote.get(nid);
      if (!m) {
        m = new Map();
        cardDeckByNote.set(nid, m);
      }
      m.set(ord, did);

      if (!firstDidByNote.has(nid)) firstDidByNote.set(nid, did);
    }
  } finally {
    db.close();
  }

  const cards = [];
  let cardNo = 1;

  for (const note of notes) {
    const model = models[String(note.mid)];
    if (!model) continue;

    const fieldMap = makeFieldMap(model, note.flds);
    const fieldNames = getFieldNames(model);

    const nidStr = String(note.id);
    const noteTags = String(note.tags || "")
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const ordToDid = cardDeckByNote.get(nidStr);
    const fallbackDid = firstDidByNote.get(nidStr) || "1";
    const deckFor = (ord) => {
      const did = (ordToDid && ordToDid.get(ord)) || fallbackDid;
      return { deckId: did, deckName: deckNames[did] || "Default" };
    };

    if (isClozeModel(model)) {
      const textFieldName =
        fieldNames.find((x) => x.toLowerCase() === "text") ||
        fieldNames.find((x) => /text|cloze|prompt|front/i.test(x)) ||
        fieldNames[0];

      const extraFieldName =
        fieldNames.find((x) => x.toLowerCase() === "extra") ||
        fieldNames.find((x) => /extra|explanation|notes?/i.test(x));

      const textHtml = fieldMap[textFieldName] || "";
      const extraHtml = extraFieldName ? fieldMap[extraFieldName] || "" : "";

      const nums = extractClozeNumbers(textHtml);

      for (const n of nums) {
        const answers = extractClozeAnswers(textHtml, n);
        const joinedAnswer = answers.join("; ");
        const promptHtml = renderClozePrompt(textHtml, n, mediaMap);
        const answerHtml = renderClozeAnswer(textHtml, n, extraHtml, mediaMap);

        if (!joinedAnswer || !stripAnswerText(promptHtml)) continue;

        // Cloze card ordinal is the cloze number minus one.
        const { deckId, deckName } = deckFor(n - 1);

        cards.push({
          cardNumber: cardNo++,
          sourceType: "anki-cloze",
          sourceLabel: "Anki cloze",
          promptPreview: stripAnswerText(promptHtml),
          promptHtml,
          answerHtml,
          primaryAnswer: joinedAnswer,
          answerText: joinedAnswer,
          answerChoiceLabel: cleanAnswerLabel(joinedAnswer),
          acceptedAnswers: [joinedAnswer],
          aliases: [],
          maxRung: 2,
          hasRealPractical: false,
          rawNoteId: note.id,
          rawModelName: model.name,
          deckId,
          deckName,
          tags: noteTags,
        });
      }

      continue;
    }

    const templates =
      Array.isArray(model.tmpls) && model.tmpls.length
        ? model.tmpls
        : [
            {
              name: "Card 1",
              qfmt: "{{Front}}",
              afmt: "{{FrontSide}}<hr id=answer>{{Back}}",
            },
          ];

    for (let ti = 0; ti < templates.length; ti++) {
      const tmpl = templates[ti];
      const tmplOrd = Number.isInteger(tmpl.ord) ? tmpl.ord : ti;

      const qfmt = tmpl.qfmt || "";
      const afmt = tmpl.afmt || "";

      const frontHtml = renderAnkiTemplate(qfmt, fieldMap, mediaMap, "");
      const answerSide = renderAnkiTemplate(
        afmt,
        fieldMap,
        mediaMap,
        frontHtml
      );

      let rawAnswer = pickAnswerForTemplate(fieldMap, model, qfmt, afmt);
      let primary = firstNonEmptyLine(rawAnswer);

      if (!primary) {
        primary = firstNonEmptyLine(answerSide);
      }

      const promptText = stripAnswerText(frontHtml);
      const answerText = stripAnswerText(answerSide);

      if (!promptText || !primary) continue;

      const { deckId, deckName } = deckFor(tmplOrd);

      cards.push({
        cardNumber: cardNo++,
        sourceType: "anki-basic",
        sourceLabel: "Anki basic",
        promptPreview: promptText,
        promptHtml: frontHtml,
        answerHtml: answerSide,
        primaryAnswer: primary,
        answerText: primary,
        answerChoiceLabel: cleanAnswerLabel(primary),
        acceptedAnswers: [primary, answerText].filter(Boolean),
        aliases: [],
        maxRung: 2,
        hasRealPractical: false,
        rawNoteId: note.id,
        rawModelName: model.name,
        rawTemplateName: tmpl.name,
        deckId,
        deckName,
        tags: noteTags,
      });
    }
  }

  if (!cards.length) {
    throw new Error(
      "No usable Basic or Cloze cards were found in this Anki package."
    );
  }

  return cards;
}

/* ----------------------- ANATOMNEMONICS ZIP INGEST ----------------------- */

async function ingestLearningZipFromZip(zip) {
  const byPath = {};
  const byBase = {};
  const imagePaths = [];
  const jsonEntries = [];

  zip.forEach((path, entry) => {
    if (entry.dir) return;

    const clean = cleanPath(path);

    byPath[clean] = entry;
    byBase[baseName(clean)] = entry;

    if (IMAGE_EXT_RE.test(clean)) imagePaths.push(clean);
    if (/\.json$/i.test(clean)) jsonEntries.push({ path: clean, entry });
  });

  const urlFor = async (...candidates) => {
    const flat = candidates.flat().filter(Boolean);

    for (const rawName of flat) {
      const name = cleanPath(rawName);

      if (/^(data:image\/|blob:|https?:\/\/)/i.test(name)) return name;

      const entry = byPath[name] || byBase[baseName(name)];

      if (entry) return URL.createObjectURL(await entry.async("blob"));
    }

    return null;
  };

  const readJsonEntry = async (entry) => {
    const text = await entry.async("string");
    return JSON.parse(text);
  };

  const preferredJson =
    jsonEntries.find((x) =>
      /(^|\/)(learn_manifest|anatomnemonics_learn_manifest|anatomenmonics_learn_manifest|manifest_learn)\.json$/i.test(
        x.path
      )
    ) ||
    jsonEntries.find((x) => /(^|\/)manifest\.json$/i.test(x.path)) ||
    jsonEntries.find((x) => /(^|\/)manifest_images\.json$/i.test(x.path));

  if (preferredJson) {
    const rawManifest = await readJsonEntry(preferredJson.entry);
    const rows = asArrayManifest(rawManifest);

    if (!rows.length) {
      throw new Error(`${preferredJson.path} exists but contains zero cards.`);
    }

    const cards = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i] || {};
      const imgs =
        raw.images && typeof raw.images === "object" ? raw.images : {};

      const structureName = firstString(
        raw.structureName,
        raw.anatomicalStructure,
        raw.term,
        raw.name,
        raw.answer,
        raw.answerText,
        raw.promptPreview,
        raw.basicCards?.[0]?.back
      );

      const imageFile = getNestedImageField(
        raw,
        "imageFile",
        "image",
        "mainImage",
        "mnemonic"
      );

      const imageFileB = getNestedImageField(
        raw,
        "imageFileB",
        "practical",
        "practicalImage"
      );

      const mnemonicMaskedFile = getNestedImageField(
        raw,
        "mnemonicMasked",
        "mnemonicMaskedFile",
        "practicalMnemonicMasked",
        "practicalMnemonicMaskedFile",
        "maskedMnemonic",
        "maskedMnemonicFile",
        "mnemonicQuestion",
        "mnemonicQuestionFile"
      );

      const mnemonicAnswerFile = getNestedImageField(
        raw,
        "mnemonicAnswer",
        "mnemonicAnswerFile",
        "mnemonicImageFile",
        "practicalMnemonic",
        "practicalMnemonicFile",
        "editedMnemonic",
        "editedMnemonicFile",
        "practicalEditedAnswerImageFile"
      );

      const practicalQuestionFile = getNestedImageField(
        raw,
        "practicalQuestion",
        "practicalQuestionFile",
        "question",
        "questionImageFile",
        "original",
        "originalImageFile",
        "practicalOriginal",
        "practicalOriginalFile",
        "practicalOriginalMasked",
        "practicalOriginalMaskedFile",
        "questionMasked",
        "questionMaskedFile",
        "originalMasked",
        "originalMaskedFile"
      );

      const practicalAnswerFile = getNestedImageField(
        raw,
        "practicalAnswer",
        "practicalAnswerFile",
        "answer",
        "answerImageFile",
        "practicalAnswerImageFile",
        "rawAnswer",
        "rawAnswerImageFile",
        "highlightedAnswer",
        "highlightedAnswerImageFile"
      );

      const practicalAnswerMaskedFile = getNestedImageField(
        raw,
        "practicalAnswerMasked",
        "practicalAnswerMaskedFile"
      );

      const allImageFileRefs = [
        ...Object.values(imgs).filter((v) => typeof v === "string"),
        raw.imageFile,
        raw.imageFileB,
        raw.questionImageFile,
        raw.originalImageFile,
        raw.answerImageFile,
        raw.mnemonicImageFile,
        raw.mnemonicMaskedFile,
        raw.practicalMnemonicMaskedFile,
        raw.practicalAnswerMaskedFile,
        raw.practicalOriginalMaskedFile,
      ].filter(Boolean);

      const mnemonicUrl =
        (await urlFor(mnemonicMaskedFile)) ||
        (await urlFor(imageFile)) ||
        (await urlFor(mnemonicAnswerFile)) ||
        (await urlFor(practicalQuestionFile));

      const mnemonicAnswerUrl =
        (await urlFor(mnemonicAnswerFile)) ||
        (await urlFor(imageFile)) ||
        mnemonicUrl;

      const realPracticalQuestionUrl =
        (await urlFor(practicalQuestionFile)) || (await urlFor(imageFileB));

      const realPracticalAnswerUrl =
        (await urlFor(practicalAnswerFile)) ||
        (await urlFor(practicalAnswerMaskedFile)) ||
        (await urlFor(imageFileB));

      const practicalUrl = realPracticalQuestionUrl || mnemonicUrl;
      const practicalAnswerUrl = realPracticalAnswerUrl || practicalUrl;

      const allImageUrls = [];

      for (const ref of allImageFileRefs) {
        const u = await urlFor(ref);

        if (u && !allImageUrls.includes(u)) allImageUrls.push(u);
      }

      if (!structureName) {
        console.warn(
          "[Learning ZIP] Skipping card with no structure name:",
          raw
        );
        continue;
      }

      if (!mnemonicUrl && !practicalUrl) {
        console.warn("[Learning ZIP] Skipping card with no usable image:", raw);
        continue;
      }

      const hasRealPractical = Boolean(
        realPracticalQuestionUrl || realPracticalAnswerUrl
      );

      cards.push({
        cardNumber: Number(raw.cardNumber ?? raw.id ?? i + 1),
        sourceType: "anatomnemonics-zip",
        sourceLabel: "Learning ZIP",
        promptPreview: structureName,
        basicCards: raw.basicCards || [
          {
            front:
              raw.question || raw.prompt || "Identify the labeled structure.",
            back: structureName,
          },
        ],
        practicalPropSummary: raw.practicalPropSummary || raw.context || "",
        structureName,
        anatomicalStructure: structureName,
        term: structureName,
        answer: structureName,
        answerText: structureName,
        primaryAnswer: structureName,
        acceptedAnswers: raw.acceptedAnswers || raw.aliases || [],
        aliases: raw.aliases || [],
        mnemonicUrl,
        mnemonicAnswerUrl,
        practicalUrl,
        practicalAnswerUrl,
        hasRealPractical,
        maxRung: hasRealPractical ? 4 : 2,
        allImageUrls,
        rawManifestRow: raw,
      });
    }

    cards.sort((a, b) => Number(a.cardNumber) - Number(b.cardNumber));

    if (!cards.length) {
      throw new Error(
        `${preferredJson.path} was found, but no usable Learn cards could be created. Each row needs a structure name and at least one image.`
      );
    }

    return cards;
  }

  if (imagePaths.length) {
    const groups = new Map();

    for (const path of imagePaths) {
      const key = inferGroupKeyFromImagePath(path);

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(path);
    }

    const cards = [];
    let idx = 1;

    for (const [groupKey, paths] of groups.entries()) {
      const structureName = titleFromPath(groupKey) || groupKey;

      const mnemonicMaskedPath = pickBestImagePath(paths, "mnemonicMasked");
      const mnemonicAnswerPath = pickBestImagePath(paths, "mnemonicAnswer");
      const practicalQuestionPath = pickBestImagePath(
        paths,
        "practicalQuestion"
      );
      const practicalAnswerPath = pickBestImagePath(paths, "practicalAnswer");
      const fallbackPath = paths[0];

      const mnemonicUrl =
        (await urlFor(mnemonicMaskedPath)) ||
        (await urlFor(mnemonicAnswerPath)) ||
        (await urlFor(fallbackPath));

      const mnemonicAnswerUrl =
        (await urlFor(mnemonicAnswerPath)) ||
        (await urlFor(mnemonicMaskedPath)) ||
        mnemonicUrl;

      const realPracticalUrl = (await urlFor(practicalQuestionPath)) || null;

      const realPracticalAnswerUrl =
        (await urlFor(practicalAnswerPath)) || null;

      const practicalUrl = realPracticalUrl || mnemonicUrl;
      const practicalAnswerUrl = realPracticalAnswerUrl || practicalUrl;

      const allImageUrls = [];

      for (const p of paths) {
        const u = await urlFor(p);

        if (u) allImageUrls.push(u);
      }

      const hasRealPractical = Boolean(
        realPracticalUrl || realPracticalAnswerUrl
      );

      cards.push({
        cardNumber: idx++,
        sourceType: "anatomnemonics-zip",
        sourceLabel: "Learning ZIP",
        promptPreview: structureName,
        basicCards: [
          {
            front: "Identify the labeled structure.",
            back: structureName,
          },
        ],
        structureName,
        anatomicalStructure: structureName,
        term: structureName,
        answer: structureName,
        answerText: structureName,
        primaryAnswer: structureName,
        acceptedAnswers: [],
        aliases: [],
        practicalPropSummary: "",
        mnemonicUrl,
        mnemonicAnswerUrl,
        practicalUrl,
        practicalAnswerUrl,
        hasRealPractical,
        maxRung: hasRealPractical ? 4 : 2,
        allImageUrls,
        rawImagePaths: paths,
      });
    }

    if (cards.length) return cards;
  }

  throw new Error(
    "No usable Learn data found. Expected learn_manifest.json, manifest.json, manifest_images.json, grouped image files, or an Anki collection database."
  );
}

/* ----------------------------- MASTER INGEST ----------------------------- */

async function ingestFile(file) {
  if (!file) return [];

  const lower = String(file.name || "").toLowerCase();

  if (
    !lower.endsWith(".zip") &&
    !lower.endsWith(".apkg") &&
    !lower.endsWith(".akpg")
  ) {
    throw new Error("Please upload a .zip, .apkg, or .akpg file.");
  }

  const zip = await JSZip.loadAsync(file);
  const collectionEntry = findAnkiCollectionEntry(zip);

  if (collectionEntry) {
    return ingestAnkiPackageFromZip(zip);
  }

  return ingestLearningZipFromZip(zip);
}

/* ----------------------------- APP --------------------------------------- */

const UNTAGGED = "__untagged__";

// Build the deck tree and tag list used by the pre-study selection screen.
// Deck hierarchy is encoded in names with "::", mirroring Anki.
function buildStudyStructure(cards) {
  const deckIdToName = new Map();
  const deckCount = new Map();
  const tagCount = new Map();
  let untaggedCount = 0;

  for (const c of cards) {
    const did = c.deckId || "1";
    deckIdToName.set(did, c.deckName || "Default");
    deckCount.set(did, (deckCount.get(did) || 0) + 1);

    const tags = c.tags || [];
    if (tags.length === 0) untaggedCount += 1;
    for (const t of tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  }

  const nodes = new Map();
  const childSet = new Set();

  const ensureNode = (fullName) => {
    if (nodes.has(fullName)) return nodes.get(fullName);

    const parts = fullName.split("::");
    const node = {
      fullName,
      name: (parts[parts.length - 1] || fullName).trim() || "(unnamed)",
      depth: parts.length - 1,
      children: [],
      deckId: null,
      directCount: 0,
      totalCount: 0,
    };
    nodes.set(fullName, node);

    if (parts.length > 1) {
      const parent = ensureNode(parts.slice(0, -1).join("::"));
      parent.children.push(node);
      childSet.add(fullName);
    }

    return node;
  };

  for (const [did, name] of deckIdToName) {
    const node = ensureNode(name || "Default");
    node.deckId = did;
    node.directCount = deckCount.get(did) || 0;
  }

  const computeTotals = (node) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    let total = node.directCount;
    for (const ch of node.children) total += computeTotals(ch);
    node.totalCount = total;
    return total;
  };

  const roots = [...nodes.values()]
    .filter((n) => !childSet.has(n.fullName))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const r of roots) computeTotals(r);

  const tagList = [...tagCount.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    roots,
    allDeckIds: [...deckIdToName.keys()],
    tagList,
    untaggedCount,
    totalCards: cards.length,
    hasStructure: deckIdToName.size > 1 || tagList.length > 0,
  };
}

export default function App() {
  const [phase, setPhase] = useState("upload");
  const [error, setError] = useState("");
  const [stats, setStats] = useState(null);
  const [structure, setStructure] = useState(null);
  const stateRef = useRef(null);
  const qidRef = useRef(0);
  const [q, setQ] = useState(null);
  const [, setTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState({
    sound: true,
    speak: false,
    autoAdvance: true,
  });

  const decorate = (qd, allCards) => {
    if (!qd) return null;

    const card = qd.item.card;
    const accepted = acceptedAnswers(card);
    const correct = canonicalAnswer(card);
    const isAnki = String(card.sourceType || "").startsWith("anki");

    const image = isAnki
      ? null
      : qd.image === "practical"
      ? card.practicalUrl || card.mnemonicUrl
      : card.mnemonicUrl || card.practicalUrl;

    const answerImage = isAnki
      ? null
      : qd.image === "practical"
      ? card.practicalAnswerUrl ||
        card.mnemonicAnswerUrl ||
        card.practicalUrl ||
        card.mnemonicUrl
      : card.mnemonicAnswerUrl ||
        card.practicalAnswerUrl ||
        card.mnemonicUrl ||
        card.practicalUrl;

    const rawAnswerImages = isAnki
      ? []
      : [
          {
            label: "Mnemonic",
            src: card.mnemonicAnswerUrl || card.mnemonicUrl,
          },
          {
            label: "Practical",
            src:
              card.practicalAnswerUrl ||
              card.practicalUrl ||
              card.mnemonicAnswerUrl ||
              card.mnemonicUrl,
          },
        ];

    const seenAnswerImageSrcs = new Set();

    const answerImages = rawAnswerImages.filter((img) => {
      if (!img.src) return false;
      if (seenAnswerImageSrcs.has(img.src)) return false;

      seenAnswerImageSrcs.add(img.src);
      return true;
    });

    let options = null;

    if (qd.mode === "mcq") {
      options = shuffle([correct, ...buildDistractors(card, allCards, 3)]);

      if (options.length < 4) {
        const fillers = ["Not sure", "Review later", "None of these"];
        for (const f of fillers) {
          if (options.length >= 4) break;
          if (!options.includes(f)) options.push(f);
        }
      }
    }

    return {
      ...qd,
      qid: ++qidRef.current,
      card,
      accepted,
      correct,
      image,
      answerImage,
      options,
      isAnki,
      promptHtml: card.promptHtml || "",
      answerHtml: card.answerHtml || "",
      sourceLabel: card.sourceLabel || "Learn",
    };
  };

  const beginSession = (sessionCards) => {
    qidRef.current = 0;

    const fourRung = sessionCards.filter((c) => c.maxRung >= 4).length;
    const ankiCount = sessionCards.filter((c) =>
      String(c.sourceType || "").startsWith("anki")
    ).length;

    const items = sessionCards.map((c, i) => makeItem(c, i));
    const st = createState(items);

    stateRef.current = { st, allCards: sessionCards, lastRes: null };

    setStats((prev) => ({
      fourRung,
      ankiCount,
      total: sessionCards.length,
      fileName: (prev && prev.fileName) || "",
    }));

    setQ(decorate(nextQuestion(st), sessionCards));
    setPhase("learn");
  };

  const onFile = async (file) => {
    if (!file) return;

    setPhase("loading");
    setError("");

    try {
      const parsed = await ingestFile(file);

      if (parsed.length === 0) {
        throw new Error("The file contained zero usable cards.");
      }

      stateRef.current = { st: null, allCards: parsed, lastRes: null };

      setStats({
        fourRung: 0,
        ankiCount: 0,
        total: parsed.length,
        fileName: file.name,
      });

      const struct = buildStudyStructure(parsed);
      setStructure(struct);

      // Only show the deck/tag picker when there's something to pick.
      if (struct.hasStructure) {
        setPhase("select");
      } else {
        beginSession(parsed);
      }
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
      setPhase("upload");
    }
  };

  const startStudy = (selectedCards) => {
    if (!selectedCards || selectedCards.length === 0) return;
    beginSession(selectedCards);
  };

  const onGraded = (outcome, itemFromQuestion = q?.item) => {
    if (!stateRef.current || !itemFromQuestion) return;

    const { st } = stateRef.current;

    stateRef.current.lastRes = commitOutcome(st, itemFromQuestion, outcome);

    setTick((t) => t + 1);
  };

  const goToNextQuestion = () => {
    const ref = stateRef.current;

    if (!ref) return;

    ref.lastRes = null;

    const nq = nextQuestion(ref.st);

    if (!nq) return setPhase("done");

    setQ(decorate(nq, ref.allCards));
  };

  const advance = () => {
    const ref = stateRef.current;

    if (!ref) return;

    const res = ref.lastRes;

    if (res && res.allComplete) return setPhase("done");
    if (res && res.roundComplete) return setPhase("checkpoint");

    goToNextQuestion();
  };

  const continueFromCheckpoint = () => {
    if (!stateRef.current) return;

    startNewRound(stateRef.current.st);
    stateRef.current.lastRes = null;

    setPhase("learn");
    goToNextQuestion();
  };

  const reset = () => {
    stateRef.current = null;
    qidRef.current = 0;

    setQ(null);
    setStats(null);
    setStructure(null);
    setError("");
    setPhase("upload");
  };

  const prog =
    stateRef.current && stateRef.current.st
      ? progress(stateRef.current.st)
      : { matured: 0, total: 0 };

  return (
    <div className="app">
      <style>{CSS}</style>

      {phase === "upload" && <Upload onFile={onFile} error={error} />}

      {phase === "loading" && (
        <div className="centered">
          Reading package, decoding media, and building Learn cards…
        </div>
      )}

      {phase === "select" && structure && (
        <StudySelect
          structure={structure}
          allCards={stateRef.current ? stateRef.current.allCards : []}
          stats={stats}
          onStart={startStudy}
          onClose={reset}
        />
      )}

      {phase === "learn" && q && (
        <Learn
          q={q}
          prog={prog}
          stats={stats}
          settings={settings}
          setSettings={setSettings}
          showSettings={showSettings}
          setShowSettings={setShowSettings}
          onGraded={onGraded}
          onAdvance={advance}
          onClose={reset}
        />
      )}

      {phase === "checkpoint" && (
        <Checkpoint
          prog={prog}
          onContinue={continueFromCheckpoint}
          stats={stats}
        />
      )}

      {phase === "done" && <Done prog={prog} onReset={reset} />}
    </div>
  );
}

function StudySelect({ structure, allCards, stats, onStart, onClose }) {
  const [selectedDecks, setSelectedDecks] = useState(
    () => new Set(structure.allDeckIds)
  );
  const [expanded, setExpanded] = useState(() => {
    const s = new Set();
    for (const r of structure.roots) s.add(r.fullName);
    return s;
  });
  const [selectedTags, setSelectedTags] = useState(() => new Set());
  const [showTags, setShowTags] = useState(false);

  const descendantIds = (node) => {
    const ids = [];
    const walk = (n) => {
      if (n.deckId) ids.push(n.deckId);
      n.children.forEach(walk);
    };
    walk(node);
    return ids;
  };

  const nodeState = (node) => {
    const ids = descendantIds(node);
    if (ids.length === 0) return "none";
    let sel = 0;
    for (const id of ids) if (selectedDecks.has(id)) sel++;
    if (sel === 0) return "none";
    if (sel === ids.length) return "all";
    return "some";
  };

  const toggleDeck = (node) => {
    const ids = descendantIds(node);
    const allSel = ids.length > 0 && ids.every((id) => selectedDecks.has(id));
    setSelectedDecks((prev) => {
      const next = new Set(prev);
      if (allSel) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggleExpand = (node) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(node.fullName)) next.delete(node.fullName);
      else next.add(node.fullName);
      return next;
    });

  const toggleTag = (tag) =>
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  const filtered = useMemo(() => {
    return allCards.filter((c) => {
      const did = c.deckId || "1";
      if (!selectedDecks.has(did)) return false;

      if (selectedTags.size === 0) return true;

      const tags = c.tags || [];
      if (tags.length === 0) return selectedTags.has(UNTAGGED);
      return tags.some((t) => selectedTags.has(t));
    });
  }, [allCards, selectedDecks, selectedTags]);

  const allDecksOn = selectedDecks.size === structure.allDeckIds.length;

  const renderNode = (node) => {
    const state = nodeState(node);
    const hasKids = node.children.length > 0;
    const isOpen = expanded.has(node.fullName);

    return (
      <div className="deck-node" key={node.fullName}>
        <div className="deck-row" style={{ paddingLeft: 6 + node.depth * 20 }}>
          <span
            className={"deck-caret" + (hasKids ? "" : " empty")}
            onClick={() => hasKids && toggleExpand(node)}
          >
            {hasKids ? (isOpen ? "▾" : "▸") : ""}
          </span>

          <span className={"dchk " + state} onClick={() => toggleDeck(node)}>
            {state === "all" ? "✓" : state === "some" ? "–" : ""}
          </span>

          <span className="deck-name" onClick={() => toggleDeck(node)}>
            {node.name}
          </span>

          <span className="deck-count">{node.totalCount}</span>
        </div>

        {hasKids && isOpen && (
          <div className="deck-children">{node.children.map(renderNode)}</div>
        )}
      </div>
    );
  };

  return (
    <div className="select-wrap">
      <div className="topbar">
        <div className="brand-row small">
          <Logo />
          <span className="brand-name">Learn</span>
        </div>
        <div className="topbar-right">
          <span className="icon-btn" title="Exit" onClick={onClose}>
            ✕
          </span>
        </div>
      </div>

      <div className="select-head">
        <h2>Choose what to study</h2>
        {stats?.fileName && <div className="file-chip">{stats.fileName}</div>}
      </div>

      <div className="select-section">
        <div className="select-section-head">
          <span className="select-section-title">Decks</span>
          <div className="select-bulk">
            <span
              className="bulk-link"
              onClick={() => setSelectedDecks(new Set(structure.allDeckIds))}
            >
              All
            </span>
            <span
              className="bulk-link"
              onClick={() => setSelectedDecks(new Set())}
            >
              None
            </span>
          </div>
        </div>

        <div className="deck-tree">{structure.roots.map(renderNode)}</div>
      </div>

      {(structure.tagList.length > 0 || structure.untaggedCount > 0) && (
        <div className="select-section">
          <div
            className="select-section-head clickable"
            onClick={() => setShowTags((v) => !v)}
          >
            <span className="select-section-title">
              Tags {selectedTags.size > 0 && `· ${selectedTags.size} active`}
            </span>
            <span className="caret">{showTags ? "▾" : "▸"}</span>
          </div>

          {showTags && (
            <>
              <div className="tag-note">
                Showing cards with <strong>any</strong> selected tag. No tags
                selected means all tags are included.
              </div>

              <div className="tag-cloud">
                {structure.untaggedCount > 0 && (
                  <span
                    className={
                      "tag-chip" + (selectedTags.has(UNTAGGED) ? " on" : "")
                    }
                    onClick={() => toggleTag(UNTAGGED)}
                  >
                    untagged
                    <span className="tag-n">{structure.untaggedCount}</span>
                  </span>
                )}

                {structure.tagList.map(({ tag, count }) => (
                  <span
                    key={tag}
                    className={
                      "tag-chip" + (selectedTags.has(tag) ? " on" : "")
                    }
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                    <span className="tag-n">{count}</span>
                  </span>
                ))}
              </div>

              {selectedTags.size > 0 && (
                <span
                  className="bulk-link clear-tags"
                  onClick={() => setSelectedTags(new Set())}
                >
                  Clear tag filter
                </span>
              )}
            </>
          )}
        </div>
      )}

      <div className="select-foot">
        <div className="select-summary">
          <strong>{filtered.length}</strong> of {structure.totalCards} card
          {structure.totalCards === 1 ? "" : "s"}
          {!allDecksOn || selectedTags.size > 0 ? " selected" : ""}
        </div>

        <button
          className="cp-btn start-btn"
          disabled={filtered.length === 0}
          onClick={() => onStart(filtered)}
        >
          Start studying
        </button>
      </div>
    </div>
  );
}

function Upload({ onFile, error }) {
  const inputRef = useRef();
  const [drag, setDrag] = useState(false);

  return (
    <div className="upload-wrap">
      <div className="brand-row">
        <Logo />
        <span className="brand-name">Learn</span>
      </div>

      <div
        className={"dropzone" + (drag ? " drag" : "")}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          onFile(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current.click()}
      >
        <div className="dz-title">Drop an Anki deck or Learning ZIP here</div>

        <div className="dz-sub">
          accepts <code>.apkg</code>, <code>.akpg</code>, or <code>.zip</code>
          <br />
          Basic, reversed Basic, Cloze, and AnatoMnemonics Learning ZIPs
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".zip,.apkg,.akpg"
          hidden
          onChange={(e) => onFile(e.target.files[0])}
        />
      </div>

      <div className="upload-note">
        Anki imports run as <strong>MCQ → type-in</strong>. Learning ZIPs with
        practical images run as{" "}
        <strong>
          mnemonic MCQ → mnemonic type → practical MCQ → practical type
        </strong>
        .
      </div>

      {error && <div className="err">⚠ {error}</div>}
    </div>
  );
}

function Learn(props) {
  const {
    q,
    prog,
    stats,
    settings,
    setSettings,
    showSettings,
    setShowSettings,
    onGraded,
    onAdvance,
    onClose,
  } = props;

  const k = "q" + q.qid;

  return (
    <div className="learn">
      <TopBar
        settings={settings}
        setSettings={setSettings}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        onClose={onClose}
      />

      <ProgressBar matured={prog.matured} total={prog.total} />

      <div className="meta-row">
        <div className="rung-chip">{labelForQuestion(q)}</div>

        {stats?.fileName && <div className="file-chip">{stats.fileName}</div>}
      </div>

      {q.mode === "mcq" ? (
        <MCQ
          key={k}
          q={q}
          settings={settings}
          onGraded={onGraded}
          onAdvance={onAdvance}
        />
      ) : (
        <TypeIn
          key={k}
          q={q}
          settings={settings}
          onGraded={onGraded}
          onAdvance={onAdvance}
        />
      )}
    </div>
  );
}

function labelForQuestion(q) {
  if (q.isAnki) {
    if (q.card.sourceType === "anki-cloze") {
      return q.rung === 1 ? "Cloze · choose" : "Cloze · type";
    }

    return q.rung === 1 ? "Anki · choose" : "Anki · type";
  }

  if (q.card.maxRung <= 2) {
    return q.rung === 1 ? "Mnemonic · choose" : "Mnemonic · type";
  }

  return RUNG[q.rung]?.label || "Learn";
}

function TopBar({
  settings,
  setSettings,
  showSettings,
  setShowSettings,
  onClose,
}) {
  const toggle = (key) => setSettings((s) => ({ ...s, [key]: !s[key] }));

  return (
    <div className="topbar">
      <div className="brand-row small">
        <Logo />
        <span className="brand-name">Learn</span>
      </div>

      <div className="topbar-right">
        <span
          className={"icon-btn" + (settings.sound ? " on" : "")}
          title="Sound"
          onClick={() => toggle("sound")}
        >
          {settings.sound ? "🔊" : "🔇"}
        </span>

        <div className="settings-wrap">
          <span
            className="icon-btn"
            title="Settings"
            onClick={() => setShowSettings((v) => !v)}
          >
            ⚙
          </span>

          {showSettings && (
            <div className="settings-pop">
              <Toggle
                label="Sound effects"
                on={settings.sound}
                onClick={() => toggle("sound")}
              />
              <Toggle
                label="Speak answers"
                on={settings.speak}
                onClick={() => toggle("speak")}
              />
              <Toggle
                label="Auto-advance on correct"
                on={settings.autoAdvance}
                onClick={() => toggle("autoAdvance")}
              />
            </div>
          )}
        </div>

        <span className="icon-btn" title="Exit" onClick={onClose}>
          ✕
        </span>
      </div>
    </div>
  );
}

function Toggle({ label, on, onClick }) {
  return (
    <div className="toggle-row" onClick={onClick}>
      <span>{label}</span>

      <span className={"switch" + (on ? " on" : "")}>
        <span className="knob" />
      </span>
    </div>
  );
}

function ProgressBar({ matured, total }) {
  const segments = 6;
  const frac = total ? matured / total : 0;

  return (
    <div className="progress-row">
      <span className="prog-count done">{matured}</span>

      <div className="prog-track">
        {Array.from({ length: segments }).map((_, i) => {
          const s = i / segments;
          const e = (i + 1) / segments;
          let fill = 0;

          if (frac >= e) fill = 1;
          else if (frac > s) fill = (frac - s) / (e - s);

          return (
            <div className="seg" key={i}>
              <div className="seg-fill" style={{ width: `${fill * 100}%` }} />
            </div>
          );
        })}
      </div>

      <span className="prog-count total">{total}</span>
    </div>
  );
}

function PromptBlock({ q }) {
  if (q.promptHtml) {
    return (
      <div
        className="anki-html prompt-html"
        dangerouslySetInnerHTML={{ __html: q.promptHtml }}
      />
    );
  }

  if (q.image) {
    return <QImage src={q.image} />;
  }

  return (
    <div className="plain-prompt">
      {q.card.promptPreview || "Answer this card."}
    </div>
  );
}

function AnswerBlock({ q }) {
  const hasHtml = q.answerHtml && stripAnswerText(q.answerHtml);
  const hasImage = q.answerImage;

  if (!hasHtml && !hasImage) return null;

  return (
    <div className="answer-block">
      <div className="answer-image-label">Answer</div>

      {hasHtml && (
        <div
          className="anki-html answer-html"
          dangerouslySetInnerHTML={{ __html: q.answerHtml }}
        />
      )}

      {hasImage && <AnswerImage src={q.answerImage} label="Answer image" />}
    </div>
  );
}

function QImage({ src }) {
  if (!src) {
    return <div className="qimage missing">no image for this card</div>;
  }

  return (
    <div className="qimage">
      <img src={src} alt="card prompt" />
    </div>
  );
}

function AnswerImage({ src, label = "Answer image" }) {
  if (!src) return null;

  return (
    <div className="answer-image">
      <img src={src} alt={label} />
    </div>
  );
}

function instructionFor(q, mode) {
  if (q.card.sourceType === "anki-cloze") {
    return mode === "mcq"
      ? "Choose the missing text."
      : "Type the missing text.";
  }

  if (q.isAnki) {
    return mode === "mcq" ? "Choose the answer." : "Type the answer.";
  }

  return "Identify the labeled structure.";
}

function MCQ({ q, settings, onGraded, onAdvance }) {
  const [picked, setPicked] = useState(null);
  const timerRef = useRef(null);
  const lockedRef = useRef(false);
  const advancedRef = useRef(false);

  const acceptedNorm = useMemo(
    () => new Set(q.accepted.map(normalize)),
    [q.accepted]
  );

  const isCorrect = useCallback(
    (opt) => acceptedNorm.has(normalize(opt)),
    [acceptedNorm]
  );

  const goNext = useCallback(() => {
    if (advancedRef.current) return;

    advancedRef.current = true;

    if (timerRef.current) clearTimeout(timerRef.current);

    onAdvance();
  }, [onAdvance]);

  const choose = useCallback(
    (opt) => {
      if (lockedRef.current) return;

      lockedRef.current = true;
      setPicked(opt);

      const correct = isCorrect(opt);

      if (settings.sound) (correct ? playCorrect : playWrong)();
      if (correct && settings.speak) speak(q.correct);

      onGraded(correct ? "correct" : "wrong", q.item);

      if (correct && settings.autoAdvance) {
        timerRef.current = setTimeout(goNext, AUTO_ADVANCE_MS);
      }
    },
    [goNext, isCorrect, onGraded, q.correct, q.item, settings]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Enter" && lockedRef.current) {
        e.preventDefault();
        goNext();
        return;
      }

      if (lockedRef.current) return;

      const n = parseInt(e.key, 10);

      if (n >= 1 && n <= q.options.length) {
        e.preventDefault();
        choose(q.options[n - 1]);
      }
    };

    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);

      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [choose, goNext, q.options]);

  const answeredCorrect = picked !== null && isCorrect(picked);

  return (
    <div className="card">
      <div className="card-label">{q.sourceLabel || "Question"}</div>

      <PromptBlock q={q} />

      <div className="prompt">{instructionFor(q, "mcq")}</div>

      <div className="choose">Choose an answer</div>

      <div className="options">
        {q.options.map((opt, i) => {
          let cls = "option";

          if (picked !== null) {
            if (isCorrect(opt)) cls += " correct";
            else if (opt === picked) cls += " wrong";
            else cls += " dim";
          }

          return (
            <button
              key={`${normalize(opt)}-${i}`}
              className={cls}
              onClick={() => choose(opt)}
            >
              <span className="opt-num">{i + 1}</span>
              <span className="opt-text">{opt}</span>
            </button>
          );
        })}
      </div>

      {picked !== null && <AnswerBlock q={q} />}

      <div className="card-foot">
        <span className="flag">⚑</span>

        {picked === null ? (
          <span className="dont-know" onClick={() => choose("___dk___")}>
            Don't know?
          </span>
        ) : (
          <>
            {answeredCorrect && <span className="feedback ok">Correct</span>}
            {!answeredCorrect && (
              <span className="feedback bad">Correct: {q.correct}</span>
            )}
            <button className="continue" onClick={goNext}>
              Continue
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function TypeIn({ q, settings, onGraded, onAdvance }) {
  const [val, setVal] = useState("");
  const [result, setResult] = useState(null);
  const [committed, setCommitted] = useState(false);
  const timerRef = useRef(null);
  const advancedRef = useRef(false);
  const committedRef = useRef(false);

  const goNext = useCallback(() => {
    if (advancedRef.current) return;

    advancedRef.current = true;

    if (timerRef.current) clearTimeout(timerRef.current);

    onAdvance();
  }, [onAdvance]);

  const finish = useCallback(
    (outcome) => {
      if (committedRef.current) return;

      committedRef.current = true;

      const correct = outcome === "correct";
      const mistypedOutcome = outcome === "mistyped";

      setResult({ correct, mistyped: mistypedOutcome });
      setCommitted(true);

      if (settings.sound && !mistypedOutcome) {
        (correct ? playCorrect : playWrong)();
      }

      if (correct && settings.speak) speak(q.correct);

      onGraded(outcome, q.item);

      if (correct && settings.autoAdvance) {
        timerRef.current = setTimeout(goNext, AUTO_ADVANCE_MS);
      }
    },
    [goNext, onGraded, q.correct, q.item, settings]
  );

  const submit = useCallback(() => {
    if (result || committedRef.current) return;

    const g = gradeTyped(val, q.accepted);

    if (g.correct) finish("correct");
    else setResult({ correct: false, mistyped: false });
  }, [finish, q.accepted, result, val]);

  const override = () => finish("correct");
  const mistyped = () => finish("mistyped");
  const acceptWrong = () => finish("wrong");

  const dontKnow = () => {
    if (!result && !committedRef.current) {
      setResult({ correct: false, mistyped: false });
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Enter") return;

      e.preventDefault();

      if (!result) submit();
      else if (committed) goNext();
    };

    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);

      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [committed, goNext, result, submit]);

  const wrongUncommitted = result && !result.correct && !committed;

  return (
    <div className="card">
      <div className="card-label">{q.sourceLabel || "Question"}</div>

      <PromptBlock q={q} />

      <div className="prompt">{instructionFor(q, "type")}</div>

      <div className="choose">Your answer</div>

      <input
        className={
          "type-input" +
          (result
            ? result.correct
              ? " correct"
              : result.mistyped
              ? ""
              : " wrong"
            : "")
        }
        value={val}
        autoFocus
        placeholder="Type the answer"
        disabled={!!result}
        onChange={(e) => setVal(e.target.value)}
      />

      {result && !result.correct && !result.mistyped && (
        <div className="answer-reveal">
          Correct answer: <strong>{q.correct}</strong>
          {settings.speak && (
            <span
              className="speak-btn"
              title="Hear it"
              onClick={() => speak(q.correct)}
            >
              🔊
            </span>
          )}
        </div>
      )}

      {result && result.correct && (
        <div className="answer-reveal ok">Correct</div>
      )}

      {result && result.mistyped && (
        <div className="answer-reveal neutral">
          No penalty — this card will come back.
        </div>
      )}

      {result && <AnswerBlock q={q} />}

      <div className="card-foot">
        <span className="flag">⚑</span>

        {!result ? (
          <>
            <span className="dont-know" onClick={dontKnow}>
              Don't know?
            </span>

            <button className="continue" onClick={submit}>
              Answer
            </button>
          </>
        ) : wrongUncommitted ? (
          <div className="override-row">
            <button className="ghost-btn" onClick={mistyped}>
              I mistyped
            </button>

            <button className="ghost-btn override" onClick={override}>
              Override: I was correct
            </button>

            <button className="continue" onClick={acceptWrong}>
              Continue
            </button>
          </div>
        ) : (
          <>
            {result.correct && <span className="feedback ok">Correct</span>}

            <button className="continue" onClick={goNext}>
              Continue
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Checkpoint({ prog, onContinue, stats }) {
  const pct = prog.total ? Math.round((prog.matured / prog.total) * 100) : 0;

  return (
    <div className="checkpoint">
      <div className="cp-card">
        <Ring pct={pct} />

        <h2>Nice work — keep going</h2>

        <p>
          {prog.matured} of {prog.total} cards fully matured.
        </p>

        {stats && stats.ankiCount > 0 && (
          <p className="cp-note">
            Anki package mode: each card runs through MCQ and type-in recall.
          </p>
        )}

        {stats && stats.ankiCount === 0 && stats.fourRung === 0 && (
          <p className="cp-note">
            Running in 2-rung mode. Export practical question/answer images in
            the Learning ZIP to unlock practical rungs.
          </p>
        )}

        <button className="cp-btn" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}

function Done({ prog, onReset }) {
  return (
    <div className="checkpoint">
      <div className="cp-card">
        <Ring pct={100} />

        <h2>You've learned every card</h2>

        <p>
          All {prog.total} cards matured. This is the fast-learning layer — hand
          off to Anki/FSRS for long-term retention.
        </p>

        {onReset && (
          <button className="cp-btn" onClick={onReset}>
            Start another deck
          </button>
        )}
      </div>
    </div>
  );
}

function Ring({ pct }) {
  const r = 46;
  const c = 2 * Math.PI * r;

  return (
    <svg className="ring" viewBox="0 0 120 120">
      <circle cx="60" cy="60" r={r} className="ring-bg" />

      <circle
        cx="60"
        cy="60"
        r={r}
        className="ring-fg"
        style={{ strokeDasharray: c, strokeDashoffset: c * (1 - pct / 100) }}
      />

      <text x="60" y="68" className="ring-text">
        {pct}%
      </text>
    </svg>
  );
}

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 24 24" width="26" height="26">
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="#4255ff"
        strokeWidth="2.4"
        strokeDasharray="3 3"
      />
    </svg>
  );
}

/* ----------------------------- CSS --------------------------------------- */

const CSS = `
:root{
  --indigo:#4255ff;
  --indigo-d:#3548d6;
  --bg:#f6f7fb;
  --card:#fff;
  --ink:#2e3856;
  --muted:#939bb4;
  --line:#e3e6f0;
  --green:#18ae72;
  --green-bg:#e7f8f0;
  --red:#ef5350;
  --red-bg:#fdecec;
  --yellow-bg:#fff8e6;
  --yellow-ink:#8a6d1a;
}

*{box-sizing:border-box}

body{
  margin:0;
  background:var(--bg);
  color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}

.app{min-height:100vh}

.upload-wrap{
  max-width:760px;
  margin:0 auto;
  padding:64px 20px;
}

.brand-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:28px;
}

.brand-row.small{margin:0}

.brand-name{
  font-weight:800;
  font-size:22px;
}

.dropzone{
  border:2.5px dashed var(--line);
  border-radius:16px;
  background:#fff;
  padding:64px 24px;
  text-align:center;
  cursor:pointer;
  transition:border-color .15s,background .15s,transform .15s;
}

.dropzone:hover,.dropzone.drag{
  border-color:var(--indigo);
  background:#fafbff;
  transform:translateY(-1px);
}

.dz-title{
  font-size:21px;
  font-weight:800;
  margin-bottom:10px;
}

.dz-sub{
  color:var(--muted);
  font-size:14px;
  line-height:1.65;
}

.dz-sub code,.cp-note code,.qimage.missing code{
  background:#eef0f7;
  padding:1px 5px;
  border-radius:4px;
}

.upload-note{
  margin-top:16px;
  color:var(--muted);
  font-size:14px;
  line-height:1.55;
  background:#fff;
  border:1px solid var(--line);
  padding:14px 16px;
  border-radius:12px;
}

.err{
  margin-top:18px;
  background:var(--red-bg);
  color:#b02b2b;
  padding:12px 16px;
  border-radius:10px;
  font-size:14px;
  line-height:1.45;
}

.centered{
  display:flex;
  align-items:center;
  justify-content:center;
  min-height:60vh;
  color:var(--muted);
  font-size:16px;
  padding:20px;
  text-align:center;
}

.learn,.checkpoint{
  max-width:940px;
  margin:0 auto;
  padding:18px 20px 60px;
}

.topbar{
  display:flex;
  justify-content:space-between;
  align-items:center;
  position:relative;
}

.topbar-right{
  display:flex;
  gap:14px;
  align-items:center;
}

.icon-btn{
  color:var(--muted);
  font-size:18px;
  cursor:pointer;
  line-height:1;
  user-select:none;
}

.icon-btn.on{color:var(--indigo)}

.settings-wrap{position:relative}

.settings-pop{
  position:absolute;
  right:0;
  top:30px;
  background:#fff;
  border:1px solid var(--line);
  border-radius:12px;
  box-shadow:0 8px 28px rgba(40,50,90,.16);
  padding:8px;
  width:248px;
  z-index:20;
}

.toggle-row{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:9px 10px;
  border-radius:8px;
  cursor:pointer;
  font-size:14px;
}

.toggle-row:hover{background:#f6f7fb}

.switch{
  width:38px;
  height:22px;
  border-radius:12px;
  background:#d3d7e6;
  position:relative;
  transition:background .15s;
  flex:none;
}

.switch.on{background:var(--indigo)}

.knob{
  position:absolute;
  top:2px;
  left:2px;
  width:18px;
  height:18px;
  border-radius:50%;
  background:#fff;
  transition:left .15s;
}

.switch.on .knob{left:18px}

.progress-row{
  display:flex;
  align-items:center;
  gap:12px;
  margin:26px 0 18px;
}

.prog-track{
  flex:1;
  display:flex;
  gap:8px;
}

.seg{
  flex:1;
  height:12px;
  background:#e6e8f1;
  border-radius:8px;
  overflow:hidden;
}

.seg-fill{
  height:100%;
  background:var(--indigo);
  transition:width .4s ease;
}

.prog-count{
  min-width:34px;
  height:34px;
  border-radius:50%;
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:800;
  font-size:14px;
}

.prog-count.done{
  background:var(--green);
  color:#fff;
}

.prog-count.total{
  background:#fff;
  color:var(--muted);
  border:2px solid var(--line);
}

.meta-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin:0 0 14px;
  flex-wrap:wrap;
}

.rung-chip{
  display:inline-block;
  font-size:12px;
  font-weight:800;
  letter-spacing:.03em;
  text-transform:uppercase;
  color:var(--indigo);
  background:#eef0ff;
  padding:5px 11px;
  border-radius:20px;
}

.file-chip{
  display:inline-block;
  max-width:420px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  font-size:12px;
  font-weight:700;
  color:var(--muted);
  background:#fff;
  border:1px solid var(--line);
  padding:5px 11px;
  border-radius:20px;
}

.card{
  background:var(--card);
  border:1px solid var(--line);
  border-radius:16px;
  padding:26px 30px 18px;
  box-shadow:0 2px 10px rgba(40,50,90,.04);
}

.card-label{
  font-size:14px;
  font-weight:800;
  color:var(--muted);
  margin-bottom:12px;
}

.qimage{
  display:flex;
  justify-content:center;
  margin:18px 0 10px;
}

.qimage img{
  max-height:360px;
  max-width:100%;
  border-radius:10px;
  background:#000;
}

.qimage.missing{
  display:flex;
  align-items:center;
  justify-content:center;
  height:220px;
  color:var(--muted);
  font-size:14px;
  text-align:center;
  border:1px dashed var(--line);
  border-radius:10px;
  padding:18px;
}

.plain-prompt{
  background:#fafbff;
  border:1px solid var(--line);
  border-radius:12px;
  padding:18px;
  font-size:18px;
  line-height:1.55;
  margin:12px 0 18px;
}

.anki-html{
  line-height:1.55;
  overflow-wrap:anywhere;
}

.anki-html img{
  max-width:100%;
  height:auto;
  border-radius:10px;
  display:block;
  margin:10px auto;
}

.anki-html table{
  max-width:100%;
  border-collapse:collapse;
}

.anki-html td,.anki-html th{
  border:1px solid var(--line);
  padding:6px 8px;
}

.prompt-html{
  background:#fafbff;
  border:1px solid var(--line);
  border-radius:12px;
  padding:20px;
  margin:12px 0 18px;
  font-size:18px;
}

.prompt-html:empty{display:none}

.prompt{
  font-size:17px;
  font-weight:700;
  margin:8px 0 18px;
}

.choose{
  font-size:14px;
  font-weight:800;
  color:var(--muted);
  margin-bottom:12px;
}

.options{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:14px;
}

.option{
  display:flex;
  align-items:center;
  gap:14px;
  text-align:left;
  border:2px solid var(--line);
  background:#fff;
  border-radius:12px;
  padding:18px;
  font-size:16px;
  color:var(--ink);
  cursor:pointer;
  font-family:inherit;
  transition:border-color .12s,background .12s,transform .12s;
  min-height:68px;
}

.option:hover{
  border-color:#c2c8e6;
  transform:translateY(-1px);
}

.opt-num{
  width:24px;
  height:24px;
  border-radius:50%;
  border:1.5px solid var(--line);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:12px;
  font-weight:800;
  color:var(--muted);
  flex:none;
}

.opt-text{
  overflow-wrap:anywhere;
}

.option.correct{
  border-color:var(--green);
  background:var(--green-bg);
}

.option.wrong{
  border-color:var(--red);
  background:var(--red-bg);
}

.option.dim{opacity:.55}

.type-input{
  width:100%;
  border:none;
  border-bottom:2px solid var(--indigo);
  background:#fafbff;
  padding:14px 8px;
  font-size:18px;
  color:var(--ink);
  font-family:inherit;
  outline:none;
  border-radius:6px 6px 0 0;
}

.type-input.correct{
  border-color:var(--green);
  background:var(--green-bg);
}

.type-input.wrong{
  border-color:var(--red);
  background:var(--red-bg);
}

.answer-reveal{
  margin-top:14px;
  font-size:15px;
  color:var(--red);
  display:flex;
  align-items:center;
  gap:8px;
  flex-wrap:wrap;
}

.answer-reveal.ok{color:var(--green)}
.answer-reveal.neutral{color:var(--muted)}
.answer-reveal strong{color:var(--ink)}

.speak-btn{
  cursor:pointer;
  font-size:15px;
}

.answer-block{
  margin-top:18px;
  border-top:1px solid var(--line);
  padding-top:14px;
}

.answer-image-label{
  font-size:12px;
  font-weight:800;
  letter-spacing:.04em;
  text-transform:uppercase;
  color:var(--muted);
  margin-bottom:8px;
}

.answer-html{
  background:#fafbff;
  border:1px solid var(--line);
  border-radius:12px;
  padding:16px;
  margin-bottom:10px;
}

.answer-image{
  display:flex;
  justify-content:center;
  background:#fafbff;
  border:1px solid var(--line);
  border-radius:12px;
  padding:10px;
}

.answer-image img{
  max-height:280px;
  max-width:100%;
  border-radius:10px;
  background:#000;
}

.answer-hr{
  border:none;
  border-top:1px solid var(--line);
  margin:14px 0;
}

.cloze-blank{
  display:inline-block;
  background:#eef0ff;
  color:var(--indigo);
  border:1px solid #cfd5ff;
  border-radius:7px;
  padding:1px 7px;
  font-weight:800;
}

.cloze-shown{
  font-weight:700;
}

.cloze-answer{
  display:inline-block;
  background:var(--green-bg);
  color:var(--green);
  border:1px solid #bcebd5;
  border-radius:7px;
  padding:1px 7px;
  font-weight:900;
}

.anki-hint{
  display:inline-block;
  color:var(--muted);
  border-bottom:1px dashed var(--muted);
}

.sound-chip{
  display:inline-block;
  background:#eef0f7;
  color:var(--muted);
  padding:2px 7px;
  border-radius:999px;
  font-size:12px;
  font-weight:700;
}

.anki-audio{
  max-width:100%;
  vertical-align:middle;
}

.card-foot{
  display:flex;
  align-items:center;
  justify-content:flex-end;
  gap:18px;
  margin-top:20px;
  padding-top:14px;
  border-top:1px solid var(--line);
  flex-wrap:wrap;
}

.flag{
  color:var(--muted);
  cursor:pointer;
  margin-right:auto;
}

.dont-know{
  color:var(--indigo);
  font-weight:800;
  cursor:pointer;
  font-size:15px;
}

.feedback.ok{
  color:var(--green);
  font-weight:900;
  font-size:16px;
}

.feedback.bad{
  color:var(--red);
  font-weight:800;
  font-size:14px;
  max-width:420px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.override-row{
  display:flex;
  gap:10px;
  align-items:center;
  flex-wrap:wrap;
  justify-content:flex-end;
}

.ghost-btn{
  background:#fff;
  border:2px solid var(--line);
  color:var(--ink);
  border-radius:10px;
  padding:9px 14px;
  font-size:14px;
  font-weight:800;
  cursor:pointer;
  font-family:inherit;
}

.ghost-btn:hover{border-color:#c2c8e6}

.ghost-btn.override{
  border-color:var(--green);
  color:var(--green);
}

.continue,.cp-btn{
  background:var(--indigo);
  color:#fff;
  border:none;
  border-radius:10px;
  font-weight:800;
  cursor:pointer;
  font-family:inherit;
}

.continue{
  padding:11px 22px;
  font-size:15px;
}

.continue:hover,.cp-btn:hover{background:var(--indigo-d)}

.cp-card{
  background:#fff;
  border:1px solid var(--line);
  border-radius:18px;
  padding:40px;
  text-align:center;
  margin-top:40px;
}

.cp-card h2{margin:18px 0 6px}

.cp-card p{
  color:var(--muted);
  margin:4px 0;
}

.cp-note{
  margin-top:14px!important;
  font-size:13px;
  background:var(--yellow-bg);
  color:var(--yellow-ink);
  padding:10px 14px;
  border-radius:8px;
  display:inline-block;
}

.cp-btn{
  margin-top:22px;
  padding:13px 30px;
  font-size:16px;
}

.ring{
  width:120px;
  height:120px;
}

.ring-bg{
  fill:none;
  stroke:#eceefa;
  stroke-width:10;
}

.ring-fg{
  fill:none;
  stroke:var(--green);
  stroke-width:10;
  stroke-linecap:round;
  transform:rotate(-90deg);
  transform-origin:60px 60px;
  transition:stroke-dashoffset .6s;
}

.ring-text{
  text-anchor:middle;
  font-size:24px;
  font-weight:800;
  fill:var(--ink);
}

/* ---- study selection (deck / tag picker) ---- */

.select-wrap{
  max-width:760px;
  margin:0 auto;
  padding:18px 20px 120px;
}

.select-head{
  display:flex;
  align-items:center;
  gap:12px;
  flex-wrap:wrap;
  margin:18px 0 20px;
}

.select-head h2{
  margin:0;
  font-size:22px;
}

.select-section{
  background:#fff;
  border:1px solid var(--line);
  border-radius:14px;
  padding:14px 16px;
  margin-bottom:16px;
}

.select-section-head{
  display:flex;
  align-items:center;
  justify-content:space-between;
  margin-bottom:8px;
}

.select-section-head.clickable{
  cursor:pointer;
  margin-bottom:0;
}

.select-section-title{
  font-size:13px;
  font-weight:800;
  letter-spacing:.04em;
  text-transform:uppercase;
  color:var(--muted);
}

.select-bulk{
  display:flex;
  gap:14px;
}

.bulk-link{
  color:var(--indigo);
  font-weight:800;
  font-size:13px;
  cursor:pointer;
}

.bulk-link:hover{text-decoration:underline}

.caret{color:var(--muted);font-size:13px}

.deck-tree{
  margin-top:6px;
  max-height:380px;
  overflow:auto;
}

.deck-row{
  display:flex;
  align-items:center;
  gap:8px;
  padding:6px 4px;
  border-radius:8px;
}

.deck-row:hover{background:#f6f7fb}

.deck-caret{
  width:16px;
  text-align:center;
  color:var(--muted);
  cursor:pointer;
  user-select:none;
  flex:none;
}

.deck-caret.empty{cursor:default}

.dchk{
  width:20px;
  height:20px;
  border-radius:6px;
  border:2px solid var(--line);
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:13px;
  font-weight:900;
  color:#fff;
  cursor:pointer;
  flex:none;
  line-height:1;
}

.dchk.all{background:var(--indigo);border-color:var(--indigo)}
.dchk.some{background:#aeb6e8;border-color:#aeb6e8}
.dchk.none{background:#fff}

.deck-name{
  flex:1;
  cursor:pointer;
  font-size:15px;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}

.deck-count{
  font-size:12px;
  font-weight:800;
  color:var(--muted);
  background:#eef0f7;
  border-radius:999px;
  padding:2px 9px;
  flex:none;
}

.tag-note{
  font-size:13px;
  color:var(--muted);
  margin:10px 0;
  line-height:1.5;
}

.tag-cloud{
  display:flex;
  flex-wrap:wrap;
  gap:8px;
  max-height:240px;
  overflow:auto;
}

.tag-chip{
  display:inline-flex;
  align-items:center;
  gap:7px;
  border:2px solid var(--line);
  background:#fff;
  border-radius:999px;
  padding:5px 12px;
  font-size:13px;
  font-weight:700;
  color:var(--ink);
  cursor:pointer;
  transition:border-color .12s,background .12s;
}

.tag-chip:hover{border-color:#c2c8e6}

.tag-chip.on{
  border-color:var(--indigo);
  background:#eef0ff;
  color:var(--indigo-d);
}

.tag-n{
  font-size:11px;
  font-weight:800;
  color:var(--muted);
  background:#eef0f7;
  border-radius:999px;
  padding:1px 7px;
}

.tag-chip.on .tag-n{background:#dfe3ff;color:var(--indigo-d)}

.clear-tags{
  display:inline-block;
  margin-top:12px;
}

.select-foot{
  position:fixed;
  left:0;
  right:0;
  bottom:0;
  background:#fff;
  border-top:1px solid var(--line);
  box-shadow:0 -4px 20px rgba(40,50,90,.06);
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:16px;
  padding:14px 20px;
}

.select-summary{
  font-size:15px;
  color:var(--ink);
}

.start-btn{
  padding:12px 26px;
  font-size:15px;
}

.start-btn:disabled{
  background:#c7ccde;
  cursor:not-allowed;
}

@media(max-width:640px){
  .learn,.checkpoint{
    padding:14px 14px 48px;
  }

  .options{
    grid-template-columns:1fr;
  }

  .card{
    padding:22px 18px 16px;
  }

  .answer-image img{
    max-height:220px;
  }

  .prompt-html{
    font-size:16px;
    padding:16px;
  }

  .file-chip{
    max-width:100%;
  }

  .feedback.bad{
    white-space:normal;
  }
}
`;
