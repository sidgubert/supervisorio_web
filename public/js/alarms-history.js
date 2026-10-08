import { apiFetch } from './auth.js';
import { apiError, esc, fmtDateTime, fmtNum, STATE_LABEL } from './util.js';

const tbody = document.getElementById('alarm-history-body');

async function ack(id, btn) {
  btn.disabled = true;
  const res = await apiFetch(`/api/alarms/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  if (res.ok) {
    await refreshAlarmHistory();
  } else {
    btn.disabled = false;
    btn.textContent = 'Erro';
    btn.title = await apiError(res);
  }
}

export async function refreshAlarmHistory() {
  const res = await apiFetch('/api/alarms/history?limit=200');
  if (!res.ok) return;
  const rows = await res.json();

  if (rows.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-state">Nenhum alarme nas últimas 24 h.</td></tr>';
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
      <tr class="${r.clearedAt ? '' : 'row--active'}">
        <td><code>${esc(r.tag)}</code></td>
        <td><span class="sev sev--${r.level.toLowerCase()}">${esc(r.level)}</span></td>
        <td>${fmtNum(r.limitValue)}</td>
        <td>${fmtDateTime(r.raisedAt)}<br><span class="muted">valor ${fmtNum(r.raisedValue)}</span></td>
        <td>${
          r.clearedAt
            ? `${fmtDateTime(r.clearedAt)}<br><span class="muted">valor ${fmtNum(r.clearedValue)}</span>`
            : '—'
        }</td>
        <td>${r.ackedAt ? `${fmtDateTime(r.ackedAt)}<br><span class="muted">por ${esc(r.ackedBy ?? '—')}</span>` : '—'}</td>
        <td><span class="state state--${r.state.toLowerCase()}">${esc(STATE_LABEL[r.state] ?? r.state)}</span></td>
        <td>${r.ackedAt ? '' : `<button class="btn btn--sm" data-id="${esc(r.id)}">Reconhecer</button>`}</td>
      </tr>`,
    )
    .join('');

  tbody.querySelectorAll('button[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => ack(btn.dataset.id, btn));
  });
}

export function initAlarmHistory() {
  document.getElementById('refresh-history')?.addEventListener('click', refreshAlarmHistory);
}
