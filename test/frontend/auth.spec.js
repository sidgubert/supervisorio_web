import { loadModule, mockApi, requestsTo, response } from './helpers.js';

const mockGoTo = jest.fn();
jest.mock('../../public/js/navigation.js', () => ({ goTo: (url) => mockGoTo(url) }));

let auth;

beforeEach(async () => {
  mockGoTo.mockClear();
  auth = await loadModule('auth.js');
});

describe('sessão', () => {
  it('guarda e apaga o token e o usuário', () => {
    auth.setSession('abc', 'operador');
    expect(auth.getToken()).toBe('abc');
    expect(auth.getUser()).toBe('operador');

    auth.clearSession();
    expect(auth.getToken()).toBeNull();
    expect(auth.getUser()).toBeNull();
  });
});

describe('apiFetch', () => {
  it('envia o token e, com corpo, o Content-Type JSON', async () => {
    auth.setSession('abc', 'operador');
    const api = mockApi({ 'PATCH /api/tags/T': { tag: 'T' } });

    await auth.apiFetch('/api/tags/T', { method: 'PATCH', body: JSON.stringify({ unit: 'bar' }) });

    const [request] = requestsTo(api, 'PATCH', '/api/tags/T');
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer abc',
    });
  });

  it('sem sessão, não envia Authorization', async () => {
    const api = mockApi({ 'GET /api/tags': [] });
    await auth.apiFetch('/api/tags');
    expect(requestsTo(api, 'GET', '/api/tags')[0].headers).toEqual({});
  });

  it('devolve a resposta, inclusive de erro', async () => {
    mockApi({ 'GET /api/tags/X': response({ message: 'não encontrada' }, 404) });
    const res = await auth.apiFetch('/api/tags/X');
    expect(res.status).toBe(404);
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it('401: apaga a sessão e leva ao login', async () => {
    auth.setSession('expirado', 'operador');
    mockApi({ 'GET /api/tags': response({ message: 'Unauthorized' }, 401) });

    await expect(auth.apiFetch('/api/tags')).rejects.toThrow('Não autenticado');
    expect(auth.getToken()).toBeNull();
    expect(mockGoTo).toHaveBeenCalledWith('/login.html');
  });
});

describe('withToken (EventSource não envia cabeçalhos)', () => {
  it('acrescenta o token à URL, codificado', () => {
    auth.setSession('a+b/c', 'operador');
    expect(auth.withToken('/api/dashboard/stream')).toBe('/api/dashboard/stream?token=a%2Bb%2Fc');
    expect(auth.withToken('/x?y=1')).toBe('/x?y=1&token=a%2Bb%2Fc');
  });

  it('sem sessão, devolve a URL como está', () => {
    expect(auth.withToken('/api/dashboard/stream')).toBe('/api/dashboard/stream');
  });
});

describe('requireAuth', () => {
  it('autenticação ligada e sem sessão: leva ao login', async () => {
    mockApi({ 'GET /api/auth/status': { enabled: true } });
    await expect(auth.requireAuth()).resolves.toBe(true);
    expect(mockGoTo).toHaveBeenCalledWith('/login.html');
  });

  it('autenticação ligada com sessão: continua', async () => {
    auth.setSession('abc', 'operador');
    mockApi({ 'GET /api/auth/status': { enabled: true } });
    await expect(auth.requireAuth()).resolves.toBe(true);
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it('autenticação desligada: continua', async () => {
    mockApi({ 'GET /api/auth/status': { enabled: false } });
    await expect(auth.requireAuth()).resolves.toBe(false);
    expect(mockGoTo).not.toHaveBeenCalled();
  });

  it('consulta o estado da autenticação uma vez por página', async () => {
    const api = mockApi({ 'GET /api/auth/status': { enabled: false } });
    await auth.requireAuth();
    await auth.authStatus();
    expect(requestsTo(api, 'GET', '/api/auth/status')).toHaveLength(1);
  });
});
