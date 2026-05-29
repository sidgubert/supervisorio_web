import { MeasurementsService } from './measurements.service';
export declare class MeasurementsController {
    private readonly measurements;
    constructor(measurements: MeasurementsService);
    latest(tag: string, limit?: number): Promise<import("./measurement.entity").Measurement[]>;
}
