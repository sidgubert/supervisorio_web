import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema inicial de séries temporais (antes em db/init.sql).
 *
 * Idempotente (IF NOT EXISTS / if_not_exists): num banco já criado pelo antigo
 * init.sql, apenas registra a migration, sem alterar nada.
 */
export class InitialSchema1791417600000 implements MigrationInterface {
  name = 'InitialSchema1791417600000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS timescaledb`);

    // Modelo "narrow/long": uma linha por amostra de cada tag. Adicionar tags
    // não exige alterar o schema.
    await q.query(`
      CREATE TABLE IF NOT EXISTS measurements (
        time     TIMESTAMPTZ      NOT NULL,
        tag      TEXT             NOT NULL,             -- ex: "TIC-101.PV"
        value    DOUBLE PRECISION NOT NULL,
        quality  SMALLINT         NOT NULL DEFAULT 192, -- 192 = Good (OPC DA)
        source   TEXT                                   -- sim|mqtt|modbus|opcua
      )
    `);

    // Hypertable particionada por tempo: é o que dá ao TimescaleDB o
    // desempenho de escrita/leitura em séries temporais.
    await q.query(`SELECT create_hypertable('measurements', 'time', if_not_exists => TRUE)`);

    // Consulta mais comum do dashboard: "valores da tag X nos últimos N minutos".
    await q.query(`
      CREATE INDEX IF NOT EXISTS idx_measurements_tag_time
        ON measurements (tag, time DESC)
    `);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS measurements`);
  }
}
