/**
 * Confere as amostras do simulador gravadas no banco (npm run sim:verify).
 *
 *   npm run sim:verify -- [--minutes=10] [--interval=1000] [--out=resultados/verify.json]
 *
 * Como o sinal do simulador é uma função pura da tag e do instante
 * (sampleSignal, com ruído determinístico), cada valor gravado pode ser
 * recalculado e comparado: qualquer divergência indica dado corrompido no
 * caminho. Também procura lacunas: intervalos entre amostras seguidas de uma
 * tag maiores que 1,5 × o intervalo do simulador (SIM_INTERVAL_MS do .env, ou
 * --interval). Sem lacunas, nenhuma amostra se perdeu, mesmo que o banco
 * tenha caído no meio (o buffer da ingestão grava depois).
 *
 * Amostras gravadas por versões anteriores (ruído aleatório) não conferem:
 * use uma janela (--minutes) posterior à atualização.
 */
import { findSignal, sampleSignal } from '../src/sources/simulator/signal';
import { cliOptions, connectDb, fmt, loadEnv, numberOption, saveJson, table } from './lib/common';

/** Consulta em janelas de 1 min, para não carregar tudo na memória. */
const WINDOW_MS = 60_000;
/** Ignora os últimos segundos, que ainda podem estar no buffer da ingestão. */
const SETTLE_MS = 5_000;

async function main() {
  const opts = cliOptions();
  const env = loadEnv();
  const minutes = numberOption(opts, 'minutes', 10);
  const interval = numberOption(opts, 'interval', env.SIM_INTERVAL_MS);
  const ds = await connectDb(env);

  const to = Date.now() - SETTLE_MS;
  const from = to - minutes * 60_000;
  let checked = 0;
  let mismatches = 0;
  const examples: string[] = [];
  const unknownTags = new Set<string>();
  const last = new Map<string, number>();
  const perTag = new Map<string, number>();
  let gaps = 0;
  let missing = 0;
  let largestGapMs = 0;

  for (let start = from; start < to; start += WINDOW_MS) {
    const end = Math.min(start + WINDOW_MS, to);
    const rows = await ds.query<{ tag: string; time: Date; value: number }[]>(
      `SELECT tag, time, value FROM measurements
        WHERE source = 'sim' AND time >= $1 AND time < $2
        ORDER BY time, tag`,
      [new Date(start), new Date(end)],
    );

    for (const row of rows) {
      const spec = findSignal(row.tag);
      if (!spec) {
        unknownTags.add(row.tag);
        continue;
      }
      const t = row.time.getTime();
      checked++;
      perTag.set(row.tag, (perTag.get(row.tag) ?? 0) + 1);
      const expected = sampleSignal(spec, t);
      if (expected !== row.value) {
        mismatches++;
        if (examples.length < 5) {
          examples.push(
            `${row.tag} ${row.time.toISOString()}: gravado ${row.value}, esperado ${expected}`,
          );
        }
      }
      const previous = last.get(row.tag);
      if (previous !== undefined && t - previous > 1.5 * interval) {
        gaps++;
        missing += Math.round((t - previous) / interval) - 1;
        largestGapMs = Math.max(largestGapMs, t - previous);
      }
      last.set(row.tag, t);
    }
  }
  await ds.destroy();

  const tags = perTag.size;
  const expectedPerTag = (minutes * 60_000) / interval;
  const coverage = tags === 0 ? 0 : checked / (tags * expectedPerTag);
  console.log(
    `Janela: ${new Date(from).toISOString()} a ${new Date(to).toISOString()} ` +
      `(${minutes} min), intervalo de ${interval} ms\n`,
  );
  console.log(
    table(
      ['Medida', 'Valor'],
      [
        ['Tags do simulador', tags],
        ['Amostras conferidas', checked.toLocaleString('pt-BR')],
        ['Valores divergentes', mismatches],
        ['Lacunas (> 1,5 × intervalo)', gaps],
        ['Amostras faltando nas lacunas', missing],
        ['Maior lacuna (s)', fmt(largestGapMs / 1000, 1)],
        ['Cobertura (gravadas / esperadas)', `${fmt(coverage * 100, 2)}%`],
      ],
    ),
  );
  if (examples.length > 0) console.log(`\nExemplos de divergência:\n  ${examples.join('\n  ')}`);
  if (unknownTags.size > 0) {
    console.log(`\nTags com source 'sim' que não são do simulador: ${[...unknownTags].join(', ')}`);
  }
  saveJson(opts.out, {
    from: new Date(from),
    to: new Date(to),
    intervalMs: interval,
    tags,
    checked,
    mismatches,
    gaps,
    missing,
    largestGapMs,
    coverage,
  });
  process.exitCode = mismatches > 0 ? 2 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
