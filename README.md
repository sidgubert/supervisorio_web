# SCADA-EDU — Backend

Sistema supervisório web educacional 4.0.

- **Fase 1 (concluída):** banco de séries temporais, backend NestJS e o
  "Teste de Carga Simulado" (gerador de senoides que persiste continuamente
  no banco), com histórico agregado e tempo real via WebSocket.
- **Fase 2 (concluída):** aquisição real via MQTT, Modbus TCP e OPC UA,
  todas convergindo para o mesmo formato de amostra, com cadastro de tags
  editável pela API.

## Stack

- **TimescaleDB** (extensão do PostgreSQL) — banco de séries temporais.
- **NestJS** sobre **Express** (adaptador HTTP padrão do Nest).
- **TypeORM** + driver `pg` — acesso ao banco.
- **TypeScript** — tipagem estática das variáveis de processo.
- **socket.io** — tempo real para o dashboard.
- **MQTT.js** + **Mosquitto** — aquisição MQTT.
- **modbus-serial** — aquisição Modbus TCP (cliente e simulador de CLP).
- **node-opcua** — aquisição OPC UA (cliente; o servidor é usado nos testes e
  no simulador).

## Pré-requisitos

- Docker + Docker Compose
- Node.js 22.13+ (exigido pelo node-opcua)

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

Algumas dependências do node-opcua são publicadas só em ESM. O Node as carrega
normalmente, mas o Jest roda em CommonJS: o `jest.esm-transformer.cjs`
converte apenas os pacotes listados em `transformIgnorePatterns` (no
`package.json`).

## Estrutura

```
docker-compose.yml      TimescaleDB, Mosquitto (+ Adminer opcional)
docker/mosquitto/       configuração do broker MQTT de desenvolvimento
tools/modbus-sim.ts     simulador de CLP Modbus TCP (npm run sim:modbus)
tools/opcua-sim.ts      simulador de servidor OPC UA (npm run sim:opcua)
jest.esm-transformer.cjs  converte dependências só-ESM para o Jest
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
  alarms/               motor de alarmes (alarm-rules.ts: regras puras)
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
    opcua/
      opcua-mapping.ts    NodeId, StatusCode -> qualidade, Variant -> número
      opcua.source.ts     fonte "opcua": monitora as tags (subscription)
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
| `opcua`  | `OPCUA_ENABLED=true`  | NodeId: `ns=3;s=SlowUInt1`, `ns=2;i=1001`         |

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

### OPC UA

Conecta em `OPCUA_ENDPOINT` e monitora (_subscription_) o atributo Value de
cada tag OPC UA, com amostragem de `OPCUA_SAMPLING_MS`. O `address` da tag é
o NodeId: `ns=<n>;s=<texto>`, `ns=<n>;i=<número>`, `i=<número>` (namespace 0),
`ns=<n>;g=<guid>` ou `ns=<n>;b=<base64>`.

- O servidor avisa a cada mudança, sem polling. O horário da amostra é o
  `sourceTimestamp` informado pelo servidor.
- Tipos aceitos: Boolean (1/0), inteiros de 8 a 64 bits, Float (limitado a
  7 dígitos significativos) e Double. Texto, data e arrays são ignorados, com
  aviso no log.
- StatusCode vira qualidade: Good → 192; Uncertain → 64, mantendo o valor;
  Bad → grava **uma** amostra com o último valor bom e qualidade 0, como no
  Modbus.
- NodeIds que o servidor não conhece aparecem como "recusados" em
  `GET /sources`; as demais tags seguem normalmente.
- Sem servidor, a API sobe normalmente e a fonte reconecta sozinha; o
  node-opcua restaura sessão e assinaturas. Uma queda de conexão marca as
  tags monitoradas como Bad uma vez.
- Segurança: SecurityMode None e acesso anônimo, adequado a laboratório. O
  certificado do cliente fica em `OPCUA_PKI_DIR` (padrão `.opcua-pki/`, fora
  do git); ao ligar segurança num servidor real, é o certificado de
  `own/certs` que o servidor precisa confiar.
- O node-opcua (cerca de 1 s para carregar) só é importado com
  `OPCUA_ENABLED=true`.

Para testar com o simulador (em outro terminal):

```bash
npm run sim:opcua      # servidor OPC UA em opc.tcp://localhost:4840 (variáveis em tools/opcua-sim.ts)
```

Com `OPCUA_ENABLED=true` e `OPCUA_ENDPOINT=opc.tcp://localhost:4840` no
`.env`, cadastre por exemplo
`{"tag":"TT-201.PV","unit":"°C","source":"opcua","address":"ns=1;s=Reator.Temperatura"}`.
No simulador, `ns=1;s=Sensor.Instavel` entra em falha (Bad) por 10 s a cada
minuto, e `ns=1;s=Linha.Status` é texto (ignorado).

