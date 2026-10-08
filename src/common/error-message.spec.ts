import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('usa a mensagem do erro', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('não repete o código que já está na mensagem', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:502'), {
      code: 'ECONNREFUSED',
    });
    expect(errorMessage(err)).toBe('connect ECONNREFUSED 127.0.0.1:502');
  });

  it('usa o code quando a mensagem é vazia (ex: AggregateError do pg)', () => {
    const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    expect(errorMessage(err)).toBe('ECONNREFUSED');
  });

  it('aceita objetos que não são Error (ex: erros do modbus-serial)', () => {
    expect(
      errorMessage({ name: 'PortNotOpenError', message: 'Port Not Open', errno: 'ECONNREFUSED' }),
    ).toBe('Port Not Open (ECONNREFUSED)');
    expect(
      errorMessage({ modbusCode: 2, message: 'Illegal data address (Modbus exception 2)' }),
    ).toBe('Illegal data address (Modbus exception 2)');
  });

  it('usa o nome do erro como último recurso', () => {
    expect(errorMessage(new TypeError(''))).toBe('TypeError');
  });

  it('serializa objetos sem nenhum campo conhecido', () => {
    expect(errorMessage({ status: 500 })).toBe('{"status":500}');
  });

  it('aceita valores primitivos', () => {
    expect(errorMessage('texto')).toBe('texto');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});
