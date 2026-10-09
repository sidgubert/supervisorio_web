/**
 * Preparação dos testes do frontend (jsdom): matchers do jest-dom
 * (toBeVisible, toHaveAttribute...) e as APIs de navegador que o jsdom não
 * implementa e o dashboard usa. Os complementos são mínimos e só entram se a
 * API não existir.
 */
import '@testing-library/jest-dom';

// PointerEvent (arraste no sinótico): o jsdom só tem MouseEvent.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEvent extends MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  window.PointerEvent = PointerEvent;
}

// Captura do ponteiro: registra quem capturou, como o navegador.
const captured = new WeakMap();
Element.prototype.setPointerCapture ??= function (id) {
  captured.set(this, id);
};
Element.prototype.releasePointerCapture ??= function () {
  captured.delete(this);
};
Element.prototype.hasPointerCapture ??= function (id) {
  return captured.get(this) === id;
};

// Geometria de SVG: o jsdom não faz layout. Sem medida, o sinótico só limita
// o centro do instrumento; os testes que precisam de medidas as definem.
SVGElement.prototype.getBBox ??= () => ({ x: 0, y: 0, width: 0, height: 0 });

afterEach(() => {
  jest.restoreAllMocks();
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.location.hash = '';
});
