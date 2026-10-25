# arena-vault

Two halves:

- `src/` — the TypeScript exporter (Effect 4, strict TS; see README for conventions). Run `npm run typecheck` after changes.
- `scripts/` + `decks/` — deckbuilding against the exported collection. Plain `.mjs`, no build step.

## Deckbuilding workflow

1. **Collection freshness.** `exports/mtga-owned-cards.json` is only as current as the last live export
   (see its `source` field for the snapshot timestamp). A re-export needs root with Arena running:
   `sudo env PATH="$PATH" npm run export -- --overwrite`. Passwordless sudo isn't available, so ask the user to run it
   (suggest `! <command>`). If they've opened packs or crafted since, ask before building.
2. **Find cards** with `npm run cards -- [flags]` rather than writing a new script:
   - `--standard` keeps only Standard-legal cards (Scryfall, cached 3 days in `data/legality-cache.json`; `--refresh` after a B&R update)
   - `--colors WB` = color identity within W/B (lands included); `--text REGEX` searches current rules text;
     `--name`, `--type`, `--max-cmc`
   - Example: `npm run cards -- --standard --colors WB --text "destroy all|exile all"`
3. **Write the deck** to `decks/<archetype>.txt` in Arena import format (`Deck` header, `4 Name (SET) 123` lines,
   optional `Sideboard` section). Use set codes/collector numbers of printings the user owns.
4. **Validate every deck before presenting it**: `npm run check-deck -- decks/<file>.txt`. It checks 60+ cards,
   4-of limit, owned copies (summed across printings), owned printing, and Standard legality. Exit code 1 on problems.
5. Add reusable helpers to `scripts/lib.mjs` (collection, rules text, legality, deck parsing) instead of new one-offs.

## Data source notes

- Rules text: `cardText()` in `scripts/lib.mjs` reads Arena's own sqlite (`Raw_CardDatabase_*.mtga`), which is current
  for new sets. The mtgatool JSON in `data/` lags new sets and can be stale; don't use it for card text.
- Legality is by card name on Arena, so older printings of reprinted cards are fine (e.g. VOW Shattered Sanctum).
  Never hardcode a Standard set list. Rotation and bans change, so use `standardLegality()`.
- The collection helpers drop tokens and Alchemy (`A-` rebalanced / digital-only) cards, since those aren't Standard.
- Meta research: mtggoldfish.com/metagame/standard is current. MTG Arena Zone tier lists showed stale lists;
  aetherhub and mtgdecks return 403.
