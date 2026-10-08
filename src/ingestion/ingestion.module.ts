import { Module } from '@nestjs/common';
import { MeasurementsModule } from '../measurements/measurements.module';
import { IngestionBuffer } from './ingestion-buffer';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [MeasurementsModule],
  providers: [IngestionBuffer, IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
