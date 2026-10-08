import { apiFetch } from './auth.js';
import { apiError, esc, fmtNum, fmtTime, LEVEL_LABEL, STATE_LABEL } from './util.js';

/** Pontos por gráfico (com amostras a cada 1 s, os últimos 2 min). */
const MAX_POINTS = 120;

const charts = new Map(); // tag -> { card, chart, valueEl, metaEl, pill }
const tagConfig = new Map(); // tag -> cadastro (descrição, unidade, limites...)
const openAlarms = new Map(); // id -> alarme aberto (ativo ou não reconhecido)

const grid = document.getElementById('charts-grid');
const emptyState = document.getElementById('empty-state');
const tagCount = document.getElementById('tag-count');
const alarmCount = document.getElementById('alarm-count');
const alarmsList = document.getElementById('alarms-list');
const ackAllBtn = document.getElementById('ack-all');

export function setTagConfig(tags) {
  tagConfig.clear();
  for (const t of tags) tagConfig.set(t.tag, t);
  for (const [tag, entry] of charts) {
    entry.unitEl.textContent = unitOf(tag);
    entry.labelEl.textContent = labelOf(tag);
  }
}

const unitOf = (tag) => tagConfig.get(tag)?.unit ?? '';
const labelOf = (tag) => tagConfig.get(tag)?.description ?? '';

/** Tags com algum alarme ativo (para destacar o card e o sinótico). */
export function tagsInAlarm() {
  const tags = new Set();
  for (const a of openAlarms.values()) if (!a.clearedAt) tags.add(a.tag);
  return tags;
}

// ---- alarmes ----

export function handleAlarm(alarm) {
  if (alarm.state === 'CLOSED') openAlarms.delete(alarm.id);
  else openAlarms.set(alarm.id, alarm);
  renderAlarms();
}

async function ack(id, btn) {
  btn.disabled = true;
  const res = await apiFetch(`/api/alarms/${encodeURIComponent(id)}/ack`, { method: 'POST' });
  if (!res.ok) {
    btn.disabled = false;
    btn.title = await apiError(res);
  }
  // O estado novo chega pelo stream (evento 'acknowledged').
}

function renderAlarms() {
  const items = [...openAlarms.values()].sort(
    (a, b) => b.priority - a.priority || new Date(b.raisedAt) - new Date(a.raisedAt),
  );
  const unacked = items.filter((a) => !a.ackedAt).length;
  alarmCount.textContent = `${items.length} aberto${items.length !== 1 ? 's' : ''}`;
  ackAllBtn.hidden = unacked === 0;

  if (items.length === 0) {
    alarmsList.innerHTML = '<p class="empty-state">Nenhum alarme aberto.</p>';
  } else {
    alarmsList.innerHTML = items
      .map((a) => {
        const classes = [
          'alarm-item',
          `alarm-item--${a.level.toLowerCase()}`,
          a.ackedAt ? '' : 'alarm-item--unacked',
          a.clearedAt ? 'alarm-item--cleared' : '',
        ].join(' ');
        const unit = esc(unitOf(a.tag));
        return `
          <div class="${classes}">
            <span class="alarm-item__tag">${esc(a.tag)}</span>
            <span class="alarm-item__sev">${esc(a.level)}</span>
            <span class="alarm-item__state">${esc(STATE_LABEL[a.state] ?? a.state)}</span>
            <div>${esc(LEVEL_LABEL[a.level])}: ${fmtNum(a.raisedValue)} ${unit} (limite ${fmtNum(a.limitValue)})</div>
            <div class="alarm-item__meta">desde ${fmtTime(a.raisedAt)}${
              a.clearedAt ? ` · normalizou ${fmtTime(a.clearedAt)}` : ''
            }</div>
            ${
              a.ackedAt
                ? ''
                : `<div class="alarm-item__actions"><button class="btn btn--sm" data-ack="${esc(a.id)}">Reconhecer</button></div>`
            }
          </div>`;
      })
      .join('');
    alarmsList.querySelectorAll('button[data-ack]').forEach((btn) => {
      btn.addEventListener('click', () => ack(btn.dataset.ack, btn));
    });
  }

  const inAlarm = tagsInAlarm();
  for (const [tag, entry] of charts)
    entry.card.classList.toggle('tag-card--alarm', inAlarm.has(tag));
}

