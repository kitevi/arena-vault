// Shared helpers for deckbuilding scripts. Reads the latest export, Arena's own
// card database (always current, unlike the mtgatool JSON), and Scryfall legality.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXPORT_JSON = path.join(ROOT, 'exports/mtga-owned-cards.json');
const LEGALITY_CACHE = path.join(ROOT, 'data/legality-cache.json');
const RAW_DIR = path.join(os.homedir(), 'Library/Application Support/com.wizards.mtga/Downloads/Raw');
const CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const SCRYFALL_HEADERS = { 'User-Agent': 'arena-vault/0.1', Accept: 'application/json' };

export const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

/** Owned, non-token, non-Alchemy printings from the latest export. */
export function loadCollection() {
  const { cards } = JSON.parse(fs.readFileSync(EXPORT_JSON, 'utf8'));
  return cards.filter((c) => !c.is_token && !c.is_digital_only && !c.is_rebalanced);
}

/** name -> { quantity (summed over printings, capped at 4 for non-basics), printings } */
export function ownedByName(collection = loadCollection()) {
  const byName = new Map();
  for (const c of collection) {
    const entry = byName.get(c.name) ?? { name: c.name, quantity: 0, printings: [] };
    entry.quantity += c.quantity;
    entry.printings.push(c);
    byName.set(c.name, entry);
  }
  for (const entry of byName.values()) {
    if (!BASICS.has(entry.name)) entry.quantity = Math.min(entry.quantity, 4);
  }
  return byName;
}

let rawDb;
function openRaw() {
  if (rawDb) return rawDb;
  const file = fs
    .readdirSync(RAW_DIR)
    .filter((f) => /^Raw_CardDatabase_.+\.mtga$/.test(f))
    .map((f) => path.join(RAW_DIR, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!file) throw new Error(`No Arena raw card database in ${RAW_DIR}`);
  rawDb = new DatabaseSync(file, { readOnly: true });
  return rawDb;
}

const TEXT_SQL = `
  SELECT AbilityIds, Power, Toughness, OldSchoolManaText FROM Cards WHERE GrpId = ?`;
// Prefer the plain variant (Formatted = 0); some strings exist only formatted.
const LOC_SQL = 'SELECT Loc FROM Localizations_enUS WHERE LocId = ? ORDER BY Formatted LIMIT 1';

/** Current rules text for an Arena card id, from Arena's own database. */
export function cardText(arenaId) {
  const db = openRaw();
  const row = db.prepare(TEXT_SQL).get(arenaId);
  if (!row) return null;
  const loc = db.prepare(LOC_SQL);
  const text = (row.AbilityIds ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => loc.get(Number(pair.split(':')[1]))?.Loc)
    .filter(Boolean)
    .map((t) => t.replace(/<[^>]+>/g, ''))
    .join(' // ');
  const pt = row.Power && row.Toughness ? `${row.Power}/${row.Toughness}` : null;
  return { text, pt, mana: row.OldSchoolManaText ?? '' };
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(LEGALITY_CACHE, 'utf8'));
  } catch {
    return {};
  }
}

async function scryfallJson(url, init) {
  const res = await fetch(url, { ...init, headers: { ...SCRYFALL_HEADERS, ...init?.headers } });
  if (!res.ok && res.status !== 404) throw new Error(`Scryfall ${res.status} for ${url}`);
  return res.json();
}

/**
 * name -> Standard legality ('legal' | 'not_legal' | 'banned' | 'unknown').
 * Arena legality goes by name, so any printing of a reprinted card counts.
 * Cached in data/legality-cache.json for a few days; pass { refresh: true } after a B&R update.
 */
export async function standardLegality(names, { refresh = false } = {}) {
  const cache = refresh ? {} : readCache();
  const now = Date.now();
  const stale = [...new Set(names)].filter((n) => !cache[n] || now - cache[n].at > CACHE_MAX_AGE_MS);
  for (let i = 0; i < stale.length; i += 75) {
    const batch = stale.slice(i, i + 75);
    const body = JSON.stringify({ identifiers: batch.map((name) => ({ name })) });
    const res = await scryfallJson('https://api.scryfall.com/cards/collection', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
    const found = new Map();
    for (const card of res.data ?? []) {
      found.set(card.name, card.legalities.standard);
      // Double-faced cards come back as "Front // Back"; Arena exports the front name.
      found.set(card.name.split(' // ')[0], card.legalities.standard);
    }
    for (const name of batch) {
      let legality = found.get(name);
      if (legality === undefined) {
        // Accented and oddly punctuated names miss exact matching.
        await new Promise((r) => setTimeout(r, 100));
        const card = await scryfallJson(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
        legality = card.object === 'card' ? card.legalities.standard : 'unknown';
      }
      cache[name] = { standard: legality, at: now };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (stale.length > 0) fs.writeFileSync(LEGALITY_CACHE, JSON.stringify(cache, null, 2));
  return new Map([...new Set(names)].map((n) => [n, cache[n]?.standard ?? 'unknown']));
}

/** Parse an Arena deck export ("Deck" / "4 Name (SET) 123" / "Sideboard"). */
export function parseDeck(text) {
  const deck = [];
  const sideboard = [];
  let section = deck;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || /^(deck|commander|companion)$/i.test(line)) continue;
    if (/^sideboard$/i.test(line)) {
      section = sideboard;
      continue;
    }
    const m = line.match(/^(\d+)\s+(.+?)(?:\s+\(([A-Z0-9]+)\)\s*(\S+)?)?$/);
    if (!m) throw new Error(`Cannot parse deck line: ${line}`);
    section.push({ count: Number(m[1]), name: m[2], set: m[3] ?? null, number: m[4] ?? null });
  }
  return { deck, sideboard };
}
