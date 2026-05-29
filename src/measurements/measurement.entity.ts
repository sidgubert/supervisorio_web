import { Entity, Column, PrimaryColumn } from 'typeorm';

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
  source?: string;
}
