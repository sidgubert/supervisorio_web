import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo } from './helpers.js';

const mockGoTo = jest.fn();
jest.mock('../../public/js/navigation.js', () => ({ goTo: (url) => mockGoTo(url) }));

const TAGS = [
  {
    tag: 'TIC-101.PV',
    description: 'Temperatura do reator',
    unit: '°C',
    synopticKind: 'tank',
    synopticX: 20,
    synopticY: 35,
  },
];

/** EventSource falso: guarda a conexão aberta para o teste emitir eventos. */
class FakeEventSource {
  static last;
  constructor(url) {
    this.url = url;
    FakeEventSource.last = this;
  }
  emit(data) {
    this.onmessage({ data: JSON.stringify(data) });
  }
}

// O app registra ouvintes no window (hashchange, tags alteradas), que sobrevive
// entre os testes: cada teste remove os seus.
const windowListeners = [];
const addListener = window.addEventListener;

beforeEach(() => {
  mockGoTo.mockClear();
  window.EventSource = FakeEventSource;
  window.Chart = jest.fn((canvas, config) => ({ data: config.data, update: jest.fn() }));
  jest.spyOn(window, 'addEventListener').mockImplementation(function (...args) {
    windowListeners.push(args);
    return addListener.apply(this, args);
  });
});

afterEach(() => {
  for (const args of windowListeners.splice(0)) window.removeEventListener(...args);
  delete window.EventSource;
  delete window.Chart;
});

async function openApp({ enabled = false, routes = {} } = {}) {
  loadPage();
  const api = mockApi({
    'GET /api/auth/status': { enabled },
    'GET /api/dashboard/alarms': { alarms: [], tags: TAGS },
    'GET /api/dashboard/tags': [],
    'GET /api/tags': TAGS,
    'GET /api/auth/me': { username: 'operador' },
    ...routes,
  });
  const app = await loadModule('app.js');
  await app.ready;
  return api;
}

const view = (name) => document.getElementById(`view-${name}`);
const navLink = (name) => within(screen.getByRole('navigation')).getByRole('link', { name });

describe('navegação', () => {
  it('abre nos gráficos e troca de tela pelo menu', async () => {
    await openApp();
    expect(view('dashboard')).toBeVisible();
    expect(view('synoptic')).not.toBeVisible();

    await userEvent.setup().click(navLink('Sinótico'));

    await waitFor(() => expect(view('synoptic')).toBeVisible());
    expect(view('dashboard')).not.toBeVisible();
    expect(navLink('Sinótico')).toHaveClass('nav__link--active');
    expect(navLink('Gráficos')).not.toHaveClass('nav__link--active');
    expect(window.location.hash).toBe('#synoptic');
  });

  it('endereço de tela desconhecida volta aos gráficos', async () => {
    await openApp();
    await userEvent.setup().click(navLink('Sinótico'));
    await waitFor(() => expect(view('synoptic')).toBeVisible());

    window.location.hash = 'nao-existe';

    await waitFor(() => expect(view('dashboard')).toBeVisible());
    expect(view('synoptic')).not.toBeVisible();
  });

  it('abrir o sinótico carrega o desenho', async () => {
    const api = await openApp();
    await userEvent.setup().click(navLink('Sinótico'));
    await waitFor(() =>
      expect(document.querySelector('.syn-node[data-tag="TIC-101.PV"]')).not.toBeNull(),
    );
    expect(requestsTo(api, 'GET', '/api/tags')).toHaveLength(1);
  });
});

describe('cadastro alterado na Configuração', () => {
  it('recarrega as descrições do dashboard e o sinótico aberto', async () => {
    const api = await openApp();
    await userEvent.setup().click(navLink('Sinótico'));
    await waitFor(() => expect(requestsTo(api, 'GET', '/api/tags')).toHaveLength(1));

    window.dispatchEvent(new CustomEvent('talos:tags-changed'));

    await waitFor(() => expect(requestsTo(api, 'GET', '/api/tags')).toHaveLength(2));
    expect(requestsTo(api, 'GET', '/api/dashboard/alarms')).toHaveLength(2);
  });
});

describe('tempo real (SSE)', () => {
  it('conecta ao stream e mostra o estado da conexão', async () => {
    await openApp();
    const stream = FakeEventSource.last;
    expect(stream.url).toBe('/api/dashboard/stream');

    stream.onopen();
    expect(screen.getByText('Tempo real conectado')).toBeInTheDocument();
  });

  it('amostras atualizam o painel de gráficos', async () => {
    await openApp();
    FakeEventSource.last.emit({
      type: 'sample',
      tag: 'TIC-101.PV',
      value: 81.2,
      quality: 192,
      source: 'sim',
      time: '2026-10-09T12:00:00Z',
    });
    expect(screen.getByText('81,2')).toBeInTheDocument();
  });

  it('alarmes aparecem no painel e destacam o instrumento no sinótico', async () => {
    await openApp();
    await userEvent.setup().click(navLink('Sinótico'));
    await waitFor(() => expect(document.querySelector('.syn-node')).not.toBeNull());

    FakeEventSource.last.emit({
      type: 'alarm',
      change: 'raised',
      alarm: {
        id: 'a1',
        tag: 'TIC-101.PV',
        level: 'H',
        priority: 1,
        limitValue: 90,
        raisedValue: 91,
        raisedAt: '2026-10-09T12:00:00Z',
        clearedAt: null,
        ackedAt: null,
        state: 'ACTIVE_UNACKED',
      },
    });

    expect(screen.getByText('1 aberto')).toBeInTheDocument();
    expect(document.querySelector('.syn-node[data-tag="TIC-101.PV"]')).toHaveClass(
      'syn-node--alarm',
    );
  });

  it('se a conexão cai, avisa e confere se a sessão ainda vale', async () => {
    const api = await openApp();
    FakeEventSource.last.onerror();
    expect(screen.getByText('Reconectando…')).toBeInTheDocument();
    await waitFor(() => expect(requestsTo(api, 'GET', '/api/auth/me')).toHaveLength(1));
  });
});

describe('com autenticação', () => {
  it('mostra o usuário, usa o token no stream e "Sair" encerra a sessão', async () => {
    localStorage.setItem('talos_token', 'tok');
    localStorage.setItem('talos_user', 'operador');
    await openApp({ enabled: true });

    expect(screen.getByText('operador')).toBeInTheDocument();
    expect(FakeEventSource.last.url).toBe('/api/dashboard/stream?token=tok');

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sair' }));
    expect(localStorage.getItem('talos_token')).toBeNull();
    expect(mockGoTo).toHaveBeenCalledWith('/login.html');
  });

  it('sem sessão, leva ao login', async () => {
    await openApp({ enabled: true });
    expect(mockGoTo).toHaveBeenCalledWith('/login.html');
  });

  it('com a autenticação desligada, não mostra "Sair"', async () => {
    await openApp();
    expect(screen.queryByRole('button', { name: 'Sair' })).toBeNull();
  });
});
