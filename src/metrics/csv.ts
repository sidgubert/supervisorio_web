/**
 * CSV (RFC 4180): campos com vírgula, aspas ou quebra de linha vão entre
 * aspas, e aspas internas são duplicadas.
 *
 * Campos que começam com =, +, - ou @ ganham um apóstrofo na frente: planilhas
 * interpretam esses textos como fórmula (injeção de fórmula, ou CSV injection).
 * Números ficam como estão.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const lines = [keys.map(escapeField).join(',')];
  for (const row of rows) lines.push(keys.map((k) => escapeField(row[k])).join(','));
  return lines.join('\r\n') + '\r\n';
}

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'string') s = value;
  else if (typeof value === 'boolean' || typeof value === 'bigint') s = value.toString();
  else s = JSON.stringify(value) ?? '';
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