ackAllBtn.addEventListener('click', async () => {
  ackAllBtn.disabled = true;
  await apiFetch('/api/alarms/ack-all', { method: 'POST' });
  ackAllBtn.disabled = false;
});

// ---- gráficos ----

function createChartCard(tag, source) {
  emptyState?.remove();
  const card = document.createElement('article');
  card.className = 'tag-card';
  card.innerHTML = `
    <div class="tag-card__head">
      <div>
        <div class="tag-card__name">${esc(tag)}</div>
        <div class="tag-card__meta"><span class="label"></span> · <span class="time"></span></div>
      </div>
      <span class="source-pill source-pill--${esc(source)}">${esc(source)}</span>
    </div>
    <div class="tag-card__value"><span class="val">—</span> <small class="unit"></small></div>
    <div class="chart-wrap"><canvas></canvas></div>`;
  grid.appendChild(card);

  const chart = new Chart(card.querySelector('canvas'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        {
          data: [],
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88,166,255,0.08)',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 5, font: { size: 10 } },
          grid: { color: 'rgba(48,54,61,0.5)' },
        },
        y: {
          ticks: { color: '#8b949e', font: { size: 10 } },
          grid: { color: 'rgba(48,54,61,0.5)' },
        },
      },
    },
  });

  const entry = {
    card,
    chart,
    valueEl: card.querySelector('.val'),
    timeEl: card.querySelector('.time'),
    labelEl: card.querySelector('.label'),
    unitEl: card.querySelector('.unit'),
    pill: card.querySelector('.source-pill'),
  };
  entry.labelEl.textContent = labelOf(tag);
  entry.unitEl.textContent = unitOf(tag);
  charts.set(tag, entry);
  tagCount.textContent = `${charts.size} tag${charts.size !== 1 ? 's' : ''}`;
  return entry;
}

function pushPoint(tag, value, time, source, quality) {
  const entry = charts.get(tag) ?? createChartCard(tag, source ?? '?');
  entry.valueEl.textContent = fmtNum(value);
  entry.valueEl.title = quality === 192 ? '' : `qualidade ${quality}`;
  entry.valueEl.style.opacity = quality === 192 ? '' : '0.5';
  entry.timeEl.textContent = fmtTime(time);
  if (source) {
    entry.pill.className = `source-pill source-pill--${source}`;
    entry.pill.textContent = source;
  }
  const labels = entry.chart.data.labels;
  const data = entry.chart.data.datasets[0].data;
  labels.push(fmtTime(time));
  data.push(value);
  if (labels.length > MAX_POINTS) {
    labels.splice(0, labels.length - MAX_POINTS);
    data.splice(0, data.length - MAX_POINTS);
  }
  entry.chart.update('none');
}

export function handleSample(s) {
  pushPoint(s.tag, s.value, s.time, s.source, s.quality);
}

async function loadHistory(tag, source) {
  const res = await apiFetch(
    `/api/measurements/${encodeURIComponent(tag)}/history?minutes=15&bucket=raw`,
  );
  if (!res.ok) return;
  const { points } = await res.json();
  for (const p of points.slice(-MAX_POINTS)) pushPoint(tag, p.avg, p.time, source, 192);
}

export async function initDashboard() {
  const alarmsRes = await apiFetch('/api/dashboard/alarms');
  if (alarmsRes.ok) {
    const { alarms, tags } = await alarmsRes.json();
    setTagConfig(tags);
    for (const a of alarms) openAlarms.set(a.id, a);
    renderAlarms();
  }

  const tagsRes = await apiFetch('/api/dashboard/tags');
  if (tagsRes.ok) {
    const latest = await tagsRes.json();
    await Promise.all(latest.map((t) => loadHistory(t.tag, t.source)));
  }
}
