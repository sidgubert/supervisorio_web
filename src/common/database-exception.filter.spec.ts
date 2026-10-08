import { ArgumentsHost, HttpStatus, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { DatabaseExceptionFilter, statusFor } from './database-exception.filter';

describe('statusFor', () => {
  it.each([
    ['23505', HttpStatus.CONFLICT], // unique_violation
    ['23514', HttpStatus.BAD_REQUEST], // check_violation
    ['23502', HttpStatus.BAD_REQUEST], // not_null_violation
    ['22003', HttpStatus.BAD_REQUEST], // numeric_value_out_of_range
    ['08006', HttpStatus.INTERNAL_SERVER_ERROR], // connection_failure
    ['', HttpStatus.INTERNAL_SERVER_ERROR],
  ])('SQLSTATE %s -> HTTP %i', (code, status) => {
    expect(statusFor(code)).toBe(status);
  });
});

describe('DatabaseExceptionFilter', () => {
  beforeAll(() => Logger.overrideLogger(false));

  function run(code: string, message: string) {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;
    const err = new QueryFailedError('SELECT 1', [], Object.assign(new Error(message), { code }));
    new DatabaseExceptionFilter().catch(err, host);
    return { status, json };
  }

  it('responde 4xx com a mensagem do banco', () => {
    const { status, json } = run('23514', 'violates check constraint "chk_tags_alarm_order"');
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      statusCode: 400,
      message: 'violates check constraint "chk_tags_alarm_order"',
    });
  });

  it('em erro desconhecido responde 500 sem expor detalhes', () => {
    const { status, json } = run('XX000', 'detalhe interno');
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Internal server error' });
  });
});
