import { Module } from '@nestjs/common';
import { MeasurementsModule } from '../measurements/measurements.module';
import { IngestionBuffer } from './ingestion-buffer';
import { IngestionService } from './ingestion.service';
import { SourcesController } from './sources.controller';

@Module({
  imports: [MeasurementsModule],
  controllers: [SourcesController],
  providers: [IngestionBuffer, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
