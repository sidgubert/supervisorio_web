import { Module } from '@nestjs/common';
import { IngestionModule } from '../../ingestion/ingestion.module';
import { TagsModule } from '../../tags/tags.module';
import { ModbusSource } from './modbus.source';

@Module({
  imports: [IngestionModule, TagsModule],
  providers: [ModbusSource],
})
export class ModbusModule {}
