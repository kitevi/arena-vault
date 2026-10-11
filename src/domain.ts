import { Schema } from 'effect';

/** Normalized card metadata in the export shape (snake_case keys). */
export interface CardMetadata {
  readonly name: string;
  readonly full_name: string;
  readonly rarity: string;
  readonly set_code: string;
  readonly digital_set: string | null;
  readonly collector_number: string;
  readonly is_primary: boolean;
  readonly is_token: boolean;
  readonly is_digital_only: boolean;
  readonly is_rebalanced: boolean;
  readonly rebalanced_grpid: number | null;
  readonly color_identity: string;
  readonly colors: string;
  readonly cmc: number | null;
  readonly full_type: string;
  readonly mana_cost: string | null;
  readonly arena_mana_text: string | null;
  readonly linked_face_grpids: string | number | null;
  readonly catalog_source: string;
}

/** Raw collection entries as produced by mtga-reader and saved snapshots. */
export interface RawCardCount {
  readonly grpId: number;
  readonly qty: number;
}

export interface RawCollection {
  readonly cards: ReadonlyArray<RawCardCount>;
}

export type ExportedCard = CardMetadata & { readonly arena_id: number; readonly quantity: number };

/** 0/1 ints and true/false both appear across our sources; accept both. */
const Flag = Schema.Union([Schema.Boolean, Schema.BooleanFromBit]);

export class CardCount extends Schema.Class<CardCount>('arena-vault/domain/CardCount')({
  // qty > 4 is legitimate for basic lands, but nothing sane exceeds 1000.
  grpId: Schema.Int.check(Schema.isGreaterThan(0)),
  qty: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
}) {}

export class CollectionSnapshot extends Schema.Class<CollectionSnapshot>('arena-vault/domain/CollectionSnapshot')({
  source: Schema.optional(Schema.String),
  savedAt: Schema.optional(Schema.String),
  cards: Schema.Array(CardCount),
}) {}

/** Envelope of the mtgatool.com JSON card database. */
export class JsonDatabase extends Schema.Class<JsonDatabase>('arena-vault/domain/JsonDatabase')({
  ok: Schema.Literal(true),
  version: Schema.optional(Schema.String),
  cards: Schema.Record(Schema.String, Schema.Unknown),
}) {}

/** One card entry inside the mtgatool.com JSON database. */
export class JsonCardEntry extends Schema.Class<JsonCardEntry>('arena-vault/domain/JsonCardEntry')({
  GrpId: Schema.Int,
  Name: Schema.String,
  Set: Schema.String,
  Rarity: Schema.String,
  DigitalSet: Schema.optional(Schema.String),
  CollectorNumber: Schema.optional(Schema.String),
  IsPrimaryCard: Schema.optional(Flag),
  IsToken: Schema.optional(Flag),
  IsDigitalOnly: Schema.optional(Flag),
  IsRebalanced: Schema.optional(Flag),
  RebalancedCardGrpId: Schema.optional(Schema.Int),
  ManaCost: Schema.optional(Schema.Array(Schema.String)),
  Cmc: Schema.optional(Schema.Number),
  Colors: Schema.optional(Schema.Array(Schema.Int)),
  ColorIdentity: Schema.optional(Schema.Array(Schema.Int)),
  Supertypes: Schema.optional(Schema.String),
  Types: Schema.optional(Schema.String),
  Subtypes: Schema.optional(Schema.String),
  LinkedFaceGrpIds: Schema.optional(Schema.Union([Schema.Array(Schema.Int), Schema.String])),
}) {}

/** One row of the v*-en-database.sqlite `cards` table. */
export class SqliteCardRow extends Schema.Class<SqliteCardRow>('arena-vault/domain/SqliteCardRow')({
  grpid: Schema.Int,
  name: Schema.String,
  full_name: Schema.optional(Schema.String),
  rarity: Schema.String,
  set_code: Schema.optional(Schema.String),
  digital_set: Schema.optional(Schema.NullOr(Schema.String)),
  collector_number: Schema.optional(Schema.NullOr(Schema.String)),
  is_primary: Schema.optional(Flag),
  is_token: Schema.optional(Flag),
  is_digital_only: Schema.optional(Flag),
  is_rebalanced: Schema.optional(Flag),
  rebalanced_grpid: Schema.optional(Schema.NullOr(Schema.Int)),
  color_identity: Schema.optional(Schema.NullOr(Schema.String)),
  colors: Schema.optional(Schema.NullOr(Schema.String)),
  cmc: Schema.optional(Schema.NullOr(Schema.Number)),
  full_type: Schema.optional(Schema.NullOr(Schema.String)),
  mana_cost: Schema.optional(Schema.NullOr(Schema.String)),
  linked_face_grpids: Schema.optional(Schema.Unknown),
}) {}

export const SqliteRarityRow = Schema.Struct({
  grpid: Schema.Int,
  rarity: Schema.String,
});

