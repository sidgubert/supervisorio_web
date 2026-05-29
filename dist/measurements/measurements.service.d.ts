import { Repository } from 'typeorm';
import { Measurement } from './measurement.entity';
export declare class MeasurementsService {
    private readonly repo;
    private readonly logger;
    constructor(repo: Repository<Measurement>);
    insertBatch(rows: Partial<Measurement>[]): Promise<number>;
    latest(tag: string, limit?: number): Promise<Measurement[]>;
}
