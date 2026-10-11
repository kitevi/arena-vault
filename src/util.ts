export const VERSION = '0.1.0';

export function timestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** csv QUOTE_MINIMAL semantics: quote only when the delimiter, quote char, or a newline is present. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[";\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Split one CSV row honoring double quotes (inverse of csvCell). */
export function splitCsvRow(line: string): Array<string> {
  const cells: Array<string> = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ';') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}
