import fs from 'node:fs';
import path from 'node:path';
import { Effect, Schema } from 'effect';
import { WrittenExport } from './domain.js';
import type { ExportedCard, RawCollection } from './domain.js';
import { MetadataDatabase } from './database.js';
import { ExportError, OverwriteRefused } from './errors.js';
import { lookupRawCards } from './raw.js';
import { csvCell, splitCsvRow } from './util.js';

const RARITIES = new Set(['common', 'uncommon', 'rare', 'mythic', 'land', 'token']);
const CSV_HEADERS = [
  'Count', 'Name', 'Edition', 'Collector Number', 'Rarity', 'Arena ID', 'Digital Only', 'Rebalanced', 'Mana Value', 'Type',
] as const;

export interface ExportOptions {
  readonly collection: RawCollection;
  readonly outDir: string;
  readonly sourceLabel: string;
  readonly overwrite: boolean;
}

export interface ExportSummary {
  readonly csv: string;
  readonly json: string;
  readonly owned_rows: number;
  readonly distinct_names: number;
  readonly native_zero_quantity_rows_excluded: number;
  readonly all_ids_resolved: boolean;
  readonly game_database_fallback_rows: number;
  readonly game_database: string | null;
  readonly metadata_database: { readonly path: string; readonly source: string };
  readonly basic_land_rows: number;
  readonly digital_only_rows: number;
  readonly rebalanced_rows: number;
  readonly rarity_rows: Record<string, number>;
  readonly samples: ReadonlyArray<{ readonly count: number; readonly name: string }>;
}

