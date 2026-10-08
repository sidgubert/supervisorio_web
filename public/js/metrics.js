import { apiFetch } from './auth.js';
import { apiError, esc, fmtDateTime, fmtDuration, fmtNum } from './util.js';

let throughputChart;
let refreshTimer;
let bound = false;

const SOURCE_COLORS = {
  sim: '#a371f7',
  mqtt: '#39d353',
  modbus: '#f0883e',
  opcua: '#79c0ff',
};

function kpi(label, value, sub = '') {
  return `<div class="kpi"><span class="kpi__label">${esc(label)}</span><span class="kpi__value">${esc(value)}</span>${
    sub ? `<span class="kpi__sub">${esc(sub)}</span>` : ''
  }</div>`;
}

function renderIngest({ ingest, retention }) {
  document.getElementById('ingest-stats').innerHTML = [
    kpi('Em execução há', fmtDuration(ingest.uptimeSec)),
    kpi('Amostras gravadas', fmtNum(ingest.totalSamples, 0)),
    kpi('Latência média do INSERT', `${fmtNum(ingest.avgInsertMs, 1)} ms`),
    kpi('Clientes SSE', ingest.sseClients),
    kpi('Clientes WebSocket', ingest.wsClients),
    kpi(
      'Eventos enviados',
      fmtNum(ingest.sseEventsSent + ingest.wsEventsSent, 0),
      'SSE + WebSocket',
    ),
    kpi('Retenção', retention.enabled ? `${retention.days} dias` : 'desligada'),
  ].join('');
  updateThroughputChart(ingest.bySource);
}

function updateThroughputChart(bySource) {
  const labels = Object.keys(bySource);
  const data = labels.map((s) => bySource[s].samplesPerSec);
  const colors = labels.map((l) => SOURCE_COLORS[l] ?? '#8b949e');

  if (!throughputChart) {
    throughputChart = new Chart(document.getElementById('throughput-chart'), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'amostras/s (média de 60 s)',
            data,
            backgroundColor: colors.map((c) => `${c}99`),
            borderColor: colors,
            borderWidth: 1,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
          y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' }, beginAtZero: true },
        },
      },
    });
    return;
  }
  throughputChart.data.labels = labels;
  throughputChart.data.datasets[0].data = data;
  throughputChart.data.datasets[0].backgroundColor = colors.map((c) => `${c}99`);
  throughputChart.data.datasets[0].borderColor = colors;
  throughputChart.update('none');
}

function renderStorage(s) {
  const c = s.compression;
  const compression =
    c.savingsPct === null
      ? `${c.compressedChunks} de ${c.totalChunks} chunks`
      : `${fmtNum(c.savingsPct, 1)}% menor`;
  const compressionSub =
    c.savingsPct === null ? 'comprime após 7 dias' : `${c.beforeSize} → ${c.afterSize}`;
  const el = document.getElementById('storage-stats');
  el.innerHTML = [
    kpi(
      'Amostras no banco',
      `${s.measurementsRowsApproximate ? '≈ ' : ''}${fmtNum(s.measurementsRows, 0)}`,
    ),
    kpi('Tamanho da hypertable', s.hypertableSize),
    kpi('Compressão', compression, compressionSub),
    kpi('Alarmes registrados', fmtNum(s.alarmRows, 0)),
    kpi('Dado mais antigo', fmtDateTime(s.oldestMeasurement)),
    kpi('Dado mais recente', fmtDateTime(s.newestMeasurement)),
    kpi(
      'Política de retenção',
      s.retentionPolicy.enabled ? s.retentionPolicy.dropAfter : 'nenhuma',
    ),
  ].join('');

  if (s.bySourceLast24h.length) {
    const rows = s.bySourceLast24h
      .map(
        (r) =>
          `<tr><td><span class="source-pill source-pill--${esc(r.source)}">${esc(r.source)}</span></td><td>${fmtNum(r.count, 0)}</td><td>${r.tags}</td></tr>`,
      )
      .join('');
    el.innerHTML += `<table class="mini-table"><thead><tr><th>Fonte (24 h)</th><th>Amostras</th><th>Tags</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
}

function renderProtocols({ profiles }) {
  document.getElementById('protocols-table').innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Protocolo</th><th>Paradigma</th><th>Complexidade</th><th>Tempo real</th>
          <th>Uso típico</th><th>amostras/s</th><th>INSERT (ms)</th><th>total na sessão</th>
        </tr>
      </thead>
      <tbody>
        ${profiles
          .map((p) => {
            const m = p.metrics;
            return `<tr>
              <td><strong>${esc(p.name)}</strong><br><span class="muted">${esc(p.transport)}</span></td>
              <td>${esc(p.paradigm)}</td>
              <td>${esc(p.complexity)}</td>
              <td>${esc(p.realtime)}</td>
              <td>${esc(p.typicalUse)}</td>
              <td>${m ? fmtNum(m.samplesPerSec, 2) : '—'}</td>
              <td>${m ? fmtNum(m.avgInsertMs, 1) : '—'}</td>
              <td>${m ? fmtNum(m.totalSamples, 0) : '—'}</td>
            </tr>
            <tr class="protocol-notes"><td colspan="8">${esc(p.notes)}</td></tr>`;
          })
          .join('')}
      </tbody>
    </table>`;
}

async function loadMetrics() {
  const [overview, storage, protocols] = await Promise.all([
    apiFetch('/api/metrics/overview'),
    apiFetch('/api/metrics/storage'),
    apiFetch('/api/metrics/protocols'),
  ]);
  if (overview.ok) renderIngest(await overview.json());
  if (storage.ok) renderStorage(await storage.json());
  if (protocols.ok) renderProtocols(await protocols.json());
}

/** Baixa o CSV pelo fetch (com o token), em vez de um link direto. */
async function exportCsv() {
  const minutes = document.getElementById('export-minutes').value;
  const btn = document.getElementById('export-csv');
  btn.disabled = true;
  try {
    const res = await apiFetch(`/api/metrics/export?minutes=${minutes}&format=csv`);
    if (!res.ok) {
      btn.title = await apiError(res);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `talos-resumo-${minutes}min.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } finally {
    btn.disabled = false;
  }
}

export function initMetrics() {
  if (!bound) {
    document.getElementById('refresh-metrics').addEventListener('click', loadMetrics);
    document.getElementById('export-csv').addEventListener('click', exportCsv);
    bound = true;
  }
  void loadMetrics();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadMetrics, 5000);
}

export function stopMetricsRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
}
