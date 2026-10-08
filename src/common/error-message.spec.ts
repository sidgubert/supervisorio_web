import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('usa a mensagem do erro', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('usa o code quando a mensagem é vazia (ex: AggregateError do pg)', () => {
    const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(errorMessage(err)).toBe('ECONNREFUSED');
  });

  it('usa o nome do erro como último recurso', () => {
    expect(errorMessage(new TypeError(''))).toBe('TypeError');
  });

  it('aceita valores que não são Error', () => {
    expect(errorMessage('texto')).toBe('texto');
  });
});
