import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(here, '..');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const SNAPSHOTS_DIR = path.join(DATA_DIR, 'snapshots');
export const EXPORTS_DIR = path.join(PROJECT_ROOT, 'exports');
export const HOME = homedir();
export const MTGATOOL_DIR = path.join(HOME, 'Library/Application Support/mtgatool-desktop');
export const ARENA_RAW_DIR = path.join(HOME, 'Library/Application Support/com.wizards.mtga/Downloads/Raw');
