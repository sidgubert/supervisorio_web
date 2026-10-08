import { apiFetch } from './auth.js';
import { apiError, esc } from './util.js';

const list = document.getElementById('config-list');

const NUMBER_FIELDS = [
  ['engMin', 'Faixa mín.'],
  ['engMax', 'Faixa máx.'],
  ['alarmLL', 'LL (muito baixo)'],
  ['alarmL', 'L (baixo)'],
  ['alarmH', 'H (alto)'],
  ['alarmHH', 'HH (muito alto)'],
  ['alarmDeadband', 'Banda morta'],
];
const INT_FIELDS = new Set(['synopticX', 'synopticY']);
const KINDS = [
  ['', '— fora do sinótico —'],
  ['tank', 'Tanque'],
  ['pressure', 'Pressão'],
  ['flow', 'Vazão'],
  ['level', 'Nível'],
  ['sensor', 'Sensor'],
];

function input(name, label, value, attrs = '') {
  return `<label>${esc(label)} <input name="${name}" value="${esc(value ?? '')}" ${attrs} /></label>`;
}

function formFor(cfg) {
  return `
    <form class="config-card" data-tag="${esc(cfg.tag)}">
      <h3>${esc(cfg.tag)} <small>${esc(cfg.source ?? '')}</small></h3>
      <div class="config-grid">
        ${input('description', 'Descrição', cfg.description)}
        ${input('unit', 'Unidade', cfg.unit)}
        ${NUMBER_FIELDS.map(([k, l]) => input(k, l, cfg[k], 'type="number" step="any"')).join('')}
        <label>Sinótico
          <select name="synopticKind">
            ${KINDS.map(
              ([v, l]) =>
                `<option value="${v}" ${(cfg.synopticKind ?? '') === v ? 'selected' : ''}>${esc(l)}</option>`,
            ).join('')}
          </select>
        </label>
        ${input('synopticX', 'Sinótico X (%)', cfg.synopticX, 'type="number" min="0" max="100" step="1"')}
        ${input('synopticY', 'Sinótico Y (%)', cfg.synopticY, 'type="number" min="0" max="100" step="1"')}
      </div>
      <button type="submit" class="btn">Salvar</button>
      <span class="config-msg"></span>
    </form>`;
}

/** Corpo do PATCH: campo vazio = apagar (null); números convertidos. */
function bodyOf(form) {
  const body = {};
  for (const [k, raw] of new FormData(form).entries()) {
    const v = String(raw).trim();
    if (v === '') body[k] = null;
    else if (NUMBER_FIELDS.some(([n]) => n === k) || INT_FIELDS.has(k)) body[k] = Number(v);
    else body[k] = v;
  }
  return body;
}

function bindForms() {
  list.querySelectorAll('form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = form.querySelector('.config-msg');
      msg.className = 'config-msg';
      msg.textContent = 'Salvando…';
      const res = await apiFetch(`/api/tags/${encodeURIComponent(form.dataset.tag)}`, {
        method: 'PATCH',
        body: JSON.stringify(bodyOf(form)),
      });
      if (res.ok) {
        msg.classList.add('ok');
        msg.textContent = 'Salvo.';
        window.dispatchEvent(new CustomEvent('talos:tags-changed'));
      } else {
        msg.classList.add('err');
        msg.textContent = await apiError(res);
      }
    });
  });
}

export async function initConfig() {
  const res = await apiFetch('/api/tags');
  if (!res.ok) return;
  list.innerHTML = (await res.json()).map(formFor).join('');
  bindForms();
}
