// Validate Arena deck files against the collection and Standard legality.
// Usage: node scripts/check-deck.mjs decks/*.txt [--refresh]
import fs from 'node:fs';
import { BASICS, ownedByName, parseDeck, standardLegality } from './lib.mjs';

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('Usage: node scripts/check-deck.mjs <deck.txt>... [--refresh]');
  process.exit(1);
}

const owned = ownedByName();
let failed = false;

for (const file of files) {
  const { deck, sideboard } = parseDeck(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const counts = new Map();
  for (const entry of [...deck, ...sideboard]) counts.set(entry.name, (counts.get(entry.name) ?? 0) + entry.count);

  const mainCount = deck.reduce((n, e) => n + e.count, 0);
  if (mainCount < 60) problems.push(`main deck has ${mainCount} cards (need 60)`);
  if (sideboard.reduce((n, e) => n + e.count, 0) > 15) problems.push('sideboard over 15 cards');

  for (const [name, count] of counts) {
    const have = owned.get(name);
    if (!BASICS.has(name) && count > 4) problems.push(`${count}x ${name} (max 4)`);
    if (!have) problems.push(`not owned: ${name}`);
    else if (!BASICS.has(name) && have.quantity < count) problems.push(`own ${have.quantity} of ${count}x ${name}`);
  }
  for (const entry of deck) {
    const have = owned.get(entry.name);
    if (have && entry.set && !have.printings.some((p) => p.set_code === entry.set)) {
      const sets = [...new Set(have.printings.map((p) => p.set_code))].join('/');
      problems.push(`no ${entry.set} printing of ${entry.name} (own ${sets}); Arena will substitute on import`);
    }
  }

  const legality = await standardLegality([...counts.keys()], { refresh });
  for (const [name, status] of legality) {
    if (status !== 'legal') problems.push(`Standard: ${name} is ${status}`);
  }

  console.log(`${problems.length === 0 ? 'OK  ' : 'FAIL'} ${file} (${mainCount} main)`);
  for (const p of problems) console.log(`     - ${p}`);
  if (problems.length > 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
