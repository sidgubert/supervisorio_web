import { screen } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const mockGoTo = jest.fn();
jest.mock('../../public/js/navigation.js', () => ({ goTo: (url) => mockGoTo(url) }));

/** Abre a página de login com a autenticação ligada (ou não) e a API dada. */
async function openLogin(routes = {}, enabled = true) {
  loadPage('login.html');
  const api = mockApi({ 'GET /api/auth/status': { enabled }, ...routes });
  const { ready } = await loadModule('login.js');
  await ready;
  return api;
}

async function signIn(username = 'operador', password = 'segredo') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Usuário'), username);
  await user.type(screen.getByLabelText('Senha'), password);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

beforeEach(() => mockGoTo.mockClear());

it('com a autenticação desligada, vai direto ao dashboard', async () => {
  await openLogin({}, false);
  expect(mockGoTo).toHaveBeenCalledWith('/');
});

it('login certo: envia as credenciais, guarda a sessão e abre o dashboard', async () => {
  const api = await openLogin({
    'POST /api/auth/login': { token: 'tok-123', user: { username: 'operador' } },
  });

  await signIn('operador', 'segredo');

  expect(requestsTo(api, 'POST', '/api/auth/login')[0].body).toEqual({
    username: 'operador',
    password: 'segredo',
  });
  expect(localStorage.getItem('talos_token')).toBe('tok-123');
  expect(localStorage.getItem('talos_user')).toBe('operador');
  expect(mockGoTo).toHaveBeenCalledWith('/');
});

it('credenciais erradas (401): avisa e continua na página', async () => {
  await openLogin({ 'POST /api/auth/login': response({ message: 'Unauthorized' }, 401) });

  await signIn('operador', 'errada');

  expect(await screen.findByText('Usuário ou senha inválidos.')).toBeVisible();
  expect(localStorage.getItem('talos_token')).toBeNull();
  expect(mockGoTo).not.toHaveBeenCalled();
});

it('muitas tentativas (429): mostra a mensagem da API, com o tempo de espera', async () => {
  await openLogin({
    'POST /api/auth/login': response({ message: 'Muitas tentativas de login. Aguarde 42 s.' }, 429),
  });

  await signIn();

  expect(await screen.findByText('Muitas tentativas de login. Aguarde 42 s.')).toBeVisible();
});

it('sem conexão com o servidor: avisa', async () => {
  await openLogin({
    'POST /api/auth/login': () => {
      throw new TypeError('Failed to fetch');
    },
  });

  await signIn();

  expect(await screen.findByText('Sem conexão com o servidor.')).toBeVisible();
});

it('a mensagem de erro some na tentativa seguinte', async () => {
  let attempts = 0;
  await openLogin({
    'POST /api/auth/login': () =>
      ++attempts === 1
        ? response({ message: 'Unauthorized' }, 401)
        : { token: 'tok', user: { username: 'operador' } },
  });

  await signIn('operador', 'errada');
  const message = await screen.findByText('Usuário ou senha inválidos.');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Entrar' }));

  expect(message).not.toBeVisible();
  expect(mockGoTo).toHaveBeenCalledWith('/');
});
