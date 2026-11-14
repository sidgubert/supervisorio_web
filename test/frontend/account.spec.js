import { screen, waitFor, within } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { loadModule, loadPage, mockApi, requestsTo, response } from './helpers.js';

const mockGoTo = jest.fn();
jest.mock('../../public/js/navigation.js', () => ({ goTo: (url) => mockGoTo(url) }));

const ROOT = {
  id: '00000000-0000-4000-8000-000000000001',
  username: 'root',
  role: 'admin',
  active: true,
  createdAt: '2026-11-01T12:00:00Z',
};
const MARIA = {
  id: '00000000-0000-4000-8000-000000000002',
  username: 'maria',
  role: 'operator',
  active: true,
  createdAt: '2026-11-02T12:00:00Z',
};

async function openAccount({ me = { username: 'root', role: 'admin' }, routes = {} } = {}) {
  loadPage();
  document.getElementById('view-account').hidden = false;
  const api = mockApi({ 'GET /api/users': [MARIA, ROOT], ...routes });
  const auth = await loadModule('auth.js');
  auth.setRole(me.role);
  const account = await import('../../public/js/account.js');
  await account.initAccount(me);
  return api;
}

const rowOf = (username) => screen.getByText(username, { selector: 'code' }).closest('tr');

beforeEach(() => mockGoTo.mockClear());

