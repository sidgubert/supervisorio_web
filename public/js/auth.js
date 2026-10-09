import { goTo } from './navigation.js';

/**
 * Sessão no navegador. Com AUTH_ENABLED=true, a API exige um token em toda
 * requisição: no cabeçalho Authorization (fetch) ou em ?token= (EventSource,
 * que não envia cabeçalhos).
 */
const TOKEN_KEY = 'talos_token';
const USER_KEY = 'talos_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser() {
  return localStorage.getItem(USER_KEY);
}

export function setSession(token, username) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

let statusPromise;

/** { enabled }: se a autenticação está ligada (consultado uma vez por página). */
export function authStatus() {
  statusPromise ??= fetch('/api/auth/status').then((r) => r.json());
  return statusPromise;
}

/** fetch com o token; um 401 leva à tela de login. */
export async function apiFetch(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    clearSession();
    goTo('/login.html');
    throw new Error('Não autenticado');
  }
  return res;
}

/** URL com ?token= (para EventSource). */
export function withToken(url) {
  const token = getToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Com a autenticação ligada e sem token, vai para o login. Devolve se está ligada. */
export async function requireAuth() {
  const { enabled } = await authStatus();
  if (enabled && !getToken()) goTo('/login.html');
  return enabled;
}
