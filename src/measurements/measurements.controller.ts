import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
import { HistoryQueryError, parseHistoryQuery } from './history-query';
import { MeasurementsService } from './measurements.service';

/** Teto de amostras por consulta, para proteger o banco e a API. */
const MAX_LIMIT = 5000;

@Controller('measurements')
export class MeasurementsController {
  constructor(private readonly measurements: MeasurementsService) {}

  /** Últimas amostras de uma tag (ex: TIC-101.PV). */
  @Get(':tag/latest')
  latest(
    @Param('tag') tag: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ) {
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`limit deve estar entre 1 e ${MAX_LIMIT}`);
    }
    return this.measurements.latest(tag, limit);
  }

  /**
   * Série histórica para gráficos: ?from=&to= (ISO 8601; padrão: última hora)
   * e ?bucket=auto|raw|1m|1h (padrão auto: escolhe a resolução pelo período).
   */
  @Get(':tag/history')
  async history(
    @Param('tag') tag: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('bucket') bucket?: string,
    @Query('minutes') minutes?: string,
  ) {
    let q;
    try {
      q = parseHistoryQuery({ from, to, bucket, minutes }, new Date());
    } catch (err) {
      if (err instanceof HistoryQueryError) throw new BadRequestException(err.message);
      throw err;
    }
    const points = await this.measurements.history(tag, q);
    return { tag, bucket: q.bucket, from: q.from, to: q.to, points };
  }
}
