import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const OVERVIEW = {
  ingest: {
    uptimeSec: 3725,
    totalSamples: 123456,
    avgInsertMs: 4.25,
    sseClients: 2,
    wsClients: 1,
    sseEventsSent: 1000,
    wsEventsSent: 500,
    bySource: {
      sim: { samplesPerSec: 4, avgInsertMs: 4.2, totalSamples: 900 },
      mqtt: { samplesPerSec: 2, avgInsertMs: 3.1, totalSamples: 300 },
    },
  },
  process: { cpuPct: 12.5, rssMb: 183.4, heapUsedMb: 61.2 },
  retention: { enabled: true, days: 90 },
};
const STORAGE = {
  measurementsRows: 5000000,
  measurementsRowsApproximate: true,
  hypertableSize: '72 MB',
  compression: {
    compressedChunks: 2,
    totalChunks: 5,
    savingsPct: 90,
    beforeSize: '700 MB',
    afterSize: '70 MB',
  },
  alarmRows: 7,
  oldestMeasurement: '2026-10-01T00:00:00Z',
  newestMeasurement: '2026-10-09T00:00:00Z',
  retentionPolicy: { enabled: true, dropAfter: '90 days' },
  bySourceLast24h: [{ source: 'sim', count: 345600, tags: 4 }],
};
const PROTOCOLS = {
  profiles: [
    {
      id: 'mqtt',
      name: 'MQTT',
      transport: 'TCP, via broker',
      paradigm: 'Publish/Subscribe',
      complexity: 'baixa',
      realtime: 'Por evento (push)',
      typicalUse: 'IoT',
      notes: 'Baixo overhead.',
      metrics: { samplesPerSec: 2, avgInsertMs: 3.1, totalSamples: 300 },
    },
    {
      id: 'opcua',
      name: 'OPC UA',
      transport: 'opc.tcp',
      paradigm: 'Cliente/Servidor',
      complexity: 'alta',
      realtime: 'Subscription',
      typicalUse: '<b>Chão de fábrica</b>',
      notes: 'Modelo rico.',
      metrics: null,
    },
  ],
};

async function openMetrics(routes = {}) {
  loadPage();
  document.getElementById('view-metrics').hidden = false;
  window.Chart = jest.fn((canvas, config) => ({ data: config.data, update: jest.fn() }));
  const api = mockApi({
    'GET /api/metrics/overview': OVERVIEW,
    'GET /api/metrics/storage': STORAGE,
    'GET /api/metrics/protocols': PROTOCOLS,
    ...routes,
  });
  const metrics = await loadModule('metrics.js');
  metrics.initMetrics();
  await screen.findByText('CPU da API');
  return { api, metrics };
}

const kpi = (label) => screen.getByText(label).closest('.kpi');

let metricsModule;
afterEach(() => {
  metricsModule?.stopMetricsRefresh();
  metricsModule = undefined;
  delete window.Chart;
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  jest.useRealTimers();
});

it('mostra a ingestão, o uso de recursos e a retenção', async () => {
  ({ metrics: metricsModule } = await openMetrics());
  expect(kpi('Em execução há')).toHaveTextContent('1 h 2 min');
  expect(kpi('Amostras gravadas')).toHaveTextContent('123.456');
  expect(kpi('CPU da API')).toHaveTextContent('12,5%');
  expect(kpi('Memória da API')).toHaveTextContent('183 MiB');
  expect(kpi('Memória da API')).toHaveTextContent('heap 61 MiB');
  expect(kpi('Retenção')).toHaveTextContent('90 dias');
});

it('desenha a vazão por fonte no gráfico', async () => {
  ({ metrics: metricsModule } = await openMetrics());
  const [, config] = window.Chart.mock.calls[0];
  expect(config.data.labels).toEqual(['sim', 'mqtt']);
  expect(config.data.datasets[0].data).toEqual([4, 2]);
});

it('mostra o armazenamento, marcando a contagem aproximada', async () => {
  ({ metrics: metricsModule } = await openMetrics());
  expect(kpi('Amostras no banco')).toHaveTextContent('≈ 5.000.000');
  expect(kpi('Compressão')).toHaveTextContent('90% menor');
  expect(kpi('Compressão')).toHaveTextContent('700 MB → 70 MB');
  expect(kpi('Política de retenção')).toHaveTextContent('90 days');
  expect(screen.getByRole('cell', { name: '345.600' })).toBeInTheDocument();
});

it('compara os protocolos, com travessão para quem não tem métricas', async () => {
  ({ metrics: metricsModule } = await openMetrics());
  const opcua = screen.getByText('OPC UA').closest('tr');
  expect(within(opcua).getAllByText('—')).toHaveLength(3);
  // Texto do perfil entra como texto, sem interpretar HTML.
  expect(within(opcua).getByText('<b>Chão de fábrica</b>')).toBeInTheDocument();
  expect(document.querySelector('#protocols-table b')).toBeNull();
});

it('exporta o CSV do período escolhido, com o token, como download', async () => {
  ({ metrics: metricsModule } = await openMetrics({
    'GET /api/metrics/export': response('a,b\r\n1,2\r\n'),
  }));
  localStorage.setItem('talos_token', 'tok');
  URL.createObjectURL = jest.fn(() => 'blob:resumo');
  URL.revokeObjectURL = jest.fn();
  const downloads = [];
  jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    downloads.push({ href: this.href, download: this.download });
  });
  const user = userEvent.setup();

  await user.selectOptions(screen.getByRole('combobox'), 'Últimas 4 h');
  await user.click(screen.getByRole('button', { name: 'Exportar CSV' }));

  await waitFor(() =>
    expect(downloads).toEqual([{ href: 'blob:resumo', download: 'talos-resumo-240min.csv' }]),
  );
  const [request] = requestsTo(window.fetch, 'GET', '/api/metrics/export');
  expect(request.url).toBe('/api/metrics/export?minutes=240&format=csv');
  expect(request.headers.Authorization).toBe('Bearer tok');
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:resumo');
  expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeEnabled();
});

it('se a exportação falha, explica no botão', async () => {
  ({ metrics: metricsModule } = await openMetrics({
    'GET /api/metrics/export': response({ message: 'minutes deve estar entre 1 e 10080' }, 400),
  }));
  const button = screen.getByRole('button', { name: 'Exportar CSV' });

  await userEvent.setup().click(button);

  await waitFor(() =>
    expect(button).toHaveAttribute('title', 'minutes deve estar entre 1 e 10080'),
  );
  expect(button).toBeEnabled();
});

it('atualiza a cada 5 s enquanto a tela está aberta, e para ao sair', async () => {
  jest.useFakeTimers();
  const { api, metrics } = await openMetrics();
  metricsModule = metrics;
  const overviewCalls = () => requestsTo(api, 'GET', '/api/metrics/overview').length;
  expect(overviewCalls()).toBe(1);

  await jest.advanceTimersByTimeAsync(5000);
  expect(overviewCalls()).toBe(2);

  metrics.stopMetricsRefresh();
  await jest.advanceTimersByTimeAsync(15000);
  expect(overviewCalls()).toBe(2);
});
