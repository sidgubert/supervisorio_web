import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Measurement } from './measurement.entity';

@Injectable()
export class MeasurementsService {
  private readonly logger = new Logger(MeasurementsService.name);

  constructor(
    @InjectRepository(Measurement)
    private readonly repo: Repository<Measurement>,
  ) {}

  /**
   * Inserção em lote. Em séries temporais é muito mais eficiente
   * gravar N amostras de uma vez do que uma a uma.
   */
  async insertBatch(rows: Partial<Measurement>[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.repo.insert(rows);
    return rows.length;
  }

  /** Últimas N amostras de uma tag (usado mais tarde pelo dashboard). */
  async latest(tag: string, limit = 100): Promise<Measurement[]> {
    return this.repo.find({
      where: { tag },
      order: { time: 'DESC' },
      take: limit,
    });
  }
}
