import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Measurement } from './measurement.entity';

/**
 * Linhas por INSERT. O PostgreSQL aceita no máximo 65.535 parâmetros por
 * comando; com 5 colunas, 1000 linhas = 5000 parâmetros, bem abaixo do limite.
 */
const INSERT_CHUNK_SIZE = 1000;

@Injectable()
export class MeasurementsService {
  constructor(
    @InjectRepository(Measurement)
    private readonly repo: Repository<Measurement>,
  ) {}

  /**
   * Inserção em lote. Em séries temporais é muito mais eficiente
   * gravar N amostras de uma vez do que uma a uma.
   *
   * Lotes grandes são divididos em blocos de INSERT_CHUNK_SIZE dentro de
   * uma única transação: ou grava tudo, ou nada (evita duplicatas quando
   * quem chamou tenta de novo após uma falha).
   */
  async insertBatch(rows: Partial<Measurement>[]): Promise<number> {
    if (rows.length === 0) return 0;
    await this.repo.manager.transaction(async (em) => {
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        await em.insert(Measurement, rows.slice(i, i + INSERT_CHUNK_SIZE));
      }
    });
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
