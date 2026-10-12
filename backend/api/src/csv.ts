/** RFC 4180 CSV. Values that could be read as spreadsheet formulas are prefixed to prevent CSV injection. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-\d/.test(s))) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n') + '\r\n';
}
