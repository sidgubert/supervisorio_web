/**
 * Utilitários dos testes do frontend.
 *
 * - loadPage: usa o HTML real de public/, para os testes quebrarem se o HTML
 *   e o JavaScript deixarem de combinar (ids, botões).
 * - mockApi: troca o fetch por uma API falsa, por rota ("MÉTODO /caminho").
 * - loadModule: importa um módulo do zero. Os módulos do dashboard pegam os
 *   elementos da página ao serem carregados, então a página vem antes.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const PUBLIC = join(__dirname, '..', '..', 'public');

/** Põe no document o <body> de uma página de public/ (sem os <script>). */
export function loadPage(file = 'index.html') {
  const html = readFileSync(join(PUBLIC, file), 'utf-8');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)[1];
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
}

/**
 * Resposta no formato que o código usa (ok, status, json, blob). Como num
 * fetch de verdade, cada json() devolve objetos novos: o código pode alterá-los
 * sem afetar os dados dos testes.
 */
export function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(body))),
    blob: () => Promise.resolve(new Blob([typeof body === 'string' ? body : JSON.stringify(body)])),
  };
}

/**
 * Troca o fetch por uma API falsa. `routes` mapeia "MÉTODO /caminho" (sem a
 * query) para o corpo da resposta, uma resposta (response(...)) ou uma
 * função (requisição) => um dos dois. Rota não simulada responde 404.
 */
export function mockApi(routes) {
  const fetchMock = jest.fn(async (url, options = {}) => {
    const method = (options.method ?? 'GET').toUpperCase();
    const { pathname } = new URL(url, 'http://localhost');
    const handler = routes[`${method} ${pathname}`];
    if (handler === undefined) {
      return response({ message: `rota não simulada: ${method} ${url}` }, 404);
    }
    const request = {
      url,
      method,
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    const result = typeof handler === 'function' ? await handler(request) : handler;
    return result && typeof result.ok === 'boolean' ? result : response(result);
  });
  globalThis.fetch = fetchMock;
  return fetchMock;
}

/** Requisições feitas a uma rota: [{ url, method, headers, body }]. */
export function requestsTo(fetchMock, method, path) {
  return fetchMock.mock.calls
    .filter(([url, options = {}]) => {
      const m = (options.method ?? 'GET').toUpperCase();
      return m === method && new URL(url, 'http://localhost').pathname === path;
    })
    .map(([url, options = {}]) => ({
      url,
      method,
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : undefined,
    }));
}

/** Importa um módulo de public/js do zero (sem o estado de outros testes). */
export function loadModule(name) {
  jest.resetModules();
  return import(`../../public/js/${name}`);
}
