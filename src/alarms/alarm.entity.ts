import { Column, Entity, PrimaryColumn } from 'typeorm';
import { AlarmLevel } from './alarm-rules';

/** Uma ocorrência de alarme. Schema na migration CreateAlarms. */
@Entity('alarms')
export class Alarm {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'text' })
  tag!: string;

  @Column({ type: 'text' })
  level!: AlarmLevel;

  /** Limite violado, no momento em que o alarme ativou. */
  @Column({ name: 'limit_value', type: 'double precision' })
  limitValue!: number;

  @Column({ name: 'raised_at', type: 'timestamptz' })
  raisedAt!: Date;

  @Column({ name: 'raised_value', type: 'double precision' })
  raisedValue!: number;

  /** Quando o valor voltou ao normal (null = ainda ativo). */
  @Column({ name: 'cleared_at', type: 'timestamptz', nullable: true })
  clearedAt!: Date | null;

  @Column({ name: 'cleared_value', type: 'double precision', nullable: true })
  clearedValue!: number | null;

  /** Quando o operador reconheceu (null = não reconhecido). */
  @Column({ name: 'acked_at', type: 'timestamptz', nullable: true })
  ackedAt!: Date | null;

  /** Quem reconheceu (usuário autenticado, ou o informado sem autenticação). */
  @Column({ name: 'acked_by', type: 'text', nullable: true })
  ackedBy!: string | null;
}
