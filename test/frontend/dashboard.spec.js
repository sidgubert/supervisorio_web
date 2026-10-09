import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const TAGS = [{ tag: 'TIC-101.PV', description: 'Temperatura do reator', unit: '°C' }];
const HIGH = {
  id: 'a1',
  tag: 'TIC-101.PV',
  level: 'HH',
  priority: 2,
  limitValue: 95,
  raisedAt: '2026-10-09T12:00:00Z',
  raisedValue: 96.4,
  clearedAt: null,
  ackedAt: null,
  state: 'ACTIVE_UNACKED',
};
const LOW = {
  ...HIGH,
  id: 'a2',
  level: 'L',
  priority: 1,
  limitValue: 10,
  raisedValue: 9,
  ackedAt: '2026-10-09T12:00:30Z',
  state: 'ACTIVE_ACKED',
};
const POINTS = [70, 71, 72].map((avg, i) => ({ time: `2026-10-09T12:00:0${i}Z`, avg }));

/** Chart.js é carregado por <script> no navegador; aqui, um dublê com o que o código usa. */
function stubChart() {
  window.Chart = jest.fn((canvas, config) => ({ data: config.data, update: jest.fn() }));
}

async function openDashboard({ alarms = [HIGH, LOW], routes = {} } = {}) {
  loadPage();
  stubChart();
  const api = mockApi({
    'GET /api/dashboard/alarms': { alarms, tags: TAGS },
    'GET /api/dashboard/tags': [{ tag: 'TIC-101.PV', source: 'sim', value: 72 }],
    'GET /api/measurements/TIC-101.PV/history': { points: POINTS },
    ...routes,
  });
  const dashboard = await loadModule('dashboard.js');
  await dashboard.initDashboard();
  return { api, dashboard };
}

const card = (tag) => screen.getByText(tag, { selector: '.tag-card__name' }).closest('article');
const chartOf = (index = 0) => window.Chart.mock.results[index].value;
const alarmsPanel = () => within(document.getElementById('alarms-list'));

afterEach(() => delete window.Chart);

describe('gráficos', () => {
  it('cria um card por tag com o histórico recente', async () => {
    const { api } = await openDashboard();
    const tic = within(card('TIC-101.PV'));

    expect(tic.getByText('Temperatura do reator')).toBeInTheDocument();
    expect(tic.getByText('°C')).toBeInTheDocument();
    expect(tic.getByText('72')).toBeInTheDocument(); // último ponto
    expect(screen.getByText('1 tag')).toBeInTheDocument();
    expect(screen.queryByText('Aguardando dados…')).toBeNull();
    expect(chartOf().data.datasets[0].data).toEqual([70, 71, 72]);
    expect(requestsTo(api, 'GET', '/api/measurements/TIC-101.PV/history')[0].url).toContain(
      'minutes=15',
    );
  });

  it('amostras do tempo real atualizam valor e gráfico; qualidade ruim fica sinalizada', async () => {
    const { dashboard } = await openDashboard();
    dashboard.handleSample({
      tag: 'TIC-101.PV',
      value: 80.5,
      time: '2026-10-09T12:00:05Z',
      source: 'opcua',
      quality: 0,
    });

    const value = within(card('TIC-101.PV')).getByText('80,5');
    expect(value).toHaveAttribute('title', 'qualidade 0');
    expect(within(card('TIC-101.PV')).getByText('opcua')).toHaveClass('source-pill--opcua');
    expect(chartOf().data.datasets[0].data.at(-1)).toBe(80.5);
    expect(chartOf().update).toHaveBeenCalled();
  });

  it('o gráfico guarda só os últimos 120 pontos', async () => {
    const { dashboard } = await openDashboard();
    for (let i = 0; i < 200; i++) {
      dashboard.handleSample({
        tag: 'TIC-101.PV',
        value: i,
        time: '2026-10-09T12:00:00Z',
        quality: 192,
      });
    }
    const { labels, datasets } = chartOf().data;
    expect(datasets[0].data).toHaveLength(120);
    expect(labels).toHaveLength(120);
    expect(datasets[0].data.at(-1)).toBe(199);
  });

  it('tag nova no tempo real ganha um card', async () => {
    const { dashboard } = await openDashboard();
    dashboard.handleSample({
      tag: 'PT-9',
      value: 4.2,
      time: '2026-10-09T12:00:00Z',
      source: 'mqtt',
      quality: 192,
    });
    expect(card('PT-9')).toBeInTheDocument();
    expect(screen.getByText('2 tags')).toBeInTheDocument();
  });

  it('o nome da tag entra como texto, sem interpretar HTML', async () => {
    const { dashboard } = await openDashboard({ alarms: [] });
    dashboard.handleSample({ tag: '<img src=x onerror=alert(1)>', value: 1, quality: 192 });
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(document.querySelector('#charts-grid img')).toBeNull();
  });

  it('setTagConfig atualiza descrição e unidade dos cards', async () => {
    const { dashboard } = await openDashboard();
    dashboard.setTagConfig([{ tag: 'TIC-101.PV', description: 'Reator 1', unit: 'K' }]);
    const tic = within(card('TIC-101.PV'));
    expect(tic.getByText('Reator 1')).toBeInTheDocument();
    expect(tic.getByText('K')).toBeInTheDocument();
  });
});

