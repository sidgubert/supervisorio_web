# SCADA-EDU — Backend

Sistema supervisório web educacional 4.0.

- **Fase 1 (concluída):** banco de séries temporais, backend NestJS e o
  "Teste de Carga Simulado" (gerador de senoides que persiste continuamente
  no banco), com histórico agregado e tempo real via WebSocket.
- **Fase 2 (em andamento):** aquisição real via MQTT e Modbus TCP (prontas)
  e OPC UA, todas convergindo para o mesmo formato de amostra.

## Stack

- **TimescaleDB** (extensão do PostgreSQL) — banco de séries temporais.
- **NestJS** sobre **Express** (adaptador HTTP padrão do Nest).
- **TypeORM** + driver `pg` — acesso ao banco.
- **TypeScript** — tipagem estática das variáveis de processo.
- **socket.io** — tempo real para o dashboard.
- **MQTT.js** + **Mosquitto** — aquisição MQTT.
- **modbus-serial** — aquisição Modbus TCP (cliente e simulador de CLP).

## Pré-requisitos

- Docker + Docker Compose
- Node.js 20+

## Passo a passo

```bash
# 1. Copie as variáveis de ambiente
cp .env.example .env

# 2. Suba o banco e o broker MQTT
docker compose up -d
#    (opcional) cliente web em http://localhost:8080 :
#    docker compose --profile tools up -d

# 3. Instale as dependências do backend
npm install

# 4. Rode o backend em modo desenvolvimento
#    (na subida, aplica as migrations pendentes: hypertable, tags...)
npm run start:dev
```

Com `SIM_ENABLED=true`, o simulador começa a gerar amostras imediatamente.
Para confirmar que os dados estão sendo persistidos:

```bash
docker exec -it scada-timescaledb \
  psql -U scada -d scada -c \
  "SELECT tag, count(*), max(time) FROM measurements GROUP BY tag;"
```

## Qualidade de código

```bash
npm test            # testes unitários (Jest)
npm run test:cov    # testes + relatório de cobertura em coverage/
npm run lint        # ESLint (typescript-eslint, regras com checagem de tipos)
npm run format      # formata com Prettier
```

## Estrutura

```
docker-compose.yml      TimescaleDB, Mosquitto (+ Adminer opcional)
docker/mosquitto/       configuração do broker MQTT de desenvolvimento
tools/modbus-sim.ts     simulador de CLP Modbus TCP (npm run sim:modbus)
src/
  main.ts               bootstrap da API (CORS, porta, shutdown hooks)
  app.module.ts         config + conexão TypeORM
  app.controller.ts     GET / e GET /health (verifica o banco; 503 se fora)
  common/               utilitários compartilhados
  config/
    env.validation.ts   validação/conversão das variáveis de ambiente
  database/
    typeorm.config.ts   opções do TypeORM (comuns à API e ao CLI)
    data-source.ts      DataSource do CLI de migrations
    migrations/         schema versionado (hypertable, tags, agregações)
  measurements/         entidade + service (insert em lote, latest, history)
    history-query.ts    validação de período/resolução do /history
  tags/                 cadastro de tags (unidade, faixa, limites de alarme)
  ingestion/            núcleo comum a todas as fontes de dados
    acquisition-source.ts  contrato que toda fonte implementa
    ingestion.service.ts   registro/ciclo de vida das fontes + normalização
    ingestion-buffer.ts    buffer limitado + gravação em lote no banco
    sample.ts              formatos SampleInput (da fonte) e Sample (do banco)
  sources/              fontes de aquisição (uma pasta por protocolo)
    simulator/
      signal.ts           geração de senoides (lógica pura, testável)
      simulator.source.ts fonte "sim": emite as senoides a cada SIM_INTERVAL_MS
    mqtt/
      mqtt-payload.ts     formatos de payload aceitos + validação de tópico
      mqtt.source.ts      fonte "mqtt": assina o tópico de cada tag
    modbus/
      modbus-address.ts   endereços, agrupamento de leituras, decodificação
      modbus.source.ts    fonte "modbus": lê as tags em ciclos (polling)
  realtime/
    live.gateway.ts     WebSocket (socket.io /live) para o dashboard
```

## Arquitetura de ingestão

