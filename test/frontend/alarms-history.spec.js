import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const ACKED = {
  id: 'a1',
  tag: 'FIC-301.PV',
  level: 'H',
  limitValue: 130,
  raisedAt: '2026-10-09T12:00:00Z',
  raisedValue: 131.2,
  clearedAt: null,
  clearedValue: null,
  ackedAt: '2026-10-09T12:00:05Z',
  ackedBy: 'operador',
  state: 'ACTIVE_ACKED',
};
const UNACKED = {
  ...ACKED,
  id: 'a2',
  tag: 'LIC-401.PV',
  level: 'LL',
  limitValue: 10,
  raisedValue: 9.5,
  clearedAt: '2026-10-09T12:01:00Z',
  clearedValue: 12,
  ackedAt: null,
  ackedBy: null,
  state: 'CLEARED_UNACKED',
};

async function openHistory(routes) {
  loadPage();
  document.getElementById('view-alarms').hidden = false;
  const api = mockApi({ 'GET /api/alarms/history': [ACKED, UNACKED], ...routes });
  const history = await loadModule('alarms-history.js');
  history.initAlarmHistory();
  await history.refreshAlarmHistory();
  return api;
}

const rowOf = (tag) => screen.getByText(tag).closest('tr');

it('lista os alarmes com estado e quem reconheceu', async () => {
  await openHistory();
  const acked = within(rowOf('FIC-301.PV'));
  expect(acked.getByText('Ativo, reconhecido')).toBeInTheDocument();
  expect(acked.getByText('por operador')).toBeInTheDocument();
  expect(rowOf('FIC-301.PV')).toHaveClass('row--active'); // ainda não normalizou

  const unacked = within(rowOf('LIC-401.PV'));
  expect(unacked.getByText('Normalizado, não reconhecido')).toBeInTheDocument();
  expect(rowOf('LIC-401.PV')).not.toHaveClass('row--active');
});

it('só os não reconhecidos têm o botão "Reconhecer"', async () => {
  await openHistory();
  expect(within(rowOf('FIC-301.PV')).queryByRole('button')).toBeNull();
  expect(within(rowOf('LIC-401.PV')).getByRole('button', { name: 'Reconhecer' })).toBeEnabled();
});

it('textos do alarme entram como texto, sem interpretar HTML', async () => {
  await openHistory({
    'GET /api/alarms/history': [{ ...ACKED, tag: '<b>X</b>', ackedBy: '<i>Eva</i>' }],
  });
  expect(screen.getByText('<b>X</b>')).toBeInTheDocument();
  expect(screen.getByText('por <i>Eva</i>')).toBeInTheDocument();
  expect(document.querySelector('#alarm-history-body b, #alarm-history-body i')).toBeNull();
});

it('reconhecer envia o pedido e recarrega a lista', async () => {
  let acked = false;
  const api = await openHistory({
    'GET /api/alarms/history': () =>
      acked
        ? [ACKED, { ...UNACKED, ackedAt: '2026-10-09T12:02:00Z', ackedBy: 'operador' }]
        : [ACKED, UNACKED],
    'POST /api/alarms/a2/ack': () => {
      acked = true;
      return { id: 'a2' };
    },
  });

  await userEvent
    .setup()
    .click(within(rowOf('LIC-401.PV')).getByRole('button', { name: 'Reconhecer' }));

  await waitFor(() => expect(within(rowOf('LIC-401.PV')).queryByRole('button')).toBeNull());
  expect(requestsTo(api, 'POST', '/api/alarms/a2/ack')).toHaveLength(1);
  expect(requestsTo(api, 'GET', '/api/alarms/history')).toHaveLength(2);
});

it('se reconhecer falha, o botão volta a funcionar e explica o motivo', async () => {
  await openHistory({
    'POST /api/alarms/a2/ack': response({ message: 'Alarme não está aberto' }, 404),
  });
  const button = within(rowOf('LIC-401.PV')).getByRole('button', { name: 'Reconhecer' });

  await userEvent.setup().click(button);

  await waitFor(() => expect(button).toHaveTextContent('Erro'));
  expect(button).toBeEnabled();
  expect(button).toHaveAttribute('title', 'Alarme não está aberto');
});

it('sem alarmes nas últimas 24 h, avisa', async () => {
  await openHistory({ 'GET /api/alarms/history': [] });
  expect(screen.getByText('Nenhum alarme nas últimas 24 h.')).toBeInTheDocument();
});

it('"Atualizar" busca a lista de novo', async () => {
  const api = await openHistory();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Atualizar' }));
  await waitFor(() => expect(requestsTo(api, 'GET', '/api/alarms/history')).toHaveLength(2));
});
