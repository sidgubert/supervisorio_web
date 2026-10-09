import { fireEvent, screen, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const TAGS = [
  {
    tag: 'TIC-101.PV',
    description: 'Temperatura do reator',
    unit: '°C',
    synopticKind: 'tank',
    synopticX: 20,
    synopticY: 35,
    engMin: 0,
    engMax: 100,
  },
  {
    tag: 'PIC-201.PV',
    description: 'Pressão da linha',
    unit: 'bar',
    synopticKind: 'pressure',
    synopticX: 75,
    synopticY: 35,
    engMin: null,
    engMax: null,
  },
  { tag: 'FQ-1', description: 'Fora do sinótico', synopticKind: null },
];

const LATEST = [
  { tag: 'TIC-101.PV', value: 75, quality: 192, source: 'sim', time: '2026-10-09T12:00:00Z' },
];

/**
 * Abre a tela do sinótico com a API falsa. No jsdom não há layout: a matriz
 * da tela é a identidade, então (clientX, clientY) já são coordenadas do
 * desenho. O jsdom trunca clientX/clientY para inteiros; o arredondamento para
 * a grade de 1% é testado em synoptic-geometry.spec.js.
 */
async function openSynoptic({ tags = TAGS, routes = {}, inAlarm } = {}) {
  loadPage();
  // No app, o roteamento (app.js) mostra a tela; aqui ela é aberta direto.
  document.getElementById('view-synoptic').hidden = false;
  const api = mockApi({
    'GET /api/tags': tags,
    'GET /api/dashboard/tags': LATEST,
    ...routes,
  });
  const synoptic = await loadModule('synoptic.js');
  const svg = document.getElementById('synoptic-svg');
  svg.getScreenCTM = () => ({ inverse: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) });
  await synoptic.initSynoptic(inAlarm);
  return { api, synoptic, svg };
}

const instrument = (tag) => document.querySelector(`.syn-node[data-tag="${tag}"]`);
const positionOf = (tag) => instrument(tag).getAttribute('transform');
const editButton = () => screen.getByRole('button', { name: /Editar posições|Concluir/ });
const status = () => screen.getByRole('status');

/** Arrasta um instrumento de (x0, y0) até (x1, y1), em coordenadas do desenho. */
function drag(svg, tag, [x0, y0], [x1, y1], end = 'pointerUp') {
  fireEvent.pointerDown(instrument(tag).firstElementChild, {
    clientX: x0,
    clientY: y0,
    button: 0,
    pointerId: 7,
  });
  fireEvent.pointerMove(svg, { clientX: x1, clientY: y1, pointerId: 7 });
  if (end) fireEvent[end](svg, { clientX: x1, clientY: y1, pointerId: 7 });
}

describe('desenho', () => {
  it('mostra só as tags com desenho, na posição do cadastro', async () => {
    await openSynoptic();
    expect(document.querySelectorAll('.syn-node')).toHaveLength(2);
    expect(instrument('FQ-1')).toBeNull();
    expect(positionOf('TIC-101.PV')).toBe('translate(20,35)');
    expect(instrument('TIC-101.PV')).toHaveTextContent('Temperatura do reator');
  });

  it('o rótulo entra como texto, sem interpretar HTML', async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    await openSynoptic({ tags: [{ ...TAGS[0], description: hostile }] });
    expect(instrument('TIC-101.PV').querySelector('.syn-label')).toHaveTextContent(hostile);
    expect(document.querySelector('#synoptic-svg img')).toBeNull();
  });

  it('mostra o último valor e preenche o tanque pela faixa de engenharia', async () => {
    const { synoptic } = await openSynoptic();
    const tank = instrument('TIC-101.PV');
    expect(tank.querySelector('.syn-val')).toHaveTextContent('75 °C');
    expect(tank.querySelector('.syn-fill')).toHaveAttribute('height', '7.5'); // 75% de 10

    synoptic.updateSynoptic({ tag: 'TIC-101.PV', value: 20.04 });
    expect(tank.querySelector('.syn-val')).toHaveTextContent('20 °C');
    expect(tank.querySelector('.syn-fill')).toHaveAttribute('height', '2.004');
  });

  it('destaca os instrumentos em alarme', async () => {
    const { synoptic } = await openSynoptic({ inAlarm: new Set(['PIC-201.PV']) });
    expect(instrument('PIC-201.PV')).toHaveClass('syn-node--alarm');
    expect(instrument('TIC-101.PV')).not.toHaveClass('syn-node--alarm');

    synoptic.setSynopticAlarms(new Set());
    expect(instrument('PIC-201.PV')).not.toHaveClass('syn-node--alarm');
  });
});

