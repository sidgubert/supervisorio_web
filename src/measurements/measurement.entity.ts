import { Entity, Column, PrimaryColumn } from 'typeorm';

/**
 * Uma amostra de uma tag. Schema nas migrations; (tag, time) é único
 * (índice uq_measurements_tag_time).
 */
@Entity('measurements')
export class Measurement {
  @PrimaryColumn({ type: 'timestamptz' })
  time!: Date;

  @PrimaryColumn({ type: 'text' })
  tag!: string;

  @Column({ type: 'double precision' })
  value!: number;

  @Column({ type: 'smallint', default: 192 })
  quality!: number;

  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** Quando o servidor recebeu a amostra (nulo nas anteriores à migration ReceivedAt). */
  @Column({ name: 'received_at', type: 'timestamptz', nullable: true })
  receivedAt!: Date | null;
}
