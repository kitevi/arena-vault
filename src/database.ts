import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Context, Effect, Layer, Schema } from 'effect';
import {
  JsonCardEntry,
  JsonDatabase,
  SqliteCardRow,
  SqliteRarityRow,
  jsonEntryToMetadata,
  sqliteRowToMetadata,
} from './domain.js';
import type { CardMetadata } from './domain.js';
import { LatestVersion } from './domain.js';
import { DownloadError, MetadataError } from './errors.js';
import { DATA_DIR, MTGATOOL_DIR } from './paths.js';

const BASE_URL = 'https://mtgatool.com/api/database';
const JSON_PATTERN = /^v(\d+)-en-database\.json$/;
const SQLITE_PATTERN = /^v(\d+)-en-database\.sqlite$/;

const SQLITE_COLUMNS = [
  'grpid', 'name', 'full_name', 'rarity', 'set_code', 'digital_set', 'collector_number',
  'is_primary', 'is_token', 'is_digital_only', 'is_rebalanced', 'rebalanced_grpid',
  'color_identity', 'colors', 'cmc', 'full_type', 'mana_cost', 'linked_face_grpids',
] as const;

export interface MetadataStore {
  readonly path: string;
  readonly source: string;
  readonly version: number | undefined;
  readonly lookup: (ids: ReadonlyArray<number>) => Effect.Effect<Map<number, CardMetadata>, MetadataError>;
  readonly rarityByGrpId: () => Effect.Effect<Map<number, string>, MetadataError>;
  readonly close: () => void;
}

export class MetadataDatabase extends Context.Service<MetadataDatabase, MetadataStore>()(
  'arena-vault/database/MetadataDatabase'
) {
  static readonly layer = (explicit: string | undefined): Layer.Layer<MetadataDatabase, MetadataError> =>
    Layer.effect(MetadataDatabase, resolveMetadataStore(explicit));
}

function makeJsonStore(file: string, source: string, version: number | undefined): MetadataStore {
  let cache: Map<number, CardMetadata> | null = null;
  let rarities: Map<number, string> | null = null;
  const load = Effect.fnUntraced(function* (): Effect.fn.Return<void, MetadataError> {
    if (cache !== null && rarities !== null) return;
    const raw = yield* Effect.try({
      try: () => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
      catch: (cause) => new MetadataError({ message: `Cannot read JSON database ${file}: ${String(cause)}` }),
    });
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(JsonDatabase)(raw),
      catch: (cause) => new MetadataError({ message: `Invalid JSON database ${file}: ${String(cause)}` }),
    });
    const entries = yield* Effect.try({
      try: () => {
        const out: Array<[number, JsonCardEntry]> = [];
        for (const [key, value] of Object.entries(decoded.cards)) {
          out.push([Number(key), Schema.decodeUnknownSync(JsonCardEntry)(value)]);
        }
        return out;
      },
      catch: (cause) => new MetadataError({ message: `Invalid card entries in ${file}: ${String(cause)}` }),
    });
    const cards = new Map<number, CardMetadata>();
    const labels = new Map<number, string>();
    for (const [grpid, entry] of entries) {
      const metadata = jsonEntryToMetadata(entry);
      cards.set(grpid, metadata);
      labels.set(grpid, metadata.rarity);
    }
    cache = cards;
    rarities = labels;
  });
  return {
    path: file,
    source,
    version,
    lookup: (ids) =>
      Effect.gen(function* () {
        yield* load();
        const cards = cache;
        if (cards === null) {
          return yield* new MetadataError({ message: `JSON database ${file} not loaded` });
        }
        const found = new Map<number, CardMetadata>();
        for (const id of ids) {
          const hit = cards.get(id);
          if (hit !== undefined) found.set(id, hit);
        }
        return found;
      }),
    rarityByGrpId: () =>
      Effect.gen(function* () {
        yield* load();
        const labels = rarities;
        if (labels === null) {
          return yield* new MetadataError({ message: `JSON database ${file} not loaded` });
        }
        return labels;
      }),
    close: () => {
      cache = null;
      rarities = null;
    },
  };
}

function makeSqliteStore(
  file: string,
  source: string,
  version: number | undefined
): Effect.Effect<MetadataStore, MetadataError> {
  return Effect.gen(function* () {
    const db = yield* Effect.try({
      try: () => new DatabaseSync(file, { readOnly: true }),
      catch: (cause) => new MetadataError({ message: `Cannot open sqlite database ${file}: ${String(cause)}` }),
    });
    return {
      path: file,
      source,
      version,
      lookup: (ids: ReadonlyArray<number>) =>
        Effect.try({
          try: () => {
            const metadata = new Map<number, CardMetadata>();
            for (let start = 0; start < ids.length; start += 400) {
              const batch = ids.slice(start, start + 400);
              const sql = `SELECT ${SQLITE_COLUMNS.join(',')} FROM cards WHERE grpid IN (${batch.map(() => '?').join(',')})`;
              for (const row of db.prepare(sql).all(...batch) as Array<unknown>) {
                const decoded = Schema.decodeUnknownSync(SqliteCardRow)(row);
                metadata.set(decoded.grpid, sqliteRowToMetadata(decoded));
              }
            }
            return metadata;
          },
          catch: (cause) => new MetadataError({ message: `Query failed on ${file}: ${String(cause)}` }),
        }),
      rarityByGrpId: () =>
        Effect.try({
          try: () => {
            const labels = new Map<number, string>();
            for (const row of db.prepare('SELECT grpid, rarity FROM cards').all() as Array<unknown>) {
              const decoded = Schema.decodeUnknownSync(SqliteRarityRow)(row);
              labels.set(decoded.grpid, decoded.rarity);
            }
            return labels;
          },
          catch: (cause) => new MetadataError({ message: `Query failed on ${file}: ${String(cause)}` }),
        }),
      close: () => {
        db.close();
      },
    } satisfies MetadataStore;
  });
}