```
SimulatorSource ─┐
MqttSource      ─┼─ emit(SampleInput[]) ─► IngestionService ─► IngestionBuffer ─► MeasurementsService ─► TimescaleDB
(ModbusSource)  ─┤                         normaliza + valida   limitado, 1 flush   INSERT único (unnest),
(OpcUaSource)   ─┘           │                                  por vez             idempotente
                              └─► samples$ ─► LiveGateway ─► dashboard (socket.io /live)
```

- Uma fonte implementa `AcquisitionSource` (`name`, `start(emit)`, `stop()`)
  e se registra no `IngestionService` no seu `onModuleInit`. Ela não conhece
  buffer nem banco: só converte o payload do protocolo para `SampleInput`.
- O `IngestionService` normaliza cada amostra: qualidade padrão 192 (Good),
  nome da fonte em `source` e instante de recebimento em `received_at`. Sem
  `time`, ou com um `time` implausível (mais de 5 min no futuro ou mais de 1
  dia no passado, típico de relógio de campo zerado), usa o de recebimento.
- Amostras inválidas são descartadas antes de chegar ao banco: tag vazia, com
  mais de 200 caracteres ou com caracteres de controle; valor não numérico,
  NaN ou infinito; qualidade fora de 0–255. Uma única amostra que o banco
  recusasse faria o lote inteiro falhar a cada nova tentativa. Os avisos no
  log saem no máximo uma vez por minuto por fonte.
- Na subida, as fontes são iniciadas; uma que falhe não derruba as outras. No
  encerramento, as fontes param **antes** de o buffer ser esvaziado no banco.
- As amostras válidas também saem em `samples$` assim que chegam, antes do
  banco: o tempo real continua funcionando mesmo com o banco fora do ar.

## Fontes de aquisição

Cada fonte adquire as tags do cadastro com `source` igual ao seu nome e
`enabled = true`; o `address` da tag diz onde buscar o valor no protocolo.
Criar, alterar ou remover uma tag pela API reconfigura a fonte na hora, sem
reiniciar. O estado de cada fonte aparece em `GET /sources`.

| Fonte    | Liga com              | `address` da tag                                  |
| -------- | --------------------- | ------------------------------------------------- |
| `sim`    | `SIM_ENABLED=true`    | — (gera as 4 tags de exemplo)                     |
| `mqtt`   | `MQTT_ENABLED=true`   | tópico exato, sem `+` ou `#`                      |
| `modbus` | `MODBUS_ENABLED=true` | `hr:0`, `ir:10?type=int16&scale=0.1`, `coil:3`... |

### MQTT

Conecta em `MQTT_URL` (opcionalmente com `MQTT_USERNAME`/`MQTT_PASSWORD`) e
assina, com QoS 1, o tópico de cada tag MQTT. Se o broker estiver fora do ar,
a API sobe normalmente e a fonte reconecta sozinha, reassinando os tópicos.

Payloads aceitos:

```text
21.5                                                   número
true | false                                           booleano (1 / 0)
{"value": 21.5}                                        JSON
{"value": 21.5, "time": "2026-10-08T12:00:00Z", "quality": 192}
```

`time` (ou `timestamp`/`ts`) aceita ISO 8601 ou epoch em segundos ou
milissegundos; sem ele, vale o instante de recebimento. `quality` (ou `q`) é
o byte de qualidade (0–255). Payloads em outro formato são descartados, com
aviso no log.

Para testar com o broker do `docker compose`:

```bash
# cadastra uma tag MQTT
curl -X POST localhost:3000/tags -H 'Content-Type: application/json' \
  -d '{"tag":"TT-900.PV","unit":"C","source":"mqtt","address":"lab/tt900"}'

# publica valores
docker exec scada-mosquitto mosquitto_pub -t lab/tt900 -q 1 -m 21.5
docker exec scada-mosquitto mosquitto_pub -t lab/tt900 -q 1 \
  -m '{"value": 22, "quality": 192}'

curl localhost:3000/measurements/TT-900.PV/latest
```

### Modbus TCP

Lê, a cada `MODBUS_POLL_MS`, as tags Modbus no equipamento
`MODBUS_HOST:MODBUS_PORT` (timeout de `MODBUS_TIMEOUT_MS` por request).

Endereço da tag: `<área>:<offset>[?unit=1&type=uint16&scale=1&swap=false]`