function mapEquals(a: Map<number, number>, b: Map<number, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

export const runExport = (options: ExportOptions) =>
  Effect.gen(function* () {
    const owned = new Map<number, number>();
    let zeroQuantity = 0;
    for (const card of options.collection.cards) {
      if (card.qty > 0) owned.set(card.grpId, card.qty);
      else zeroQuantity++;
    }
    if (owned.size === 0) {
      return yield* new ExportError({ message: 'Collection snapshot contains no owned cards' });
    }

    // The store is released when the surrounding scope closes, on success or failure.
    const store = yield* Effect.acquireRelease(
      MetadataDatabase,
      (acquired) => Effect.sync(() => acquired.close())
    );
    const ids = [...owned.keys()];
    const metadata = yield* store.lookup(ids);
    const missing = ids.filter(id => !metadata.has(id));
    let fallbackRows = 0;
    let rawPath: string | null = null;
    if (missing.length > 0) {
      const toolRarity = yield* store.rarityByGrpId();
      const fallback = yield* lookupRawCards(missing, toolRarity);
      for (const [id, card] of fallback.metadata) metadata.set(id, card);
      fallbackRows = fallback.metadata.size;
      rawPath = fallback.rawPath;
    }
    const unresolved = ids.filter(id => !metadata.has(id));
    if (unresolved.length > 0) {
      return yield* new ExportError({ message: `Cannot resolve owned card IDs: ${unresolved.join(', ')}` });
    }

    const cards: Array<ExportedCard> = [];
    for (const id of ids) {
      const meta = metadata.get(id);
      const quantity = owned.get(id);
      if (meta === undefined || quantity === undefined) {
        return yield* new ExportError({ message: `Missing metadata for ${id}` });
      }
      if (meta.name.trim() === '') {
        return yield* new ExportError({ message: `Missing card name for ${id}` });
      }
      if (!RARITIES.has(meta.rarity)) {
        return yield* new ExportError({ message: `Invalid rarity label for ${meta.name}: ${meta.rarity}` });
      }
      cards.push({ ...meta, arena_id: id, quantity });
    }
    cards.sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
        a.set_code.localeCompare(b.set_code) ||
        a.collector_number.localeCompare(b.collector_number) ||
        a.arena_id - b.arena_id
    );

    yield* Effect.try({
      try: () => fs.mkdirSync(options.outDir, { recursive: true }),
      catch: (cause) => new ExportError({ message: `Cannot create output directory ${options.outDir}: ${String(cause)}` }),
    });
    const csvPath = path.join(options.outDir, 'mtga-owned-cards.csv');
    const jsonPath = path.join(options.outDir, 'mtga-owned-cards.json');
    for (const file of [csvPath, jsonPath]) {
      if (fs.existsSync(file) && !options.overwrite) {
        return yield* new OverwriteRefused({ path: file, hint: 'Pass --overwrite to replace it.' });
      }
    }

    const rows = cards.map(card => [
      String(card.quantity),
      card.name,
      card.digital_set ?? card.set_code,
      card.collector_number,
      card.rarity,
      String(card.arena_id),
      String(card.is_digital_only),
      String(card.is_rebalanced),
      card.cmc === null ? '' : String(card.cmc),
      card.full_type,
    ]);
    const csv = '\ufeff' + [CSV_HEADERS.join(';'), ...rows.map(row => row.map(csvCell).join(';'))].join('\r\n') + '\r\n';
    const payload = {
      source: options.sourceLabel,
      includes_basic_lands: true,
      includes_digital_cards: true,
      cards,
    };
    yield* Effect.try({
      try: () => {
        fs.writeFileSync(csvPath, csv, 'utf8');
        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
      },
      catch: (cause) => new ExportError({ message: `Failed writing exports: ${String(cause)}` }),
    });

    // Validate what was actually written, against the raw snapshot.
    const written = yield* Effect.try({
      try: () => fs.readFileSync(csvPath, 'utf8').replace(/^\ufeff/, ''),
      catch: (cause) => new ExportError({ message: `Cannot re-read ${csvPath}: ${String(cause)}` }),
    });
    const dataLines = written.split('\r\n').filter(line => line !== '').slice(1);
    if (dataLines.length !== owned.size) {
      return yield* new ExportError({
        message: `Export row count mismatch: ${dataLines.length} rows for ${owned.size} cards`,
      });
    }
    const countsFromCsv = new Map<number, number>();
    for (const line of dataLines) {
      const cells = splitCsvRow(line);
      const count = Number(cells[0] ?? 'NaN');
      const arenaId = Number(cells[5] ?? 'NaN');
      countsFromCsv.set(arenaId, count);
    }
    if (!mapEquals(countsFromCsv, owned)) {
      return yield* new ExportError({ message: 'Export counts differ from the live collection' });
    }
    const savedRaw = yield* Effect.try({
      try: () => JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as unknown,
      catch: (cause) => new ExportError({ message: `Cannot re-read ${jsonPath}: ${String(cause)}` }),
    });
    const saved = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(WrittenExport)(savedRaw),
      catch: (cause) => new ExportError({ message: `Written JSON export failed validation: ${String(cause)}` }),
    });
    const countsFromJson = new Map<number, number>(saved.cards.map(card => [card.arena_id, card.quantity]));
    if (!mapEquals(countsFromJson, owned)) {
      return yield* new ExportError({ message: 'JSON export count mismatch' });
    }
    for (const card of saved.cards) {
      if (card.name.trim() === '') {
        return yield* new ExportError({ message: 'Unnamed exported card' });
      }
    }

    const rarityRows: Record<string, number> = {};
    for (const card of cards) {
      rarityRows[card.rarity] = (rarityRows[card.rarity] ?? 0) + 1;
    }
    const summary: ExportSummary = {
      csv: csvPath,
      json: jsonPath,
      owned_rows: owned.size,
      distinct_names: new Set(cards.map(card => card.name)).size,
      native_zero_quantity_rows_excluded: zeroQuantity,
      all_ids_resolved: true,
      game_database_fallback_rows: fallbackRows,
      game_database: rawPath,
      metadata_database: { path: store.path, source: store.source },
      basic_land_rows: cards.filter(
        card => /land/i.test(card.full_type) && /basic/i.test(card.full_type)
      ).length,
      digital_only_rows: cards.filter(card => card.is_digital_only).length,
      rebalanced_rows: cards.filter(card => card.is_rebalanced).length,
      rarity_rows: rarityRows,
      samples: cards.slice(0, 5).map(card => ({ count: card.quantity, name: card.name })),
    };
    yield* Effect.sync(() => {
      console.log(JSON.stringify(summary, null, 2));
    });
    return summary;
  });
