import { Module } from '@nestjs/common';
import { MeasurementsModule } from '../measurements/measurements.module';
import { SimulatorService } from './simulator.service';

@Module({
  imports: [MeasurementsModule],
  providers: [SimulatorService],
})
export class SimulatorModule {}
