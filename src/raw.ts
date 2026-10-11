import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Effect, Schema } from 'effect';
import { RawCardRow, RawRarityRow, rawRowToMetadata } from './domain.js';
import type { CardMetadata } from './domain.js';
import { RawDatabaseError } from './errors.js';
import { ARENA_RAW_DIR } from './paths.js';

export interface RawFallbackResult {
  readonly metadata: Map<number, CardMetadata>;
  readonly rawPath: string;
}

const FALLBACK_SQL = `
  SELECT c.*, COALESCE(n.Loc, n0.Loc) AS CardName,
    COALESCE(t.Loc, t0.Loc) AS TypeName,
    COALESCE(s.Loc, s0.Loc) AS SubtypeName
  FROM Cards c
  LEFT JOIN Localizations_enUS n  ON n.LocId = c.TitleId AND n.Formatted = 1
  LEFT JOIN Localizations_enUS n0 ON n0.LocId = c.TitleId AND n0.Formatted = 0
  LEFT JOIN Localizations_enUS t  ON t.LocId = c.TypeTextId AND t.Formatted = 1
  LEFT JOIN Localizations_enUS t0 ON t0.LocId = c.TypeTextId AND t0.Formatted = 0
  LEFT JOIN Localizations_enUS s  ON s.LocId = c.SubtypeTextId AND s.Formatted = 1
  LEFT JOIN Localizations_enUS s0 ON s0.LocId = c.SubtypeTextId AND s0.Formatted = 0
  WHERE c.GrpId = ?`;

/** Newest Arena raw card catalog on disk (always current, including brand-new sets). */
function findRawDatabase(): string | null {
  let entries: Array<string>;
  try {
    entries = fs.readdirSync(ARENA_RAW_DIR);
  } catch {
    return null;
  }
  const files = entries
    .filter(name => /^Raw_CardDatabase_.+\.mtga$/.test(name))
    .map(name => path.join(ARENA_RAW_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}

/** Map Arena's numeric rarity to metadata labels, using shared printings. */
function mapRarities(raw: DatabaseSync, toolRarity: Map<number, string>): Map<number, string> {
  const labelsByRarity = new Map<number, Set<string>>();
  for (const row of raw
    .prepare('SELECT GrpId, Rarity FROM Cards WHERE IsToken = 0 AND Rarity > 0')
    .all() as Array<unknown>) {
    const decoded = Schema.decodeUnknownSync(RawRarityRow)(row);
    const label = toolRarity.get(decoded.GrpId);
    if (label === undefined) continue;
    const set = labelsByRarity.get(decoded.Rarity) ?? new Set<string>();
    set.add(label);
    labelsByRarity.set(decoded.Rarity, set);
  }
  const labels = new Map<number, string>();
  for (const [rarity, values] of labelsByRarity) {
    if (values.size !== 1) {
      throw new Error(`Ambiguous rarity mapping for raw rarity ${rarity}: ${[...values].join(', ')}`);
    }
    const only = [...values][0];
    if (only !== undefined) labels.set(rarity, only);
  }
  return labels;
}

/** Resolve card IDs the metadata database does not know yet (new sets). */
export const lookupRawCards = Effect.fnUntraced(
  function* (
    grpIds: ReadonlyArray<number>,
    toolRarity: Map<number, string>
  ): Effect.fn.Return<RawFallbackResult, RawDatabaseError> {
    // The whole scan — including the fs.statSync in findRawDatabase — stays inside the typed error boundary.
    return yield* Effect.try({
      try: () => {
        const rawPath = findRawDatabase();
        if (rawPath === null) {
          throw new Error(`No Arena raw card database found in ${ARENA_RAW_DIR}; cannot resolve new-set card IDs.`);
        }
        const raw = new DatabaseSync(rawPath, { readOnly: true });
        try {
          const labels = mapRarities(raw, toolRarity);
          const stmt = raw.prepare(FALLBACK_SQL);
          const metadata = new Map<number, CardMetadata>();
          for (const grpId of grpIds) {
            const row = stmt.get(grpId);
            if (row === undefined || row === null) continue;
            const decoded = Schema.decodeUnknownSync(RawCardRow)(row);
            const rarity = labels.get(decoded.Rarity);
            if (rarity === undefined) {
              throw new Error(`No rarity label for grpid ${decoded.GrpId} (raw rarity ${decoded.Rarity})`);
            }
            metadata.set(decoded.GrpId, rawRowToMetadata(decoded, rarity));
          }
          return { metadata, rawPath } satisfies RawFallbackResult;
        } finally {
          raw.close();
        }
      },
      catch: (cause) => new RawDatabaseError({ message: `Raw card database lookup failed: ${String(cause)}` }),
    });
  }
);
