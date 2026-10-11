#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Effect, Option } from 'effect';
import { MetadataDatabase, downloadDatabase, fetchLatestVersion, resolveMetadataStore } from './database.js';
import { renderError } from './errors.js';
import { runExport } from './export.js';
import { EXPORTS_DIR } from './paths.js';
import { MtgaReader } from './reader.js';
import { loadSnapshot, saveSnapshot } from './snapshot.js';
import type { RawCollection } from './domain.js';
import { VERSION } from './util.js';

const USAGE = `arena-vault v${VERSION} — export your MTG Arena collection

Commands:
  export   Read the live collection (MTG Arena must be running) and export CSV+JSON
  db       Show or download the card metadata database

Options:
  --from-snapshot FILE   Offline export from a saved raw snapshot
  --out-dir DIR          Output directory (default: exports/)
  --tool-db FILE         Explicit metadata database (.json download or .sqlite)
  --download             (db) fetch the latest database from mtgatool.com
  --overwrite            Replace existing export files

macOS note: live export reads game memory and needs root:
  sudo env PATH="$PATH" npm run export
`;

interface CliArgs {
  readonly command: string | undefined;
  readonly fromSnapshot: string | undefined;
  readonly toolDb: string | undefined;
  readonly outDir: string | undefined;
  readonly overwrite: boolean;
  readonly download: boolean;
}

function parseCli(): CliArgs {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'from-snapshot': { type: 'string' },
      'tool-db': { type: 'string' },
      'out-dir': { type: 'string' },
      overwrite: { type: 'boolean' },
      download: { type: 'boolean' },
    },
  });
  const str = (key: 'from-snapshot' | 'tool-db' | 'out-dir'): string | undefined => {
    const value: unknown = values[key];
    return typeof value === 'string' ? value : undefined;
  };
  return {
    command: positionals[0],
    fromSnapshot: str('from-snapshot'),
    toolDb: str('tool-db'),
    outDir: str('out-dir'),
    overwrite: values['overwrite'] === true,
    download: values['download'] === true,
  };
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseCli();
  } catch (cause) {
    console.error(USAGE);
    console.error(String(cause));
    process.exit(1);
    return;
  }

  if (args.command === 'export') {
    const program = Effect.gen(function* () {
      let collection: RawCollection;
      let sourceLabel: string;
      if (args.fromSnapshot !== undefined) {
        collection = yield* loadSnapshot(args.fromSnapshot);
        sourceLabel = `arena-vault v${VERSION}; snapshot ${args.fromSnapshot}`;
      } else {
        const reader = yield* MtgaReader;
        collection = yield* reader.readCollection();
        const snapshotFile = yield* saveSnapshot(collection.cards);
        sourceLabel = `arena-vault v${VERSION}; mtga-reader live readCollection(MTGA); snapshot ${snapshotFile}`;
      }
      yield* runExport({
        collection,
        outDir: args.outDir ?? EXPORTS_DIR,
        sourceLabel,
        overwrite: args.overwrite,
      });
    });
    await Effect.runPromise(
      program.pipe(
        Effect.provide(MtgaReader.layer),
        Effect.provide(MetadataDatabase.layer(args.toolDb)),
        Effect.scoped
      )
    );
    return;
  }

  if (args.command === 'db') {
    if (args.download) {
      const store = await Effect.runPromise(
        Effect.acquireRelease(downloadDatabase(), (acquired) =>
          Effect.sync(() => acquired.close())
        ).pipe(Effect.scoped)
      );
      console.log(JSON.stringify({ path: store.path, source: store.source, version: store.version }, null, 2));
      return;
    }
    const info = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Effect.acquireRelease(
          resolveMetadataStore(args.toolDb),
          (acquired) => Effect.sync(() => acquired.close())
        );
        const latestOption = yield* Effect.option(fetchLatestVersion());
        const latest: number | string = Option.isSome(latestOption)
          ? latestOption.value
          : 'unknown (network unavailable)';
        const upToDate = Option.isSome(latestOption) && latestOption.value === store.version;
        return {
          path: store.path,
          source: store.source,
          version: store.version,
          latest,
          up_to_date: upToDate,
        };
      }).pipe(Effect.scoped)
    );
    console.log(JSON.stringify(info, null, 2));
    return;
  }

  console.error(USAGE);
  if (args.command !== undefined) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(renderError(error));
  process.exit(1);
});
