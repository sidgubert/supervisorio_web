/**
 * Geração de sinais sintéticos para o "Teste de Carga Simulado" (Fase 1).
 *
 * A lógica é mantida em funções puras (sem dependência de banco ou NestJS)
 * justamente para ser testável de forma isolada e reaproveitável.
 */

import { SampleInput } from '../ingestion/sample';

export interface SignalSpec {
  /** Nome da tag, ex: "TIC-101.PV" */
  tag: string;
  /** Valor de base (offset) do sinal */
  mean: number;
  /** Amplitude do pico da senoide */
  amplitude: number;
  /** Período da senoide, em segundos */
  periodSec: number;
  /** Amplitude do ruído aleatório (+/-), simula variação de processo */
  noise: number;
  /** Unidade de engenharia, apenas informativa */
  unit?: string;
}

/**
 * Calcula o valor de um sinal num dado instante (ms desde epoch).
 *
 *   value(t) = mean + amplitude * sin(2*pi*t / periodo) + ruido
 *
 * Usar o tempo absoluto (epoch) como fase garante que sinais com
 * períodos diferentes fiquem naturalmente defasados entre si.
 */
export function sampleSignal(spec: SignalSpec, atMs: number): number {
  const omega = (2 * Math.PI) / (spec.periodSec * 1000);
  const base = spec.mean + spec.amplitude * Math.sin(omega * atMs);
  const noise = (Math.random() * 2 - 1) * spec.noise;
  return Number((base + noise).toFixed(3));
}

/**
 * Gera uma amostra de uma tag. Qualidade e origem são preenchidas pelo
 * núcleo de ingestão (Good e "sim").
 */
export function generateSample(spec: SignalSpec, at: Date = new Date()): SampleInput {
  return { time: at, tag: spec.tag, value: sampleSignal(spec, at.getTime()) };
}

/**
 * Conjunto de tags padrão simulando um pequeno processo industrial.
 * Serve de carga de teste e como dado de demonstração para o dashboard.
 */
export const DEFAULT_SIGNALS: SignalSpec[] = [
  { tag: 'TIC-101.PV', mean: 75, amplitude: 8, periodSec: 60, noise: 0.4, unit: '°C' },
  { tag: 'PIC-201.PV', mean: 4.2, amplitude: 0.6, periodSec: 90, noise: 0.05, unit: 'bar' },
  { tag: 'FIC-301.PV', mean: 120, amplitude: 25, periodSec: 45, noise: 1.5, unit: 'm³/h' },
  { tag: 'LIC-401.PV', mean: 60, amplitude: 15, periodSec: 120, noise: 0.8, unit: '%' },
];
