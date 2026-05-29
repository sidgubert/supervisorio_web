import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MeasurementsService } from '../measurements/measurements.service';
export declare class SimulatorService implements OnModuleInit, OnModuleDestroy {
    private readonly config;
    private readonly measurements;
    private readonly logger;
    private buffer;
    private genTimer?;
    private flushTimer?;
    constructor(config: ConfigService, measurements: MeasurementsService);
    onModuleInit(): void;
    onModuleDestroy(): void;
    private generate;
    private flush;
}
