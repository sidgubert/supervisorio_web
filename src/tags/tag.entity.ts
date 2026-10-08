import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Cadastro de uma variável de processo. Schema em migrations/*-CreateTags.ts. */
@Entity('tags')
export class Tag {
  @PrimaryColumn({ type: 'text' })
  tag!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Unidade de engenharia (°C, bar, m³/h, %...) */
  @Column({ type: 'text', nullable: true })
  unit!: string | null;

  /** Faixa de engenharia: limites físicos do instrumento. */
  @Column({ name: 'eng_min', type: 'double precision', nullable: true })
  engMin!: number | null;

  @Column({ name: 'eng_max', type: 'double precision', nullable: true })
  engMax!: number | null;

  /** Limites de alarme: muito baixo, baixo, alto, muito alto. */
  @Column({ name: 'alarm_ll', type: 'double precision', nullable: true })
  alarmLL!: number | null;

  @Column({ name: 'alarm_l', type: 'double precision', nullable: true })
  alarmL!: number | null;

  @Column({ name: 'alarm_h', type: 'double precision', nullable: true })
  alarmH!: number | null;

  @Column({ name: 'alarm_hh', type: 'double precision', nullable: true })
  alarmHH!: number | null;

  /** Banda morta (histerese) dos alarmes, na unidade da tag. */
  @Column({ name: 'alarm_deadband', type: 'double precision', nullable: true })
  alarmDeadband!: number | null;

  /** Fonte de aquisição esperada: sim | mqtt | modbus | opcua */
  @Column({ type: 'text', nullable: true })
  source!: string | null;

  /** Endereço no protocolo: tópico MQTT, registro Modbus, NodeId OPC UA. */
  @Column({ type: 'text', nullable: true })
  address!: string | null;

  @Column({ type: 'boolean', default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
