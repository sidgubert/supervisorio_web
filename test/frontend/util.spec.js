import { apiError, esc, fmtDuration, fmtNum } from '../../public/js/util.js';
import { response } from './helpers.js';

describe('esc', () => {
  it('neutraliza HTML vindo da API (XSS armazenado)', () => {
    expect(esc('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    );
    expect(esc("a & b's")).toBe('a &amp; b&#39;s');
  });

  it('trata nulo e números', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
    expect(esc(42)).toBe('42');
  });
});

describe('fmtNum', () => {
  it('usa o formato brasileiro e limita as casas', () => {
    expect(fmtNum(1234.5678)).toBe('1.234,568');
    expect(fmtNum(1234.5678, 1)).toBe('1.234,6');
    expect(fmtNum(0)).toBe('0');
  });

  it('mostra travessão sem valor', () => {
    expect(fmtNum(null)).toBe('—');
    expect(fmtNum(undefined)).toBe('—');
    expect(fmtNum('')).toBe('—');
  });
});

describe('fmtDuration', () => {
  it.each([
    [42, '42 s'],
    [125, '2 min 5 s'],
    [3 * 3600 + 7 * 60 + 9, '3 h 7 min'],
  ])('%i s → %s', (seconds, text) => {
    expect(fmtDuration(seconds)).toBe(text);
  });
});

describe('apiError', () => {
  it('junta a lista de erros de validação', async () => {
    const res = response({ message: ['alarmH inválido', 'engMin inválido'] }, 400);
    await expect(apiError(res)).resolves.toBe('alarmH inválido; engMin inválido');
  });

  it('usa a mensagem única ou o status', async () => {
    await expect(apiError(response({ message: 'Tag não encontrada' }, 404))).resolves.toBe(
      'Tag não encontrada',
    );
    await expect(apiError(response({}, 503))).resolves.toBe('503');
  });

  it('resposta sem JSON vira "erro <status>"', async () => {
    const res = { status: 502, json: () => Promise.reject(new SyntaxError('não é JSON')) };
    await expect(apiError(res)).resolves.toBe('erro 502');
  });
});
