/**
 * Terminal formatting. No dependencies - ANSI codes are trivial.
 * Colour is disabled automatically when stdout is not a TTY or NO_COLOR is set.
 */
const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap = (code: string) => (text: string) => (useColor ? `\u001B[${code}m${text}\u001B[0m` : text);

export const bold = wrap('1');
export const dim = wrap('2');
export const red = wrap('31');
export const green = wrap('32');
export const yellow = wrap('33');
export const blue = wrap('34');
export const magenta = wrap('35');
export const cyan = wrap('36');
export const gray = wrap('90');

export function heading(text: string): string {
  return `\n${bold(text)}\n${dim('-'.repeat(Math.min(text.length, 60)))}`;
}

export function bullet(text: string): string {
  return `  ${dim('*')} ${text}`;
}

export function scoreColor(score: number): (text: string) => string {
  if (score >= 90) return green;
  if (score >= 85) return cyan;
  if (score >= 70) return yellow;
  return red;
}

/** Colour a 0-100 authenticity score. */
export function score(value: number): string {
  const label = value.toFixed(0).padStart(3);
  return scoreColor(value)(`${label}`);
}

/** Truncate on a word boundary. */
export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return dim('  (nothing yet)');
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => (c ?? '').padEnd(widths[i] ?? 0)).join('  ');
  return [bold(line(headers)), dim('  ' + widths.map((w) => '-'.repeat(w)).join('  ')), ...rows.map(line)].join('\n');
}

export function success(text: string): string {
  return `${green('OK')} ${text}`;
}

export function warn(text: string): string {
  return `${yellow('!')}  ${text}`;
}

export function fail(text: string): string {
  return `${red('x')} ${text}`;
}

export function info(text: string): string {
  return `${cyan('i')}  ${text}`;
}

export function bar(value: number, max: number, width = 20): string {
  const filled = max === 0 ? 0 : Math.round((value / max) * width);
  return `${'#'.repeat(Math.max(0, filled))}${dim('.'.repeat(Math.max(0, width - filled)))}`;
}

/** Terminal hyperlinks, when supported. */
export function link(text: string, url: string): string {
  return process.stdout.isTTY && process.env.FORCE_HYPERLINK !== '0'
    ? `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`
    : `${text} (${url})`;
}