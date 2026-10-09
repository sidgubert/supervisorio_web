import {
  arrowStep,
  clampPosition,
  fillFraction,
  screenToDrawing,
} from '../../public/js/synoptic-geometry.js';

/** Matriz desenho → tela: escala `s` e deslocamento (e, f), como getScreenCTM(). */
function screenMatrix(s, e, f) {
  return {
    inverse: () => ({ a: 1 / s, b: 0, c: 0, d: 1 / s, e: -e / s, f: -f / s }),
  };
}

describe('screenToDrawing', () => {
  it.each([
    [300, 150, 0, 0],
    [750, 600, 50, 50],
    [1200, 1050, 100, 100],
  ])('tela (%i, %i) → desenho (%i, %i)', (clientX, clientY, x, y) => {
    // Desenho de 0–100 ocupando 900 px a partir de (300, 150).
    const p = screenToDrawing(screenMatrix(9, 300, 150), clientX, clientY);
    expect(p.x).toBeCloseTo(x, 9);
    expect(p.y).toBeCloseTo(y, 9);
  });
});

describe('clampPosition', () => {
  it('arredonda para a grade de 1%', () => {
    expect(clampPosition(20.4, 35.6)).toEqual({ x: 20, y: 36 });
  });

  it('sem medida do desenho, limita o centro a 0–100', () => {
    expect(clampPosition(-12, 140)).toEqual({ x: 0, y: 100 });
  });

  it('com a medida, mantém o desenho inteiro (e o rótulo) dentro da área', () => {
    // Desenho de 16 × 20, com o centro em (8, 12) da sua caixa.
    const box = { x: -8, y: -12, width: 16, height: 20 };
    expect(clampPosition(0, 0, box)).toEqual({ x: 8, y: 12 });
    expect(clampPosition(100, 100, box)).toEqual({ x: 92, y: 92 });
    expect(clampPosition(50, 50, box)).toEqual({ x: 50, y: 50 });
  });

  it('desenho maior que a área volta ao limite simples de 0–100', () => {
    const huge = { x: -60, y: -60, width: 120, height: 120 };
    expect(clampPosition(130, -5, huge)).toEqual({ x: 100, y: 0 });
  });
});

describe('arrowStep', () => {
  it.each([
    ['ArrowLeft', false, { dx: -1, dy: 0 }],
    ['ArrowRight', false, { dx: 1, dy: 0 }],
    ['ArrowUp', true, { dx: 0, dy: -5 }],
    ['ArrowDown', true, { dx: 0, dy: 5 }],
  ])('%s (Shift: %s)', (key, shift, step) => {
    expect(arrowStep(key, shift)).toEqual(step);
  });

  it('outras teclas não movem', () => {
    expect(arrowStep('Enter')).toBeNull();
    expect(arrowStep('a', true)).toBeNull();
  });
});

describe('fillFraction', () => {
  it('é a posição do valor na faixa de engenharia', () => {
    expect(fillFraction(75, 50, 100)).toBe(0.5);
    expect(fillFraction(50, 50, 100)).toBe(0);
  });

  it('fica entre 0 e 1 fora da faixa', () => {
    expect(fillFraction(120, 50, 100)).toBe(1);
    expect(fillFraction(10, 50, 100)).toBe(0);
  });

  it('sem faixa válida (ou sem valor), meio cheio', () => {
    expect(fillFraction(75, null, 100)).toBe(0.5);
    expect(fillFraction(75, undefined, undefined)).toBe(0.5);
    expect(fillFraction(75, 100, 50)).toBe(0.5);
    expect(fillFraction(NaN, 0, 100)).toBe(0.5);
  });
});