A fonte também foi testada com o Microsoft OPC PLC
(`docker run -p 50000:50000 mcr.microsoft.com/iotedge/opc-plc:2.15.9 --pn=50000 --autoaccept --unsecuretransport`),
cujas variáveis ficam em `ns=3` (ex: `ns=3;s=SpikeData`, `ns=3;s=StepUp` e
`ns=3;s=BadFastUInt1`, que alterna entre Good, Uncertain e Bad).

## Configuração

Todas as variáveis estão em `.env.example`. Elas são validadas na subida:
se alguma estiver inválida (ex: `SIM_INTERVAL_MS=abc`), a API não sobe e
lista os problemas.

`INGEST_BUFFER_MAX` limita o buffer em memória da ingestão: se o banco ficar
fora do ar, as amostras mais antigas são descartadas (com aviso no log) em
vez de a memória crescer sem limite.

## Endpoints

- `GET /health` — `200 {status:'ok', db:'up'}` ou `503` se o banco não responder.
- `GET /alarms` — alarmes abertos (ativos ou não reconhecidos), mais graves
  primeiro; `GET /alarms/history?from=&to=&tag=&limit=` — histórico (padrão:
  últimas 24 h, até 200); `POST /alarms/:id/ack` — reconhece um alarme;
  `POST /alarms/ack-all` — reconhece todos. Detalhes em [Alarmes](#alarmes).
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
    "alarmDeadband": 0.2,
    "source": "mqtt",
    "address": "planta/pt500",
    "enabled": true
  }
  ```

  Nome: letras, dígitos e `. _ : -` (ex: `TIC-101.PV`). Limites em ordem
  (`alarmLL ≤ alarmL < alarmH ≤ alarmHH`, todo limite baixo abaixo de todo
  alto) e `engMin < engMax`. `alarmDeadband` (≥ 0) é a banda morta dos
  alarmes. O `address` é conferido no formato da fonte.

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

// Alarmes chegam a todos os clientes, sem precisar assinar:
socket.on('alarm', ({ type, alarm }) => {
  /* type: 'raised' | 'cleared' | 'acknowledged'; alarm: { id, tag, level, state, ... } */
});
```

## Alarmes

Cada limite cadastrado na tag (`alarmLL`, `alarmL`, `alarmH`, `alarmHH`) é um
alarme independente (modelo simplificado da ISA-18.2), avaliado a cada
amostra que chega, de qualquer fonte:

- **Alto** (H, HH) ativa com valor ≥ limite; **baixo** (L, LL), com
  valor ≤ limite. Acima de HH, H e HH ficam ativos juntos.
- Normaliza quando o valor volta além da **banda morta** (`alarmDeadband`):
  um alarme alto só normaliza abaixo de (limite − banda). Sem isso, um valor
  oscilando em cima do limite geraria uma rajada de alarmes.
- Amostras com qualidade Bad não são avaliadas (o valor é o último bom).
- Um alarme fica **aberto** (em `GET /alarms`) enquanto estiver ativo **ou**
  não reconhecido. Estados: `ACTIVE_UNACKED`, `ACTIVE_ACKED`,
  `CLEARED_UNACKED` e, fora da lista, `CLOSED` (normalizado e reconhecido).
- Remover um limite (ou a tag) normaliza o alarme ativo correspondente.

O estado vive em memória: os alarmes continuam ativando, normalizando e
podendo ser reconhecidos mesmo com o banco fora do ar. Cada transição vai para
uma fila de gravação que mantém a ordem e tenta de novo até o banco voltar; os
ids (UUID) são gerados pela própria API. Na subida, os alarmes abertos são
recarregados do banco.

Para ver funcionando com o simulador da Fase 1 (vazão entre 95 e 145 m³/h a
cada 45 s):

```bash
curl -X PATCH localhost:3000/tags/FIC-301.PV -H 'Content-Type: application/json' \
  -d '{"alarmH": 130, "alarmDeadband": 2}'
curl localhost:3000/alarms
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

A tabela `alarms` guarda cada ocorrência de alarme (tag, nível, limite,
valor e horário ao ativar e ao normalizar, horário do reconhecimento). O
estado sai dos carimbos: ativo = `cleared_at` nulo; reconhecido = `acked_at`
preenchido. Um índice único parcial garante no máximo uma ocorrência ativa
por tag e nível.

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

## Próximos passos

- Com taxas de aquisição altas, agrupar/limitar o envio do `LiveGateway`
  (hoje cada lote recebido vira um evento por tag).
- node-opcua fixado em 2.183.x, a última linha com o pacote principal em
  CommonJS; atualizar para a 2.184+ (só ESM) junto com uma migração do
  projeto para ESM.
