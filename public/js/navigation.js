/**
 * Troca de página (login, dashboard). Fica num módulo só para os testes
 * poderem substituí-la: o jsdom não implementa a navegação do navegador.
 */
export function goTo(url) {
  window.location.assign(url);
}
