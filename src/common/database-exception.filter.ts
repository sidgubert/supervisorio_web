import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * Traduz erros de dados do PostgreSQL em respostas HTTP 4xx, em vez de 500.
 * As validações da API devem pegar esses casos antes; isto é a última linha
 * de defesa (ex: CHECK da tabela, corrida entre dois cadastros iguais).
 */
@Catch(QueryFailedError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DatabaseExceptionFilter.name);

  catch(err: QueryFailedError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const code = (err.driverError as { code?: string } | undefined)?.code ?? '';
    const status = statusFor(code);
    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`Erro de banco não tratado (${code}): ${err.message}`);
      res.status(status).json({ statusCode: status, message: 'Internal server error' });
      return;
    }
    res.status(status).json({ statusCode: status, message: err.message });
  }
}

/** SQLSTATE -> HTTP. https://www.postgresql.org/docs/current/errcodes-appendix.html */
export function statusFor(sqlstate: string): HttpStatus {
  if (sqlstate === '23505') return HttpStatus.CONFLICT; // unique_violation
  if (sqlstate.startsWith('23')) return HttpStatus.BAD_REQUEST; // check, not null...
  if (sqlstate.startsWith('22')) return HttpStatus.BAD_REQUEST; // data exception
  return HttpStatus.INTERNAL_SERVER_ERROR;
}
