/**
 * Utilitários do dashboard.
 *
 * esc(): todo texto que vem da API e entra num template HTML passa por aqui.
 * Descrição e unidade de uma tag são editáveis por qualquer operador; sem o
 * escape, um texto como <img src=x onerror=...> executaria script na tela dos
 * outros (XSS armazenado).
 */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('pt-BR') : '—';
}

export function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

export function fmtNum(value, digits = 3) {
  if (value === null || value === undefined || value === '') return '—';
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
}

export function fmtDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export const LEVEL_LABEL = { HH: 'Muito alto', H: 'Alto', L: 'Baixo', LL: 'Muito baixo' };

export const STATE_LABEL = {
  ACTIVE_UNACKED: 'Ativo, não reconhecido',
  ACTIVE_ACKED: 'Ativo, reconhecido',
  CLEARED_UNACKED: 'Normalizado, não reconhecido',
  CLOSED: 'Encerrado',
};

/** Mensagem de erro de uma resposta da API (a validação devolve uma lista). */
export async function apiError(res) {
  try {
    const body = await res.json();
    return Array.isArray(body.message)
      ? body.message.join('; ')
      : String(body.message ?? res.status);
  } catch {
    return `erro ${res.status}`;
  }
}
