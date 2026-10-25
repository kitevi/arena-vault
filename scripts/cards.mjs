// Search owned cards by name, rules text, color, and Standard legality.
// Usage: node scripts/cards.mjs [--name STR] [--text REGEX] [--colors WUBRG] [--type STR] [--standard] [--max-cmc N]
//   --colors: color identity must be a subset of these ("C" alone = colorless only)
//   e.g. node scripts/cards.mjs --standard --colors WB --text "destroy all|exile all"
import { parseArgs } from 'node:util';
import { BASICS, cardText, ownedByName, standardLegality } from './lib.mjs';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    text: { type: 'string' },
    colors: { type: 'string' },
    type: { type: 'string' },
    'max-cmc': { type: 'string' },
    standard: { type: 'boolean' },
    refresh: { type: 'boolean' },
  },
});

// Export color codes: 1=W 2=U 3=B 4=R 5=G
const COLOR_CODES = { 1: 'W', 2: 'U', 3: 'B', 4: 'R', 5: 'G' };
const colorsOf = (card) =>
  String(card.color_identity ?? '')
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((d) => COLOR_CODES[d])
    .join('');

const allowed = values.colors?.toUpperCase().replace('C', '');
const textRe = values.text ? new RegExp(values.text, 'i') : null;
const maxCmc = values['max-cmc'] === undefined ? Infinity : Number(values['max-cmc']);

let hits = [...ownedByName().values()].filter((entry) => {
  const c = entry.printings[0];
  if (BASICS.has(entry.name)) return false;
  if (values.name && !entry.name.toLowerCase().includes(values.name.toLowerCase())) return false;
  if (values.type && !c.full_type.toLowerCase().includes(values.type.toLowerCase())) return false;
  if ((c.cmc ?? 0) > maxCmc) return false;
  if (allowed !== undefined && ![...colorsOf(c)].every((col) => allowed.includes(col))) return false;
  return true;
});

const withText = hits.map((entry) => ({ entry, info: cardText(entry.printings[0].arena_id) }));
const matched = textRe ? withText.filter(({ info }) => info && textRe.test(info.text)) : withText;

let legality = new Map();
if (values.standard) legality = await standardLegality(matched.map(({ entry }) => entry.name), { refresh: values.refresh });

for (const { entry, info } of matched.sort((a, b) => (a.entry.printings[0].cmc ?? 0) - (b.entry.printings[0].cmc ?? 0))) {
  if (values.standard && legality.get(entry.name) !== 'legal') continue;
  const c = entry.printings[0];
  const sets = [...new Set(entry.printings.map((p) => p.set_code))].join('/');
  const pt = info?.pt ? ` ${info.pt}` : '';
  console.log(`${entry.quantity}x ${entry.name} (${sets}) ${c.rarity[0].toUpperCase()} MV${c.cmc ?? '-'} ${colorsOf(c) || 'C'} | ${c.full_type}${pt}`);
  if (info?.text) console.log(`    ${info.text.replace(/\s+/g, ' ')}`);
}
