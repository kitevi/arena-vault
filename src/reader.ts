import { Context, Effect, Layer, Schema } from 'effect';
import { findProcess, isAdmin, readCollection } from 'mtga-reader';
import { CardCount } from './domain.js';
import type { RawCollection } from './domain.js';
import { ReaderError } from './errors.js';

const PROCESS = 'MTGA';

const readCollectionLive = Effect.fn(
  'MtgaReader.readCollection'
)(function* (): Effect.fn.Return<RawCollection, ReaderError> {
  if (process.platform === 'darwin' && (process.getuid?.() ?? 0) !== 0) {
    return yield* new ReaderError({
      reason: 'Reading MTG Arena memory on macOS requires root.',
      hint: 'Re-run as:\n  sudo env PATH="$PATH" npm run export',
    });
  }
  if (!isAdmin()) {
    return yield* new ReaderError({ reason: 'mtga-reader reports insufficient privileges.', hint: 'Re-run with sudo.' });
  }
  const running = yield* Effect.tryPromise({
    try: () => findProcess(PROCESS),
    catch: (cause) => new ReaderError({ reason: `findProcess failed: ${String(cause)}` }),
  });
  if (!running) {
    return yield* new ReaderError({
      reason: 'MTG Arena does not appear to be running.',
      hint: 'Start the game and wait until it is loaded.',
    });
  }
  const result = yield* Effect.tryPromise({
    try: () => readCollection(PROCESS),
    catch: (cause) => new ReaderError({ reason: `readCollection threw: ${String(cause)}` }),
  });
  // mtga-reader resolves failures as { error } rather than rejecting.
  if (result.error !== undefined) {
    return yield* new ReaderError({
      reason: `mtga-reader readCollection failed: ${result.error}`,
      hint: 'Make sure MTG Arena is fully loaded (past the loading screen) and this command runs as root.',
    });
  }
  // A memory read is untrusted input: the schema rejects non-positive IDs and implausible quantities.
  const cards = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(Schema.Array(CardCount))(result.cards),
    catch: (cause) => new ReaderError({ reason: `Collection read failed schema validation: ${String(cause)}` }),
  });
  return { cards };
});

export class MtgaReader extends Context.Service<MtgaReader, {
  readonly readCollection: () => Effect.Effect<RawCollection, ReaderError>;
}>()('arena-vault/reader/MtgaReader') {
  static readonly layer = Layer.effect(
    MtgaReader,
    Effect.sync(() => MtgaReader.of({ readCollection: readCollectionLive }))
  );
}
