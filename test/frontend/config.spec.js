import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const TIC = {
  tag: 'TIC-101.PV',
  source: 'sim',
  description: 'Temperatura do reator',
  unit: '°C',
  engMin: 0,
  engMax: 100,
  alarmLL: null,
  alarmL: null,
  alarmH: 90,
  alarmHH: null,
  alarmDeadband: null,
  synopticKind: 'tank',
  synopticX: 20,
  synopticY: 35,
};

async function openConfig({ tags = [TIC], routes = {} } = {}) {
  loadPage();
  document.getElementById('view-config').hidden = false;
  const api = mockApi({ 'GET /api/tags': tags, ...routes });
  const config = await loadModule('config.js');
  await config.initConfig();
  return api;
}

const formOf = (tag) => screen.getByRole('heading', { name: new RegExp(tag) }).closest('form');

it('mostra um formulário por tag, preenchido com o cadastro', async () => {
  await openConfig({ tags: [TIC, { ...TIC, tag: 'PIC-201.PV', unit: 'bar' }] });
  const form = within(formOf('TIC-101.PV'));

  expect(screen.getAllByRole('button', { name: 'Salvar' })).toHaveLength(2);
  expect(form.getByLabelText('Descrição')).toHaveValue('Temperatura do reator');
  expect(form.getByLabelText('Unidade')).toHaveValue('°C');
  expect(form.getByLabelText('H (alto)')).toHaveValue(90);
  expect(form.getByLabelText('L (baixo)')).toHaveValue(null);
  expect(form.getByLabelText('Sinótico')).toHaveValue('tank');
  expect(form.getByLabelText('Sinótico X (%)')).toHaveValue(20);
});

it('textos do cadastro entram como valor, sem interpretar HTML', async () => {
  const hostile = '"><img src=x onerror="alert(1)">';
  await openConfig({ tags: [{ ...TIC, description: hostile }] });
  expect(within(formOf('TIC-101.PV')).getByLabelText('Descrição')).toHaveValue(hostile);
  expect(document.querySelector('#config-list img')).toBeNull();
});

it('salvar envia o cadastro com números convertidos e campos vazios como null', async () => {
  const api = await openConfig({ routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } } });
  const changed = jest.fn();
  window.addEventListener('talos:tags-changed', changed);
  const form = within(formOf('TIC-101.PV'));
  const user = userEvent.setup();

  await user.clear(form.getByLabelText('H (alto)'));
  await user.type(form.getByLabelText('H (alto)'), '95.5');
  await user.clear(form.getByLabelText('Unidade'));
  await user.click(form.getByRole('button', { name: 'Salvar' }));

  expect(await form.findByText('Salvo.')).toHaveClass('ok');
  expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')[0].body).toEqual({
    description: 'Temperatura do reator',
    unit: null,
    engMin: 0,
    engMax: 100,
    alarmLL: null,
    alarmL: null,
    alarmH: 95.5,
    alarmHH: null,
    alarmDeadband: null,
    synopticKind: 'tank',
    synopticX: 20,
    synopticY: 35,
  });
  // O dashboard e o sinótico recarregam o cadastro.
  expect(changed).toHaveBeenCalledTimes(1);
  window.removeEventListener('talos:tags-changed', changed);
});

it('tirar a tag do sinótico envia synopticKind nulo', async () => {
  const api = await openConfig({ routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } } });
  const form = within(formOf('TIC-101.PV'));
  const user = userEvent.setup();

  await user.selectOptions(form.getByLabelText('Sinótico'), '— fora do sinótico —');
  await user.click(form.getByRole('button', { name: 'Salvar' }));

  await waitFor(() =>
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')[0].body.synopticKind).toBeNull(),
  );
});

it('erro de validação da API aparece no formulário, sem avisar as outras telas', async () => {
  await openConfig({
    routes: {
      'PATCH /api/tags/TIC-101.PV': response(
        { message: ['alarmH must not be less than alarmL', 'engMax must be greater than engMin'] },
        400,
      ),
    },
  });
  const changed = jest.fn();
  window.addEventListener('talos:tags-changed', changed);
  const form = within(formOf('TIC-101.PV'));

  await userEvent.setup().click(form.getByRole('button', { name: 'Salvar' }));

  const message = await form.findByText(
    'alarmH must not be less than alarmL; engMax must be greater than engMin',
  );
  expect(message).toHaveClass('err');
  expect(changed).not.toHaveBeenCalled();
  window.removeEventListener('talos:tags-changed', changed);
});