describe('fora do modo de edição', () => {
  it('clicar num instrumento leva aos gráficos', async () => {
    await openSynoptic();
    await userEvent.setup().click(instrument('TIC-101.PV').firstElementChild);
    expect(window.location.hash).toBe('#dashboard');
  });

  it('arrastar não move nem grava', async () => {
    const { api, svg } = await openSynoptic();
    drag(svg, 'TIC-101.PV', [20, 35], [60, 70]);
    expect(positionOf('TIC-101.PV')).toBe('translate(20,35)');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0);
  });
});

describe('modo de edição', () => {
  it('"Editar posições" liga a edição; "Concluir" desliga', async () => {
    const { svg } = await openSynoptic();
    const user = userEvent.setup();

    await user.click(editButton());
    expect(editButton()).toHaveTextContent('Concluir');
    expect(editButton()).toHaveAttribute('aria-pressed', 'true');
    expect(svg).toHaveClass('synoptic--editing');
    expect(instrument('TIC-101.PV')).toHaveAttribute('tabindex', '0');
    expect(status()).toHaveTextContent('Arraste os instrumentos');

    await user.click(editButton());
    expect(editButton()).toHaveTextContent('Editar posições');
    expect(editButton()).toHaveAttribute('aria-pressed', 'false');
    expect(svg).not.toHaveClass('synoptic--editing');
    expect(instrument('TIC-101.PV')).not.toHaveAttribute('tabindex');
  });

  it('clicar num instrumento não troca de tela', async () => {
    await openSynoptic();
    const user = userEvent.setup();
    await user.click(editButton());
    await user.click(instrument('TIC-101.PV').firstElementChild);
    expect(window.location.hash).toBe('');
  });

  it('arrastar move o instrumento e grava a posição ao soltar', async () => {
    const { api, svg } = await openSynoptic({
      routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } },
    });
    await userEvent.setup().click(editButton());

    drag(svg, 'TIC-101.PV', [20, 35], [45, 61], null);
    expect(instrument('TIC-101.PV')).toHaveClass('syn-node--dragging');
    expect(positionOf('TIC-101.PV')).toBe('translate(45,61)');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0); // só ao soltar

    fireEvent.pointerUp(svg, { clientX: 45, clientY: 61, pointerId: 7 });
    await waitFor(() => expect(status()).toHaveTextContent('TIC-101.PV: posição salva (45, 61).'));
    expect(status()).toHaveClass('ok');
    expect(instrument('TIC-101.PV')).not.toHaveClass('syn-node--dragging');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV').map((r) => r.body)).toEqual([
      { synopticX: 45, synopticY: 61 },
    ]);
  });

  it('o ponto de pega no instrumento é mantido durante o arraste', async () => {
    const { svg } = await openSynoptic({
      routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } },
    });
    await userEvent.setup().click(editButton());
    // Pega 3 à direita e 2 abaixo do centro: o centro anda junto, sem pular.
    drag(svg, 'TIC-101.PV', [23, 37], [53, 47]);
    expect(positionOf('TIC-101.PV')).toBe('translate(50,45)');
  });

  it('soltar no mesmo lugar não grava', async () => {
    const { api, svg } = await openSynoptic();
    await userEvent.setup().click(editButton());
    drag(svg, 'TIC-101.PV', [20, 35], [20, 35]);
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0);
  });

  it('se a gravação falha, o instrumento volta e o erro aparece', async () => {
    const { svg } = await openSynoptic({
      routes: {
        'PATCH /api/tags/TIC-101.PV': response({ message: 'Internal server error' }, 500),
      },
    });
    await userEvent.setup().click(editButton());

    drag(svg, 'TIC-101.PV', [20, 35], [60, 70]);

    await waitFor(() =>
      expect(status()).toHaveTextContent(
        'TIC-101.PV: não foi possível salvar (Internal server error); posição anterior restaurada.',
      ),
    );
    expect(status()).toHaveClass('err');
    expect(positionOf('TIC-101.PV')).toBe('translate(20,35)');
  });

  it('arraste cancelado pelo navegador volta sem gravar', async () => {
    const { api, svg } = await openSynoptic();
    await userEvent.setup().click(editButton());
    drag(svg, 'TIC-101.PV', [20, 35], [60, 70], 'pointerCancel');
    expect(positionOf('TIC-101.PV')).toBe('translate(20,35)');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0);
  });

  it('o desenho inteiro, com o rótulo, fica dentro da área', async () => {
    const { api, svg } = await openSynoptic({
      routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } },
    });
    // Medida do tanque com o rótulo, relativa ao centro (sem layout no jsdom).
    instrument('TIC-101.PV').getBBox = () => ({ x: -8, y: -9, width: 16, height: 15 });
    await userEvent.setup().click(editButton());

    drag(svg, 'TIC-101.PV', [20, 35], [150, -20]);

    expect(positionOf('TIC-101.PV')).toBe('translate(92,9)');
    await waitFor(() =>
      expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV').map((r) => r.body)).toEqual([
        { synopticX: 92, synopticY: 9 },
      ]),
    );
  });

  it('"Concluir" no meio de um arraste grava onde o instrumento estiver', async () => {
    const { api, svg } = await openSynoptic({
      routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } },
    });
    await userEvent.setup().click(editButton());
    drag(svg, 'TIC-101.PV', [20, 35], [30, 40], null);

    fireEvent.click(editButton());

    expect(instrument('TIC-101.PV')).not.toHaveClass('syn-node--dragging');
    await waitFor(() =>
      expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV').map((r) => r.body)).toEqual([
        { synopticX: 30, synopticY: 40 },
      ]),
    );
  });
});

