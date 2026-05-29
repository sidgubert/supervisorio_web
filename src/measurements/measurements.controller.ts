import { Controller, Get, Param, ParseIntPipe, Query } from '@nestjs/common';
import { MeasurementsService } from './measurements.service';

@Controller('measurements')
export class MeasurementsController {
  constructor(private readonly measurements: MeasurementsService) {}

  /** Últimas amostras de uma tag (ex: TIC-101.PV). */
  @Get(':tag/latest')
  latest(
    @Param('tag') tag: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.measurements.latest(tag, limit ?? 100);
  }
}