describe('trocar a própria senha', () => {
  it('envia a senha atual e a nova, e limpa o formulário', async () => {
    const api = await openAccount({
      me: { username: 'maria', role: 'operator' },
      routes: { 'POST /api/auth/password': response({ token: 'tok-novo' }) },
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Senha atual'), 'senha-antiga');
    await user.type(screen.getByLabelText(/^Nova senha \(/), 'senha-nova-1');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByText('Senha alterada.')).toBeInTheDocument();
    expect(requestsTo(api, 'POST', '/api/auth/password')[0].body).toEqual({
      current: 'senha-antiga',
      password: 'senha-nova-1',
    });
    expect(screen.getByLabelText('Senha atual')).toHaveValue('');
    // O token antigo deixou de valer: a sessão segue com o novo.
    expect(localStorage.getItem('talos_token')).toBe('tok-novo');
  });

  it('senha atual errada mostra o erro sem encerrar a sessão', async () => {
    localStorage.setItem('talos_token', 'tok');
    await openAccount({
      me: { username: 'maria', role: 'operator' },
      routes: { 'POST /api/auth/password': response({ message: 'Senha atual incorreta.' }, 403) },
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Senha atual'), 'errada');
    await user.type(screen.getByLabelText(/^Nova senha \(/), 'senha-nova-1');
    await user.click(screen.getByRole('button', { name: 'Trocar senha' }));

    expect(await screen.findByText('Senha atual incorreta.')).toBeInTheDocument();
    expect(localStorage.getItem('talos_token')).toBe('tok');
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it('quem não é administrador não vê nem consulta os usuários', async () => {
    const api = await openAccount({ me: { username: 'maria', role: 'operator' } });
    expect(screen.getByText('maria · Operador')).toBeInTheDocument();
    expect(document.getElementById('users-section')).not.toBeVisible();
    expect(requestsTo(api, 'GET', '/api/users')).toHaveLength(0);
  });
});

describe('usuários (administrador)', () => {
  it('lista os usuários e trava as ações sobre a própria conta', async () => {
    await openAccount();
    expect(document.getElementById('users-section')).toBeVisible();
    expect(within(rowOf('maria')).getByRole('combobox')).toHaveValue('operator');
    expect(within(rowOf('maria')).getByRole('button', { name: 'Remover' })).toBeEnabled();

    const own = within(rowOf('root'));
    expect(own.getByText('(você)')).toBeInTheDocument();
    expect(own.getByRole('combobox')).toBeDisabled();
    expect(own.getByRole('button', { name: 'Desativar' })).toBeDisabled();
    expect(own.getByRole('button', { name: 'Remover' })).toBeDisabled();
  });

  it('cria um usuário e recarrega a lista', async () => {
    const api = await openAccount({ routes: { 'POST /api/users': response({}, 201) } });
    const form = within(document.getElementById('user-form'));
    const user = userEvent.setup();
    await user.type(form.getByLabelText('Usuário'), 'joao');
    await user.type(form.getByLabelText(/^Senha/), 'senha-do-joao');
    await user.selectOptions(form.getByLabelText('Perfil'), 'engineer');
    await user.click(form.getByRole('button', { name: 'Criar usuário' }));

    expect(await screen.findByText('Usuário joao criado.')).toBeInTheDocument();
    expect(requestsTo(api, 'POST', '/api/users')[0].body).toEqual({
      username: 'joao',
      password: 'senha-do-joao',
      role: 'engineer',
    });
    expect(requestsTo(api, 'GET', '/api/users')).toHaveLength(2);
    expect(form.getByLabelText('Usuário')).toHaveValue('');
  });

  it('nome repetido mostra o erro da API e mantém o formulário', async () => {
    await openAccount({
      routes: { 'POST /api/users': response({ message: 'Usuário "maria" já existe.' }, 409) },
    });
    const form = within(document.getElementById('user-form'));
    const user = userEvent.setup();
    await user.type(form.getByLabelText('Usuário'), 'maria');
    await user.type(form.getByLabelText(/^Senha/), 'outra-senha-1');
    await user.click(form.getByRole('button', { name: 'Criar usuário' }));

    expect(await screen.findByText('Usuário "maria" já existe.')).toBeInTheDocument();
    expect(form.getByLabelText('Usuário')).toHaveValue('maria');
  });

  it('troca o perfil e desativa pelo PATCH', async () => {
    const api = await openAccount({ routes: { [`PATCH /api/users/${MARIA.id}`]: MARIA } });
    const user = userEvent.setup();

    await user.selectOptions(within(rowOf('maria')).getByRole('combobox'), 'engineer');
    expect(await screen.findByText('Perfil de maria alterado.')).toBeInTheDocument();

    await user.click(within(rowOf('maria')).getByRole('button', { name: 'Desativar' }));
    expect(await screen.findByText('maria desativado.')).toBeInTheDocument();

    expect(requestsTo(api, 'PATCH', `/api/users/${MARIA.id}`).map((r) => r.body)).toEqual([
      { role: 'engineer' },
      { active: false },
    ]);
  });

  it('usuário inativo oferece "Ativar"', async () => {
    const api = await openAccount({
      routes: {
        'GET /api/users': [{ ...MARIA, active: false }, ROOT],
        [`PATCH /api/users/${MARIA.id}`]: MARIA,
      },
    });
    expect(within(rowOf('maria')).getByText('Inativo')).toBeInTheDocument();
    await userEvent.setup().click(within(rowOf('maria')).getByRole('button', { name: 'Ativar' }));
    await waitFor(() =>
      expect(requestsTo(api, 'PATCH', `/api/users/${MARIA.id}`)[0]?.body).toEqual({ active: true }),
    );
  });

  it('redefine a senha de outro usuário, recusando senha curta sem chamar a API', async () => {
    const api = await openAccount({ routes: { [`PATCH /api/users/${MARIA.id}`]: MARIA } });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Nova senha de maria'), 'curta');
    await user.click(within(rowOf('maria')).getByRole('button', { name: 'Redefinir senha' }));
    expect(screen.getByText('A nova senha deve ter ao menos 8 caracteres.')).toBeInTheDocument();
    expect(requestsTo(api, 'PATCH', `/api/users/${MARIA.id}`)).toHaveLength(0);

    await user.type(screen.getByLabelText('Nova senha de maria'), '-mas-agora-longa');
    await user.click(within(rowOf('maria')).getByRole('button', { name: 'Redefinir senha' }));
    expect(await screen.findByText('Senha de maria redefinida.')).toBeInTheDocument();
    expect(requestsTo(api, 'PATCH', `/api/users/${MARIA.id}`)[0].body).toEqual({
      password: 'curta-mas-agora-longa',
    });
  });

  it('remove só depois da confirmação', async () => {
    const api = await openAccount({
      routes: { [`DELETE /api/users/${MARIA.id}`]: response(null, 204) },
    });
    const confirm = jest.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();

    await user.click(within(rowOf('maria')).getByRole('button', { name: 'Remover' }));
    expect(requestsTo(api, 'DELETE', `/api/users/${MARIA.id}`)).toHaveLength(0);

    confirm.mockReturnValue(true);
    await user.click(within(rowOf('maria')).getByRole('button', { name: 'Remover' }));
    expect(await screen.findByText('maria removido.')).toBeInTheDocument();
    expect(requestsTo(api, 'DELETE', `/api/users/${MARIA.id}`)).toHaveLength(1);
  });

  it('erro da API (ex: último administrador) aparece na tela', async () => {
    await openAccount({
      routes: {
        [`PATCH /api/users/${MARIA.id}`]: response(
          { message: 'Deve restar ao menos um administrador ativo.' },
          400,
        ),
      },
    });
    await userEvent.setup().selectOptions(within(rowOf('maria')).getByRole('combobox'), 'viewer');
    expect(
      await screen.findByText('Deve restar ao menos um administrador ativo.'),
    ).toBeInTheDocument();
  });

  it('nome de usuário entra como texto, sem interpretar HTML', async () => {
    await openAccount({
      routes: { 'GET /api/users': [{ ...MARIA, username: '<img src=x onerror=alert(1)>' }] },
    });
    expect(document.querySelector('#users-body img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });
});