/** One row of Arena's Raw_CardDatabase fallback query. */
export class RawCardRow extends Schema.Class<RawCardRow>('arena-vault/domain/RawCardRow')({
  GrpId: Schema.Int,
  CardName: Schema.String,
  Rarity: Schema.Int,
  ExpansionCode: Schema.optional(Schema.String),
  DigitalReleaseSet: Schema.optional(Schema.NullOr(Schema.String)),
  CollectorNumber: Schema.optional(Schema.NullOr(Schema.String)),
  IsPrimaryCard: Schema.optional(Flag),
  IsToken: Schema.optional(Flag),
  IsDigitalOnly: Schema.optional(Flag),
  IsRebalanced: Schema.optional(Flag),
  RebalancedCardGrpId: Schema.optional(Schema.Int),
  ColorIdentity: Schema.optional(Schema.NullOr(Schema.String)),
  Colors: Schema.optional(Schema.NullOr(Schema.String)),
  Order_CMCWithXLast: Schema.optional(Schema.NullOr(Schema.Int)),
  TypeName: Schema.optional(Schema.NullOr(Schema.String)),
  SubtypeName: Schema.optional(Schema.NullOr(Schema.String)),
  OldSchoolManaText: Schema.optional(Schema.NullOr(Schema.String)),
  LinkedFaceGrpIds: Schema.optional(Schema.Unknown),
}) {}

export const RawRarityRow = Schema.Struct({
  GrpId: Schema.Int,
  Rarity: Schema.Int,
});

/** mtgatool.com /api/database/latest response. */
export const LatestVersion = Schema.Struct({
  latest: Schema.Int,
  lang: Schema.optional(Schema.String),
  updated: Schema.optional(Schema.Number),
});

/** Round-trip check shape for the JSON export we just wrote. */
export const WrittenExport = Schema.Struct({
  cards: Schema.Array(Schema.Struct({
    arena_id: Schema.Int,
    quantity: Schema.Int,
    name: Schema.String,
  })),
});

function typeLine(supertypes: string | null | undefined, types: string | null | undefined, subtypes: string | null | undefined): string {
  const head = [supertypes, types]
    .map(part => part?.trim() ?? '')
    .filter(part => part !== '')
    .join(' ');
  const sub = subtypes?.trim() ?? '';
  if (head !== '' && sub !== '') return `${head} — ${sub}`;
  return head !== '' ? head : sub;
}

function linkedFace(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && value > 0 ? value : null;
}

function nonEmptyOrNull(value: string | null | undefined): string | null {
  return value !== undefined && value !== null && value !== '' ? value : null;
}

function parseBitList(value: string | null | undefined): Array<number> {
  const text = (value ?? '').replace(/^\[/, '').replace(/\]$/, '');
  return text.split(',').map(part => part.trim()).filter(part => part !== '').map(Number);
}

export function jsonEntryToMetadata(entry: JsonCardEntry): CardMetadata {
  return {
    name: entry.Name,
    full_name: entry.Name,
    rarity: entry.Rarity,
    set_code: entry.Set,
    digital_set: nonEmptyOrNull(entry.DigitalSet),
    collector_number: entry.CollectorNumber ?? '',
    is_primary: entry.IsPrimaryCard ?? true,
    is_token: entry.IsToken ?? false,
    is_digital_only: entry.IsDigitalOnly ?? false,
    is_rebalanced: entry.IsRebalanced ?? false,
    rebalanced_grpid: positiveOrNull(entry.RebalancedCardGrpId),
    color_identity: JSON.stringify(entry.ColorIdentity ?? []),
    colors: JSON.stringify(entry.Colors ?? []),
    cmc: entry.Cmc ?? null,
    full_type: typeLine(entry.Supertypes, entry.Types, entry.Subtypes),
    mana_cost: entry.ManaCost !== undefined && entry.ManaCost.length > 0 ? JSON.stringify(entry.ManaCost) : null,
    arena_mana_text: null,
    linked_face_grpids: linkedFace(entry.LinkedFaceGrpIds),
    catalog_source: 'mtgatool.com JSON database',
  };
}

export function sqliteRowToMetadata(row: SqliteCardRow): CardMetadata {
  return {
    name: row.name,
    full_name: row.full_name ?? row.name,
    rarity: row.rarity,
    set_code: row.set_code ?? '',
    digital_set: nonEmptyOrNull(row.digital_set),
    collector_number: row.collector_number ?? '',
    is_primary: row.is_primary ?? true,
    is_token: row.is_token ?? false,
    is_digital_only: row.is_digital_only ?? false,
    is_rebalanced: row.is_rebalanced ?? false,
    rebalanced_grpid: positiveOrNull(row.rebalanced_grpid),
    color_identity: row.color_identity ?? '[]',
    colors: row.colors ?? '[]',
    cmc: row.cmc ?? null,
    full_type: row.full_type ?? '',
    mana_cost: row.mana_cost ?? null,
    arena_mana_text: null,
    linked_face_grpids: linkedFace(row.linked_face_grpids),
    catalog_source: 'MTG Arena Tool sqlite database',
  };
}

export function rawRowToMetadata(row: RawCardRow, rarity: string): CardMetadata {
  return {
    name: row.CardName,
    full_name: row.CardName,
    rarity,
    set_code: row.ExpansionCode ?? '',
    digital_set: nonEmptyOrNull(row.DigitalReleaseSet),
    collector_number: row.CollectorNumber ?? '',
    is_primary: row.IsPrimaryCard ?? true,
    is_token: row.IsToken ?? false,
    is_digital_only: row.IsDigitalOnly ?? false,
    is_rebalanced: row.IsRebalanced ?? false,
    rebalanced_grpid: positiveOrNull(row.RebalancedCardGrpId),
    color_identity: JSON.stringify(parseBitList(row.ColorIdentity)),
    colors: JSON.stringify(parseBitList(row.Colors)),
    cmc: row.Order_CMCWithXLast ?? null,
    full_type: typeLine(undefined, row.TypeName, row.SubtypeName),
    mana_cost: null,
    arena_mana_text: row.OldSchoolManaText ?? null,
    linked_face_grpids: linkedFace(row.LinkedFaceGrpIds),
    catalog_source: 'Arena local card database',
  };
}
