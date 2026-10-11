import fs from 'node:fs';
import path from 'node:path';
import { Effect, Schema } from 'effect';
import { CollectionSnapshot } from './domain.js';
import type { RawCollection } from './domain.js';
import { SnapshotError } from './errors.js';
import { SNAPSHOTS_DIR } from './paths.js';
import { timestamp } from './util.js';

export const loadSnapshot = Effect.fnUntraced(
  function* (file: string): Effect.fn.Return<RawCollection, SnapshotError> {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(fs.readFileSync(file, 'utf8')) as unknown,
      catch: (cause) => new SnapshotError({ message: `Cannot read snapshot: ${String(cause)}`, path: file }),
    });
    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(CollectionSnapshot)(parsed),
      catch: (cause) => new SnapshotError({ message: `Snapshot failed schema validation: ${String(cause)}`, path: file }),
    });
    return { cards: decoded.cards };
  }
);

export const saveSnapshot = Effect.fnUntraced(
  function* (cards: RawCollection['cards']): Effect.fn.Return<string, SnapshotError> {
    const file = path.join(SNAPSHOTS_DIR, `collection-${timestamp()}.json`);
    yield* Effect.try({
      try: () => {
        fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
        fs.writeFileSync(
          file,
          JSON.stringify(
            { source: 'mtga-reader live readCollection(MTGA)', savedAt: new Date().toISOString(), cards },
            null,
            2
          )
        );
      },
      catch: (cause) => new SnapshotError({ message: `Cannot save snapshot: ${String(cause)}`, path: file }),
    });
    return file;
  }
);
