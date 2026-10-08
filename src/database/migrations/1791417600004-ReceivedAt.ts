import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Segundo carimbo de tempo: quando o servidor recebeu a amostra.
 *
 * `time` é o instante da medição informado pela fonte (relógio do CLP, do
 * dispositivo MQTT, sourceTimestamp do OPC UA) ou, se a fonte não informar,
 * o próprio instante de recebimento. Guardar os dois permite medir a latência
 * de aquisição (received_at - time) e detectar relógios de campo dessincronizados.
 *
 * Nulo nas amostras gravadas antes desta migration.
 */
export class ReceivedAt1791417600004 implements MigrationInterface {
  name = 'ReceivedAt1791417600004';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE measurements ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE measurements DROP COLUMN IF EXISTS received_at`);
  }
}
