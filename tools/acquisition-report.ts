/**
 * Relatório de aquisição por fonte (npm run report:acquisition).
 *
 *   npm run report:acquisition -- [--minutes=10] [--out=resultados/aquisicao.json]
 *
 * Para cada fonte, nos últimos --minutes: amostras gravadas, tags, taxa e a
 * latência de aquisição (received_at − time), do instante da medição, segundo
 * a fonte, até a chegada na API:
 *
 * - sim: a amostra nasce na própria API (latência ~0);
 * - mqtt: com o horário na mensagem, mede dispositivo → broker → API;
 * - opcua: sourceTimestamp do servidor até a notificação da assinatura, que
 *   sai a cada OPCUA_SAMPLING_MS (o intervalo de publicação);
 * - modbus: o protocolo não informa horário, então time = chegada (0 por
 *   definição); o atraso real é o do polling (MODBUS_POLL_MS).
 */
import { cliOptions, connectDb, fmt, numberOption, saveJson, table } from './lib/common';

async function main() {
  const opts = cliOptions();
  const minutes = numberOption(opts, 'minutes', 10);
  const ds = await connectDb();
  const rows = await ds.query<
    {
      source: string;
      samples: number;
      tags: number;
      mean_ms: number;
      p50_ms: number;
      p95_ms: number;
      p99_ms: number;
      max_ms: number;
    }[]
  >(
    `WITH w AS (
       SELECT source, tag, extract(epoch FROM received_at - time) * 1000 AS lat
         FROM measurements
        WHERE time > now() - make_interval(mins => $1)
     )
     SELECT source,
            count(*)::int AS samples,
            count(DISTINCT tag)::int AS tags,
            avg(lat) AS mean_ms,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY lat) AS p50_ms,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY lat) AS p95_ms,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY lat) AS p99_ms,
            max(lat) AS max_ms
       FROM w GROUP BY source ORDER BY source`,
    [minutes],
  );
  await ds.destroy();

  console.log(`Últimos ${minutes} min\n`);
  console.log(
    table(
      [
        'Fonte',
        'Tags',
        'Amostras',
        'Amostras/s',
        'Média (ms)',
        'p50 (ms)',
        'p95 (ms)',
        'p99 (ms)',
        'Máx. (ms)',
      ],
      rows.map((r) => [
        r.source,
        r.tags,
        r.samples.toLocaleString('pt-BR'),
        fmt(r.samples / (minutes * 60), 1),
        fmt(Number(r.mean_ms), 1),
        fmt(Number(r.p50_ms), 1),
        fmt(Number(r.p95_ms), 1),
        fmt(Number(r.p99_ms), 1),
        fmt(Number(r.max_ms), 1),
      ]),
    ),
  );
  saveJson(opts.out, { minutes, bySource: rows });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
