/**
 * Contas do sinótico, sem DOM: conversão de coordenadas da tela para o
 * desenho (viewBox de 0 a 100), limites de posição, passo das setas e nível
 * de preenchimento dos instrumentos. Funções puras, testadas isoladamente.
 */

/**
 * Ponto da tela (clientX, clientY) na escala do desenho. `screenMatrix` é a
 * matriz do desenho para a tela (svg.getScreenCTM()); aplica-se a inversa.
 */
export function screenToDrawing(screenMatrix, clientX, clientY) {
  const m = screenMatrix.inverse();
  return {
    x: m.a * clientX + m.c * clientY + m.e,
    y: m.b * clientX + m.d * clientY + m.f,
  };
}

/**
 * Posição arredondada à grade de 1% (o cadastro guarda inteiros de 0 a 100) e
 * limitada para o desenho inteiro caber na área. `box` é a caixa do desenho,
 * com o rótulo, relativa ao seu centro ({ x, y, width, height }); sem ela,
 * só o centro fica limitado a 0–100.
 */
export function clampPosition(x, y, box) {
  return { x: clampAxis(x, box?.x, box?.width), y: clampAxis(y, box?.y, box?.height) };
}

function clampAxis(value, offset = 0, size = 0) {
  let min = Math.max(0, Math.ceil(-offset));
  let max = Math.min(100, Math.floor(100 - offset - size));
  if (min > max) [min, max] = [0, 100]; // desenho maior que a área
  return Math.min(max, Math.max(min, Math.round(value)));
}

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** Deslocamento de uma seta do teclado: 1% (5% com Shift); null para outras teclas. */
export function arrowStep(key, shift = false) {
  const direction = ARROWS[key];
  if (!direction) return null;
  const size = shift ? 5 : 1;
  return { dx: direction[0] * size, dy: direction[1] * size };
}

/**
 * Fração (0 a 1) do preenchimento de tanques e níveis: a posição do valor na
 * faixa de engenharia (engMin–engMax). Sem faixa válida, meio cheio.
 */
export function fillFraction(value, engMin, engMax) {
  const hasRange = typeof engMin === 'number' && typeof engMax === 'number' && engMax > engMin;
  if (!hasRange || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, (value - engMin) / (engMax - engMin)));
}
