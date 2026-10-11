# arena-vault

Read your MTG Arena collection straight from the running game and export it as CSV/JSON with full card metadata.

It is built from the standalone pieces of the open-source **MTG Arena Tool** ecosystem — no Electron app required:

- **[mtga-reader](https://github.com/mtgatool/mtga-reader)** (GPL-3.0, on npm) — reads the collection from the live game process via `readCollection('MTGA')`.
- **[mtgatool metadata](https://github.com/mtgatool/mtgatool-metadata)** — card names, sets, rarities, colors, and format legality. arena-vault downloads the latest JSON database from `mtgatool.com/api/database` and indexes it in memory, or reuses the MTG Arena Tool app's local sqlite — whichever it finds first.
- **Arena's own raw card database** (`~/Library/Application Support/com.wizards.mtga/Downloads/Raw/`) — fallback for brand-new sets the metadata database has not caught up with yet. This is what fixed the Reality Fracture "missing IDs" problem.

## Requirements

- Node.js 24+ (`node:sqlite` ships as a release-candidate module; developed and tested on Node 26)
- MTG Arena installed
- On macOS, memory reading requires root — see below

## Setup

```sh
npm install
```

## Usage

```sh
# Check which metadata database is in use (and whether a newer one exists)
npm run db

# Download the latest metadata database into data/
npm run db -- --download

# Export your collection — MTG Arena must be running
sudo env PATH="$PATH" npm run export

# Offline rerun from a saved snapshot
npm run export -- --from-snapshot data/snapshots/collection-<timestamp>.json
```

Extra flags: `--out-dir DIR`, `--tool-db FILE`, `--overwrite`.

Outputs land in `exports/`:

- `mtga-owned-cards.csv` — Excel-friendly (semicolon-delimited, UTF-8 BOM)
- `mtga-owned-cards.json` — `cards: [{ arena_id, quantity, name, set_code, collector_number, rarity, cmc, ... }]`

Every live export also saves the raw snapshot to `data/snapshots/`, so you can re-run or debug offline.

## Conventions

- **Everything flows through [Effect 4](https://effect.website)** — services are `Context.Service`s (`MtgaReader`, `MetadataDatabase`), errors are `Schema.TaggedError`s, and all I/O (fs, fetch, sqlite, game memory) is Effect-wrapped with typed errors.
- **Schema-validated decoding** — the memory read, saved snapshots, the mtgatool JSON database, and sqlite rows are all decoded through Effect `Schema` classes before use; no unvalidated `any` crosses a module boundary.
- **Maximum TypeScript strictness** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`, `skipLibCheck: false`.
- **No package-lock.json** — `.npmrc` sets `package-lock=false`; dependencies resolve from `package.json`.

## How it works

1. `mtga-reader` reads `{ cards: [{ grpId, qty }] }` from the running game's memory — untrusted input, decoded through the `CardCount` schema before anything else touches it.
2. Those IDs are joined against the metadata database (the downloaded JSON or a local sqlite); every row is Schema-decoded into a normalized `CardMetadata`.
3. IDs the metadata database does not know yet (new sets) fall back to Arena's own raw card database on disk, including a numeric-rarity → label mapping derived from shared printings.
4. CSV and JSON are written, then re-read and validated against the raw snapshot (row counts, per-card counts, names).

## Caveats

- **node:sqlite is release-candidate stability** even in current Node — if a Node update ever breaks it, pin the version you know works (26.x is what this project is tested on).
- **macOS root**: reading another process's memory needs `task_for_pid`, which requires root (or a debugger entitlement). Hence `sudo env PATH="$PATH" npm run export`.
- **New sets**: the mtgatool metadata database can lag a set by ~a day; the raw-database fallback covers that gap automatically.
- **Legality/bans**: the metadata sqlite contains format legality bitmasks (`legal_0`…`legal_5` with `formats.word`/`formats.mask`), but ban lists change — check [the official B&R page](https://magic.wizards.com/en/banned-restricted-list) before building decks.

## License

GPL-3.0-only, matching `mtga-reader`, which this project depends on. Metadata from mtgatool.com is free to use with credit to Manuel Etchegaray / MTG Arena Tool.