describe('teclado no modo de edição', () => {
  afterEach(() => jest.useRealTimers());

  it('setas movem 1% (5% com Shift) e a sequência é gravada uma vez só', async () => {
    const { api } = await openSynoptic({
      routes: { 'PATCH /api/tags/TIC-101.PV': { tag: 'TIC-101.PV' } },
    });
    fireEvent.click(editButton());
    jest.useFakeTimers();
    const tank = instrument('TIC-101.PV');
    tank.focus();

    fireEvent.keyDown(tank, { key: 'ArrowRight' });
    fireEvent.keyDown(tank, { key: 'ArrowRight' });
    fireEvent.keyDown(tank, { key: 'ArrowRight' });
    fireEvent.keyDown(tank, { key: 'ArrowDown', shiftKey: true });
    expect(positionOf('TIC-101.PV')).toBe('translate(23,40)');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0);

    await jest.advanceTimersByTimeAsync(500);
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV').map((r) => r.body)).toEqual([
      { synopticX: 23, synopticY: 40 },
    ]);
  });

  it('fora da edição, as setas não movem', async () => {
    const { api } = await openSynoptic();
    const tank = instrument('TIC-101.PV');
    fireEvent.keyDown(tank, { key: 'ArrowRight' });
    expect(positionOf('TIC-101.PV')).toBe('translate(20,35)');
    expect(requestsTo(api, 'PATCH', '/api/tags/TIC-101.PV')).toHaveLength(0);
  });
});
