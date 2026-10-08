import {
  BadRequestException,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Query,
} from '@nestjs/common';
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
}