interface FileCandidate {
  readonly file: string;
  readonly source: string;
  readonly version: number;
}

function scanJsonDownloads(): Array<FileCandidate> {
  let entries: Array<string>;
  try {
    entries = fs.readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  const found: Array<FileCandidate> = [];
  for (const name of entries) {
    const match = JSON_PATTERN.exec(name);
    if (match !== null) {
      found.push({ file: path.join(DATA_DIR, name), source: 'arena-vault data download', version: Number(match[1] ?? 0) });
    }
  }
  return found.sort((a, b) => b.version - a.version);
}

function scanSqliteFiles(): Array<FileCandidate> {
  const found: Array<FileCandidate> = [];
  for (const dir of [DATA_DIR, MTGATOOL_DIR]) {
    let entries: Array<string>;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const match = SQLITE_PATTERN.exec(name);
      if (match !== null) {
        found.push({
          file: path.join(dir, name),
          source: dir === DATA_DIR ? 'arena-vault data download' : 'MTG Arena Tool local database',
          version: Number(match[1] ?? 0),
        });
      }
    }
  }
  return found.sort((a, b) => b.version - a.version);
}

export const fetchLatestVersion = Effect.fnUntraced(
  function* (): Effect.fn.Return<number, DownloadError> {
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${BASE_URL}/latest`),
      catch: (cause) => new DownloadError({ message: `mtgatool latest endpoint failed: ${String(cause)}` }),
    });
    if (!res.ok) {
      return yield* new DownloadError({ message: `mtgatool latest endpoint failed: HTTP ${res.status}` });
    }
    const body = yield* Effect.tryPromise({
      try: () => res.json() as Promise<unknown>,
      catch: (cause) => new DownloadError({ message: `Invalid latest response: ${String(cause)}` }),
    });
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(LatestVersion)(body),
      catch: (cause) => new DownloadError({ message: `Unexpected mtgatool latest response: ${String(cause)}` }),
    });
    return decoded.latest;
  }
);

/** Download the newest JSON database into data/. The endpoint serves JSON regardless of the requested filename. */
export const downloadDatabase = Effect.fnUntraced(
  function* (): Effect.fn.Return<MetadataStore, DownloadError | MetadataError> {
    const version = yield* fetchLatestVersion();
    const name = `v${version}-en-database.json`;
    const dest = path.join(DATA_DIR, name);
    const res = yield* Effect.tryPromise({
      try: () => fetch(`${BASE_URL}/${name}`),
      catch: (cause) => new DownloadError({ message: `Download failed for ${name}: ${String(cause)}` }),
    });
    if (!res.ok) {
      return yield* new DownloadError({ message: `Download failed for ${name}: HTTP ${res.status}` });
    }
    const text = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (cause) => new DownloadError({ message: `Download failed for ${name}: ${String(cause)}` }),
    });
    if (text.length <= 1_000_000) {
      return yield* new DownloadError({ message: `Suspiciously small database download: ${text.length} characters` });
    }
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(JsonDatabase)(JSON.parse(text) as unknown),
      catch: (cause) => new DownloadError({ message: `Downloaded file is not a mtgatool card database: ${String(cause)}` }),
    });
    if (Object.keys(decoded.cards).length <= 1000) {
      return yield* new DownloadError({ message: 'Downloaded database has too few cards' });
    }
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(dest, text);
      },
      catch: (cause) => new DownloadError({ message: `Cannot write ${dest}: ${String(cause)}` }),
    });
    return makeJsonStore(dest, `downloaded from mtgatool.com (v${version})`, version);
  }
);

/** Prefer a downloaded JSON database, then any v*-en-database.sqlite on disk, highest version wins. */
export const resolveMetadataStore = Effect.fnUntraced(
  function* (explicit: string | undefined): Effect.fn.Return<MetadataStore, MetadataError> {
    if (explicit !== undefined) {
      if (!fs.existsSync(explicit)) {
        return yield* new MetadataError({ message: `Metadata database not found: ${explicit}` });
      }
      const versionMatch = /v(\d+)-/.exec(path.basename(explicit));
      const version = versionMatch !== null ? Number(versionMatch[1] ?? 0) : undefined;
      return explicit.endsWith('.json')
        ? makeJsonStore(explicit, 'explicit path', version)
        : yield* makeSqliteStore(explicit, 'explicit path', version);
    }
    const json = scanJsonDownloads()[0];
    if (json !== undefined) {
      return makeJsonStore(json.file, json.source, json.version);
    }
    const sqlite = scanSqliteFiles()[0];
    if (sqlite !== undefined) {
      return yield* makeSqliteStore(sqlite.file, sqlite.source, sqlite.version);
    }
    return yield* new MetadataError({
      message: 'No card metadata database found. Run `npm run db -- --download` to fetch one from mtgatool.com, or install MTG Arena Tool.',
    });
  }
);
