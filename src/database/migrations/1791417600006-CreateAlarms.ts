import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alarmes de processo (modelo simplificado da ISA-18.2).
 *
 * Cada linha de `alarms` é uma ocorrência: um limite (LL/L/H/HH) de uma tag
 * que foi violado. O estado sai dos carimbos de tempo:
 *   ativo        = cleared_at IS NULL
 *   reconhecido  = acked_at IS NOT NULL
 *   aberto       = ativo OU não reconhecido (o que o operador precisa ver)
 *
 * O id é gerado pela aplicação (UUID): o motor de alarmes funciona em memória
 * e grava as transições numa fila, mesmo com o banco temporariamente fora.
 *
 * Sem FK para tags: remover uma tag do cadastro preserva o histórico.
 *
 * `tags.alarm_deadband` é a banda morta (histerese), na unidade da tag: um
 * alarme alto só normaliza quando o valor cai abaixo de (limite - banda),
 * evitando que um valor oscilando em cima do limite gere uma rajada de alarmes.
 */
export class CreateAlarms1791417600006 implements MigrationInterface {
  name = 'CreateAlarms1791417600006';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE tags ADD COLUMN alarm_deadband DOUBLE PRECISION,
        ADD CONSTRAINT chk_tags_alarm_deadband CHECK (alarm_deadband >= 0)
    `);

    await q.query(`
      CREATE TABLE alarms (
        id             UUID PRIMARY KEY,
        tag            TEXT             NOT NULL,
        level          TEXT             NOT NULL CHECK (level IN ('LL', 'L', 'H', 'HH')),
        limit_value    DOUBLE PRECISION NOT NULL,
        raised_at      TIMESTAMPTZ      NOT NULL,
        raised_value   DOUBLE PRECISION NOT NULL,
        cleared_at     TIMESTAMPTZ,
        cleared_value  DOUBLE PRECISION,
        acked_at       TIMESTAMPTZ
      )
    `);
    // No máximo uma ocorrência ativa por tag e nível.
    await q.query(`
      CREATE UNIQUE INDEX uq_alarms_active ON alarms (tag, level) WHERE cleared_at IS NULL
    `);
    await q.query(`CREATE INDEX idx_alarms_raised_at ON alarms (raised_at DESC)`);
    await q.query(`CREATE INDEX idx_alarms_tag_raised_at ON alarms (tag, raised_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS alarms`);
    await q.query(`ALTER TABLE tags DROP COLUMN IF EXISTS alarm_deadband`);
  }
}
