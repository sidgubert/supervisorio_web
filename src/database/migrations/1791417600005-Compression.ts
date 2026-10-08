import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compressão nativa do TimescaleDB para o histórico bruto.
 *
 * Chunks com mais de 7 dias são convertidos para o formato colunar, agrupados
 * por tag (segmentby) e ordenados por tempo: séries de sensores costumam
 * reduzir mais de 90% do espaço, e consultas por tag/período continuam
 * funcionando normalmente.
 *
 * 7 dias fica bem acima da janela em que amostras atrasadas ainda são aceitas
 * (1 dia, ver IngestionService), então a ingestão praticamente nunca escreve
 * em chunks comprimidos.
 *
 * Retenção (apagar dados antigos) fica desligada de propósito: o histórico
 * completo interessa ao projeto. Para ligar:
 *   SELECT add_retention_policy('measurements', INTERVAL '1 year');
 */
export class Compression1791417600005 implements MigrationInterface {
  name = 'Compression1791417600005';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE measurements SET (
        timescaledb.compress,
        timescaledb.compress_segmentby = 'tag',
        timescaledb.compress_orderby = 'time DESC'
      )
    `);
    await q.query(
      `SELECT add_compression_policy('measurements', INTERVAL '7 days', if_not_exists => TRUE)`,
    );
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`SELECT remove_compression_policy('measurements', if_exists => TRUE)`);
    await q.query(`
      SELECT decompress_chunk(c, if_compressed => TRUE)
      FROM show_chunks('measurements') c
    `);
    await q.query(`ALTER TABLE measurements SET (timescaledb.compress = false)`);
  }
}
