import { Module } from '@nestjs/common';
import { IngestionModule } from '../ingestion/ingestion.module';
import { SimulatorSource } from './simulator.source';

@Module({
  imports: [IngestionModule],
  providers: [SimulatorSource],
})
export class SimulatorModule {}
