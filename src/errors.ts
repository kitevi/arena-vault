import { Schema } from 'effect';

export class UsageError extends Schema.TaggedError<UsageError>()('UsageError', {
  message: Schema.String,
}) {}

export class SnapshotError extends Schema.TaggedError<SnapshotError>()('SnapshotError', {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export class ReaderError extends Schema.TaggedError<ReaderError>()('ReaderError', {
  reason: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

export class MetadataError extends Schema.TaggedError<MetadataError>()('MetadataError', {
  message: Schema.String,
}) {}

export class DownloadError extends Schema.TaggedError<DownloadError>()('DownloadError', {
  message: Schema.String,
}) {}

export class RawDatabaseError extends Schema.TaggedError<RawDatabaseError>()('RawDatabaseError', {
  message: Schema.String,
}) {}

export class ExportError extends Schema.TaggedError<ExportError>()('ExportError', {
  message: Schema.String,
}) {}

export class OverwriteRefused extends Schema.TaggedError<OverwriteRefused>()('OverwriteRefused', {
  path: Schema.String,
  hint: Schema.optional(Schema.String),
}) {}

export function renderError(error: unknown): string {
  if (error instanceof Error && '_tag' in error) {
    const tagged = error as { _tag: string; message?: string; reason?: string; hint?: string; path?: string };
    // TaggedError instances default message to '' when the schema has no message field,
    // so select the first non-empty field rather than the first defined one.
    const headline = [tagged.message, tagged.reason, tagged.path].find(
      (part) => part !== undefined && part !== null && part !== ''
    ) ?? 'unknown error';
    const lines = [`${tagged._tag}: ${headline}`];
    if (tagged.hint !== undefined && tagged.hint !== '') lines.push(tagged.hint);
    return lines.join('\n');
  }
  return error instanceof Error ? error.message : String(error);
}
