import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { MetricsCollectorService } from './metrics-collector.service';
import { MetricsController } from './metrics.controller';
import { RetentionService } from './retention.service';
import { StorageStatsService } from './storage-stats.service';

@Module({
  imports: [IngestionModule],
  controllers: [MetricsController],
  providers: [MetricsCollectorService, StorageStatsService, RetentionService],
  exports: [MetricsCollectorService],
})
export class MetricsModule {}
