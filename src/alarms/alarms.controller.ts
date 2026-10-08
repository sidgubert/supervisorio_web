import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { AlarmsService } from './alarms.service';

const DAY = 24 * 60 * 60_000;
const MAX_LIMIT = 1000;

@Controller('alarms')
export class AlarmsController {
  constructor(private readonly alarms: AlarmsService) {}

  /** Alarmes abertos (ativos ou não reconhecidos), mais graves primeiro. */
  @Get()
  list() {
    return this.alarms.list();
  }

  /**
   * Histórico: ?from=&to= (ISO 8601; padrão últimas 24 h), ?tag=, ?limit=
   * (1–1000, padrão 200).
   */
  @Get('history')
  history(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('tag') tag?: string,
    @Query('limit') limit?: string,
  ) {
    const toDate = parseDate('to', to) ?? new Date();
    const fromDate = parseDate('from', from) ?? new Date(toDate.getTime() - DAY);
    if (fromDate >= toDate) throw new BadRequestException('from deve ser anterior a to');
    const n = limit === undefined ? 200 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
      throw new BadRequestException(`limit deve estar entre 1 e ${MAX_LIMIT}`);
    }
    return this.alarms.history({ from: fromDate, to: toDate, tag, limit: n });
  }

  /** Reconhece um alarme (404 se não estiver aberto). */
  @Post(':id/ack')
  @HttpCode(200)
  ack(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.alarms.ack(id);
  }

  /** Reconhece todos os alarmes abertos. */
  @Post('ack-all')
  @HttpCode(200)
  ackAll() {
    return { acknowledged: this.alarms.ackAll() };
  }
}

function parseDate(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException(`${name} deve ser uma data ISO 8601`);
  }
  return d;
}