| Área   | Função            | Tipos                                                    |
| ------ | ----------------- | -------------------------------------------------------- |
| `hr`   | holding registers | `uint16` (padrão), `int16`, `uint32`, `int32`, `float32` |
| `ir`   | input registers   | idem                                                     |
| `coil` | coils             | bit (1/0)                                                |
| `di`   | discrete inputs   | bit (1/0)                                                |

- `offset` começa em 0: `hr:0` é o registrador 40001 da notação clássica.
- Tipos de 32 bits ocupam 2 registradores, com a palavra alta primeiro;
  `swap=true` inverte a ordem (CDAB), comum em alguns CLPs.
- `scale` multiplica o valor bruto (ex: `scale=0.1` para décimos). O
  resultado é arredondado às casas da escala, e `float32` a 7 dígitos
  significativos, sem ruído de ponto flutuante.
- `unit` é o unit ID do escravo (padrão 1), útil atrás de gateways.

Comportamento:

- Registradores contíguos do mesmo escravo e área viram um só request (até
  125 registradores ou 2000 bits). Endereços com lacunas ficam em requests
  separados, porque ler um "buraco" pode gerar a exceção _illegal data
  address_ e derrubar o bloco inteiro.
- Se o equipamento responde com exceção, só o bloco afetado falha. Se a
  conexão cai ou dá timeout, a fonte reconecta no ciclo seguinte.
- Quando uma tag deixa de ser lida, a fonte grava **uma** amostra com
  qualidade Bad (0) e o último valor bom, marcando no histórico onde o dado
  deixou de valer. As leituras seguintes voltam ao normal sozinhas.
- O Modbus não informa horário: vale o instante de recebimento.

Para testar com o simulador (em outro terminal):

```bash
npm run sim:modbus     # CLP simulado em 127.0.0.1:5020 (mapa em tools/modbus-sim.ts)
```

Com `MODBUS_ENABLED=true` e `MODBUS_PORT=5020` no `.env`, cadastre as tags
(ex: `{"tag":"PT-101.PV","unit":"bar","source":"modbus","address":"hr:0?scale=0.01"}`
em `POST /tags`) e acompanhe em `GET /sources` e `GET /measurements/PT-101.PV/latest`.

## Configuração

Todas as variáveis estão em `.env.example`. Elas são validadas na subida:
se alguma estiver inválida (ex: `SIM_INTERVAL_MS=abc`), a API não sobe e
lista os problemas.

`INGEST_BUFFER_MAX` limita o buffer em memória da ingestão: se o banco ficar
fora do ar, as amostras mais antigas são descartadas (com aviso no log) em
vez de a memória crescer sem limite.

## Endpoints

- `GET /health` — `200 {status:'ok', db:'up'}` ou `503` se o banco não responder.
- `GET /sources` — fontes de aquisição: conectada, tags adquiridas, amostras
  aceitas e descartadas, última amostra.
- `GET /measurements/:tag/latest?limit=100` — últimas amostras da tag
  (`limit` entre 1 e 5000).
- `GET /measurements/:tag/history?from=&to=&bucket=` — série para gráficos.
  `from`/`to` em ISO 8601 (padrão: última hora). `bucket`:
  - `auto` (padrão): escolhe pela duração — até 30 min `raw`, até 36 h `1m`,
    acima disso `1h` (gráficos com no máximo ~2 mil pontos);
  - `raw` (máx 6 h), `1m` (máx 7 dias), `1h` (máx 400 dias).

  Resposta: `{ tag, bucket, from, to, points: [{ time, avg, min, max, count }] }`
  (no `raw`, `avg = min = max = value` e `count = 1`).

- `GET /tags` — tags cadastradas; `GET /tags/:tag` — uma tag (`404` se não existir).
- `POST /tags` — cadastra (`409` se já existir). Só `tag` é obrigatório:

  ```json
  {
    "tag": "PT-500.PV",
    "description": "Pressão do vaso",
    "unit": "bar",
    "engMin": 0,
    "engMax": 16,
    "alarmL": 2,
    "alarmH": 12,
    "source": "mqtt",
    "address": "planta/pt500",
    "enabled": true
  }
  ```

  Nome: letras, dígitos e `. _ : -` (ex: `TIC-101.PV`). Limites em ordem
  (`alarmLL ≤ alarmL < alarmH ≤ alarmHH`, todo limite baixo abaixo de todo
  alto) e `engMin < engMax`. O `address` é conferido no formato da fonte.

