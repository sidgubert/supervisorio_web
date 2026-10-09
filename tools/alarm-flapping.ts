/**
 * Oscilação de alarmes e banda morta (npm run bench:alarms).
 *
 *   npm run bench:alarms -- [--hours=24] [--limit=140] [--sample-ms=1000] [--out=...]
 *
 * Passa --hours do sinal simulado de vazão (FIC-301.PV: 120 ± 25 m³/h,
 * período de 45 s, ruído de ±1,5), amostrado a cada --sample-ms, pelas mesmas regras
 * do motor de alarmes (alarm-rules.ts), com um limite alto (--limit) e
 * bandas mortas de 0% a 5% do limite. Conta quantas vezes o alarme ativa e
 * quantos episódios de "chattering" acontecem (pela ISA-18.2: 3 ou mais
 * ativações do mesmo alarme em 60 s).
 *
 * O sinal ultrapassa o limite uma vez por ciclo: o ideal é uma ativação por
 * ciclo. Sem banda morta, o ruído em volta do limite gera ativações extras,
 * tanto mais quanto mais rápida a amostragem (entre duas amostras, o sinal
 * anda menos que a amplitude do ruído).
 * Roda sem banco nem API, e o resultado é sempre o mesmo (ruído determinístico).
 */
import { AlarmLevel, evaluate } from '../src/alarms/alarm-rules';
import { DEFAULT_SIGNALS, sampleSignal } from '../src/sources/simulator/signal';
import { cliOptions, fmt, numberOption, saveJson, table } from './lib/common';

const FLOW = DEFAULT_SIGNALS.find((s) => s.tag === 'FIC-301.PV')!;
/** Início fixo: o mesmo trecho do sinal a cada execução. */
const START = Date.parse('2026-01-01T00:00:00Z');

function run(hours: number, limit: number, bandPct: number, sampleMs: number) {
  const active = new Set<AlarmLevel>();
  const raises: number[] = [];
  for (let t = START; t < START + hours * 3_600_000; t += sampleMs) {
    const value = sampleSignal(FLOW, t);
    const { raise, clear } = evaluate({ alarmH: limit }, active, value, bandPct);
    for (const r of raise) {
      active.add(r.level);
      raises.push(t);
    }
    for (const c of clear) active.delete(c);
  }
  // Chattering: janelas de 60 s com 3+ ativações (cada episódio contado uma vez).
  let chattering = 0;
  for (let i = 0; i + 2 < raises.length;) {
    if (raises[i + 2] - raises[i] <= 60_000) {
      chattering++;
      const windowEnd = raises[i] + 60_000;
      while (i < raises.length && raises[i] <= windowEnd) i++;
    } else i++;
  }
  return { raises: raises.length, chattering };
}

function main() {
  const opts = cliOptions();
  const hours = numberOption(opts, 'hours', 24);
  const limit = numberOption(opts, 'limit', 140);
  const sampleMs = numberOption(opts, 'sample-ms', 1000);
  const cycles = (hours * 3600) / FLOW.periodSec;

  console.log(
    `${FLOW.tag}: ${FLOW.mean} ± ${FLOW.amplitude}, período ${FLOW.periodSec} s, ruído ±${FLOW.noise}; ` +
      `limite H = ${limit}; ${hours} h, uma amostra a cada ${sampleMs} ms (${fmt(cycles, 0)} ciclos)\n`,
  );
  const results = [0, 0.5, 1, 2, 5].map((bandPct) => {
    const r = run(hours, limit, bandPct, sampleMs);
    return { bandPct, band: (bandPct / 100) * limit, ...r, perCycle: r.raises / cycles };
  });
  console.log(
    table(
      [
        'Banda morta',
        'Banda (m³/h)',
        'Ativações',
        'Ativações por ciclo',
        'Episódios de chattering',
      ],
      results.map((r) => [
        `${fmt(r.bandPct, 1)}%`,
        fmt(r.band, 2),
        r.raises.toLocaleString('pt-BR'),
        fmt(r.perCycle, 2),
        r.chattering.toLocaleString('pt-BR'),
      ]),
    ),
  );
  saveJson(opts.out, { tag: FLOW.tag, hours, limit, sampleMs, cycles, results });
}

main();