describe('alarmes', () => {
  it('lista os abertos, mais graves primeiro, e conta', async () => {
    await openDashboard();
    const items = document.querySelectorAll('#alarms-list .alarm-item');
    expect([...items].map((el) => el.querySelector('.alarm-item__sev').textContent)).toEqual([
      'HH',
      'L',
    ]);
    expect(screen.getByText('2 abertos')).toBeInTheDocument();
    expect(alarmsPanel().getByText(/Muito alto: 96,4/)).toBeInTheDocument();
  });

  it('só os não reconhecidos têm "Reconhecer"; "Reconhecer todos" aparece se houver algum', async () => {
    await openDashboard();
    expect(alarmsPanel().getAllByRole('button', { name: 'Reconhecer' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reconhecer todos' })).toBeVisible();
  });

  it('sem alarmes, avisa e esconde "Reconhecer todos"', async () => {
    await openDashboard({ alarms: [LOW] }); // LOW já reconhecido
    expect(screen.queryByRole('button', { name: 'Reconhecer todos' })).toBeNull();

    const { dashboard } = await openDashboard({ alarms: [] });
    expect(alarmsPanel().getByText('Nenhum alarme aberto.')).toBeInTheDocument();
    expect(dashboard.tagsInAlarm().size).toBe(0);
  });

  it('reconhecer envia o pedido; o estado novo chega pelo tempo real', async () => {
    const { api } = await openDashboard({ routes: { 'POST /api/alarms/a1/ack': { id: 'a1' } } });
    const button = alarmsPanel().getByRole('button', { name: 'Reconhecer' });

    await userEvent.setup().click(button);

    expect(requestsTo(api, 'POST', '/api/alarms/a1/ack')).toHaveLength(1);
    expect(button).toBeDisabled();
  });

  it('se reconhecer falha, o botão volta a funcionar e explica o motivo', async () => {
    await openDashboard({
      routes: { 'POST /api/alarms/a1/ack': response({ message: 'Alarme não está aberto' }, 404) },
    });
    const button = alarmsPanel().getByRole('button', { name: 'Reconhecer' });

    await userEvent.setup().click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveAttribute('title', 'Alarme não está aberto');
  });

  it('"Reconhecer todos" envia um pedido só', async () => {
    const { api } = await openDashboard({
      routes: { 'POST /api/alarms/ack-all': { acknowledged: 1 } },
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Reconhecer todos' }));
    expect(requestsTo(api, 'POST', '/api/alarms/ack-all')).toHaveLength(1);
  });

  it('eventos de alarme atualizam a lista e o destaque do card', async () => {
    const { dashboard } = await openDashboard({ alarms: [] });
    expect(card('TIC-101.PV')).not.toHaveClass('tag-card--alarm');

    dashboard.handleAlarm(HIGH);
    expect(card('TIC-101.PV')).toHaveClass('tag-card--alarm');
    expect([...dashboard.tagsInAlarm()]).toEqual(['TIC-101.PV']);

    // Normalizado: continua na lista (falta reconhecer), sem destaque.
    dashboard.handleAlarm({ ...HIGH, clearedAt: '2026-10-09T12:01:00Z', state: 'CLEARED_UNACKED' });
    expect(card('TIC-101.PV')).not.toHaveClass('tag-card--alarm');
    expect(screen.getByText('1 aberto')).toBeInTheDocument();

    // Encerrado (normalizado e reconhecido): sai da lista.
    dashboard.handleAlarm({ ...HIGH, state: 'CLOSED' });
    expect(screen.getByText('0 abertos')).toBeInTheDocument();
  });
});
