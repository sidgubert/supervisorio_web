/**
 * Geração de sinais sintéticos para o "Teste de Carga Simulado" (Fase 1).
 *
 * A lógica é mantida em funções puras (sem dependência de banco ou NestJS)
 * justamente para ser testável de forma isolada e reaproveitável.
 */

import { SampleInput } from '../../ingestion/sample';

export interface SignalSpec {
  /** Nome da tag, ex: "TIC-101.PV" */
  tag: string;
  /** Valor de base (offset) do sinal */
  mean: number;
  /** Amplitude do pico da senoide */
  amplitude: number;
  /** Período da senoide, em segundos */
  periodSec: number;
  /** Amplitude do ruído (+/-), simula variação de processo */
  noise: number;
  /** Unidade de engenharia, apenas informativa */
  unit?: string;
}

/**
 * Calcula o valor de um sinal num dado instante (ms desde epoch).
 *
 *   value(t) = mean + amplitude * sin(2*pi*t / periodo) + noise * ruido(tag, t)
 *
 * Usar o tempo absoluto (epoch) como fase garante que sinais com
 * períodos diferentes fiquem naturalmente defasados entre si. O ruído também
 * só depende da tag e do instante (ver noiseAt): a função é pura, duas
 * instâncias geram o mesmo valor para o mesmo instante, e qualquer amostra
 * gravada pode ser conferida recalculando o sinal (npm run sim:verify).
 */
export function sampleSignal(spec: SignalSpec, atMs: number): number {
  const omega = (2 * Math.PI) / (spec.periodSec * 1000);
  const base = spec.mean + spec.amplitude * Math.sin(omega * atMs);
  const noise = noiseAt(spec.tag, atMs) * spec.noise;
  return Number((base + noise).toFixed(3));
}

/**
 * Ruído pseudoaleatório em [-1, 1), determinístico: a mesma tag no mesmo
 * instante dá sempre o mesmo número. É o hash FNV-1a da tag misturado ao
 * instante e embaralhado pelo finalizador do MurmurHash3, cuja saída é
 * praticamente uniforme mesmo para instantes vizinhos.
 */
export function noiseAt(tag: string, atMs: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193);
  // O instante (até 2^53 ms) entra em duas metades de 32 bits.
  h = fmix32(h ^ atMs);
  h = fmix32(h ^ Math.floor(atMs / 2 ** 32));
  return (h / 2 ** 32) * 2 - 1;
}

function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
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

/** Tags geradas para teste de carga: SIM-0005.PV, SIM-0006.PV... */
const GENERATED_TAG = /^SIM-(\d{4,})\.PV$/;

/**
 * Sinal da n-ésima tag gerada (n > 4). Parâmetros variados, mas fixos por n:
 * a mesma tag gera sempre o mesmo sinal, em qualquer execução.
 */
export function generatedSignal(n: number): SignalSpec {
  return {
    tag: `SIM-${String(n).padStart(4, '0')}.PV`,
    mean: 50 + (n % 10) * 10,
    amplitude: 5 + (n % 7),
    periodSec: 30 + ((n * 37) % 270),
    noise: 0.5,
  };
}

/**
 * Tags do simulador (SIM_TAGS): as de DEFAULT_SIGNALS e, acima disso, tags
 * geradas para teste de carga. As geradas não estão no cadastro: são
 * gravadas no banco, mas não aparecem no dashboard nem geram alarmes.
 */
export function simulatorSignals(count: number): SignalSpec[] {
  const signals = DEFAULT_SIGNALS.slice(0, count);
  for (let n = DEFAULT_SIGNALS.length + 1; n <= count; n++) signals.push(generatedSignal(n));
  return signals;
}

/** Sinal de uma tag do simulador pelo nome (para conferir dados gravados). */
export function findSignal(tag: string): SignalSpec | undefined {
  const known = DEFAULT_SIGNALS.find((s) => s.tag === tag);
  if (known) return known;
  const match = GENERATED_TAG.exec(tag);
  if (!match) return undefined;
  const spec = generatedSignal(Number(match[1]));
  return spec.tag === tag && Number(match[1]) > DEFAULT_SIGNALS.length ? spec : undefined;
}