- `PATCH /tags/:tag` — altera campos (ausente = mantém; `null` = apaga).
- `DELETE /tags/:tag` — remove do cadastro (`204`); o histórico é mantido.

Erros de validação respondem `400` com a lista de problemas; campos
desconhecidos também são recusados.

## Tempo real (WebSocket)

socket.io no namespace `/live`:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/live');
// sem `tags` (ou lista vazia) = todas as tags
const ack = await socket.emitWithAck('subscribe', { tags: ['TIC-101.PV'] });
// ack = { ok: true, tags: [...], last: [último valor conhecido de cada tag] }
socket.on('samples', (samples) => {
  /* [{ time, tag, value, quality, source, receivedAt }, ...] — um lote por tag */
});
socket.emit('unsubscribe', { tags: ['TIC-101.PV'] }); // sem tags = todas
```

## Modelo de dados

Tabela única `measurements` em formato _long_ (uma linha por amostra de cada
tag): `time, tag, value, quality, source, received_at`. Esse formato evita
alterar o schema ao adicionar novas tags e é o recomendado para hypertables.

- `time` é o instante da medição segundo a fonte; `received_at`, quando o
  servidor a recebeu. A diferença entre os dois é a latência de aquisição.
- `quality` segue o byte de qualidade do OPC DA (192 Good, 64 Uncertain,
  0 Bad); cada fonte converte a qualidade do seu protocolo para essa escala.
- `(tag, time)` é único, e a gravação usa `INSERT ... ON CONFLICT DO NOTHING`:
  regravar um lote (ex: a conexão caiu depois de o banco confirmar a gravação)
  não duplica amostras.
- Chunks com mais de 7 dias são comprimidos pelo TimescaleDB (formato colunar,
  agrupado por tag). A retenção fica desligada, para manter o histórico
  completo; para ligar: `SELECT add_retention_policy('measurements', INTERVAL '1 year');`

O campo `source` (`sim` por enquanto) já antecipa a Fase 2: distinguir a
origem dos dados entre `mqtt`, `modbus`, `opcua`.

A tabela `tags` guarda os metadados de cada variável: descrição, unidade,
faixa de engenharia (`eng_min`/`eng_max`), limites de alarme
(`alarm_ll`/`alarm_l`/`alarm_h`/`alarm_hh`, com ordem garantida por CHECK) e
onde ela é adquirida (`source`/`address`). As tags do simulador já vêm
cadastradas. Não há FK de `measurements.tag` para `tags`, de propósito: uma
amostra de tag não cadastrada faria o lote inteiro falhar e travaria o buffer
de ingestão.

Duas _continuous aggregates_ (`measurements_1m` e `measurements_1h`) guardam
`avg/min/max/count` por tag e intervalo, atualizadas por jobs do próprio
TimescaleDB (a cada 1 min e 30 min). São _real-time aggregates_: a consulta
completa o trecho ainda não materializado com os dados brutos, então nunca
ficam defasadas. A janela de reprocessamento (1 e 7 dias) cobre amostras que
chegam atrasadas, como as regravadas pelo buffer após uma queda do banco.

## Migrations

O schema é versionado em `src/database/migrations` (TypeORM). Com
`DB_MIGRATIONS_RUN=true` (padrão), a API aplica as pendentes ao subir.

```bash
npm run migration:show                               # aplicadas e pendentes
npm run migration:run                                # aplica as pendentes
npm run migration:revert                             # desfaz a última
npm run migration:create src/database/migrations/Nome  # cria uma nova, vazia
```

Bancos criados pelo antigo `db/init.sql` são adotados sem alteração: a
migration inicial é idempotente e apenas se registra.

## Próximos passos (Fase 2)

- Fonte OPC UA: um novo `AcquisitionSource` (ver `mqtt.source.ts` e
  `modbus.source.ts` como modelo), lendo as tags do cadastro e convertendo o
  valor e o StatusCode do protocolo para `SampleInput`.
- Alarmes: comparar as amostras de `samples$` com os limites da tabela `tags`.
- Com taxas de aquisição altas, agrupar/limitar o envio do `LiveGateway`
  (hoje cada lote recebido vira um evento por tag).
