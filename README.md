# TALOS

Sistema supervisório web (SCADA) para a Indústria 4.0: adquire variáveis de
processo por MQTT, Modbus TCP e OPC UA, guarda o histórico num banco de séries
temporais, avalia alarmes e mostra tudo em tempo real num dashboard web.
Tem também foco educacional: o código é aberto, comentado e acompanhado de
simuladores para estudar cada protocolo sem equipamento real.

O projeto foi construído em cinco fases, todas concluídas:

1. **Banco e carga simulada:** TimescaleDB, backend NestJS e um gerador de
   senoides que grava continuamente no banco, com histórico agregado.
2. **Aquisição real:** MQTT, Modbus TCP e OPC UA, todas convergindo para o
   mesmo formato de amostra, com cadastro de tags editável pela API.
3. **Dashboard e alarmes:** gráficos em tempo real (SSE e WebSocket) e alarmes
   de processo (modelo simplificado da ISA-18.2).
4. **Operação:** histórico de alarmes com quem reconheceu, sinótico do
   processo, login e imagem Docker.
5. **Desempenho:** métricas de ingestão e armazenamento, retenção
   configurável, exportação CSV/JSON e comparação dos protocolos.

## Sumário

- [Visão geral](#visão-geral)
- [Como rodar](#como-rodar)
- [Dashboard](#dashboard)
- [Fontes de aquisição](#fontes-de-aquisição): [MQTT](#mqtt),
  [Modbus TCP](#modbus-tcp), [OPC UA](#opc-ua)
- [Cadastro de tags](#cadastro-de-tags)
- [Alarmes](#alarmes)
- [Tempo real (SSE e WebSocket)](#tempo-real-sse-e-websocket)
- [Autenticação](#autenticação)
- [Métricas, retenção e exportação](#métricas-retenção-e-exportação)
- [API HTTP](#api-http)
- [Modelo de dados](#modelo-de-dados)
- [Configuração](#configuração)
- [Docker](#docker)
- [Migrations](#migrations)
- [Testes e qualidade de código](#testes-e-qualidade-de-código)
- [Estrutura do código](#estrutura-do-código)
- [CommonJS, ESM e o node-opcua](#commonjs-esm-e-o-node-opcua)
- [Próximos passos](#próximos-passos)

## Visão geral

```
 Fontes de aquisição           Núcleo de ingestão                      Banco
 ───────────────────           ──────────────────                      ─────
 SimulatorSource ─┐
 MqttSource      ─┼─ emit() ─► IngestionService ─► IngestionBuffer ─► TimescaleDB
 ModbusSource    ─┤            normaliza, valida    limitado; INSERT    (measurements)
 OpcUaSource     ─┘                  │              único, idempotente
                                     │                     │
                                     │                     └─► inserts$ ─► MetricsCollector
                                     │                                     (amostras/s, latência)
                                     └─► samples$ ─┬─► LiveFeedService ─► SSE /api/dashboard/stream
                                                   │   (agrupa por tag)   e socket.io /live ─► dashboard
                                                   └─► AlarmsService ───► tabela alarms + eventos
                                                                          (pelos mesmos canais)
```

- Cada **fonte** só sabe falar o seu protocolo e converter o valor para o
  formato comum (`SampleInput`). Ela adquire as tags do cadastro com o seu
  nome em `source`; o `address` da tag diz onde buscar o valor.
- O **núcleo de ingestão** normaliza (qualidade, horários, origem), descarta
  amostras inválidas e grava em lote, com buffer e nova tentativa se o banco
  cair.
- As amostras válidas também saem na hora para o **tempo real** e para o
  **motor de alarmes**, antes do banco: os dois continuam funcionando com o
  banco fora do ar.
- O **dashboard** é servido pela própria API (arquivos estáticos em
  `public/`); a API fica sob `/api`.

## Stack

- **TimescaleDB** (extensão do PostgreSQL) — banco de séries temporais.
- **NestJS** sobre **Express** — framework do backend.
- **TypeORM** + driver `pg` — acesso ao banco e migrations.
- **TypeScript** — tipagem estática.
- **SSE** (Server-Sent Events) e **socket.io** — tempo real.
- **HTML, CSS e JavaScript** sem framework nem build, com **Chart.js** — o
  dashboard.
- **MQTT.js** + **Mosquitto** — aquisição MQTT.
- **modbus-serial** — aquisição Modbus TCP (cliente e simulador de CLP).
- **node-opcua** — aquisição OPC UA (cliente; o servidor é usado nos testes e
  no simulador).

## Como rodar

Pré-requisitos: Docker com Docker Compose, e Node.js 22.13 ou mais novo
(exigido pelo node-opcua).

```bash
# 1. Copie as variáveis de ambiente
cp .env.example .env

# 2. Suba o banco e o broker MQTT
docker compose up -d
#    (opcional) cliente web do banco em http://localhost:8080:
#    docker compose --profile tools up -d

# 3. Instale as dependências
npm install

# 4. Rode a API em modo desenvolvimento
#    (na subida, aplica as migrations pendentes)
npm run start:dev
```

Abra **http://localhost:3000**: é o dashboard. A API fica sob `/api`
(`GET /api` lista os endpoints). Com `SIM_ENABLED=true` (padrão), o simulador
começa a gerar amostras de 4 tags na hora, e os gráficos já se mexem. Pela
linha de comando:

```bash
curl localhost:3000/api/sources
curl localhost:3000/api/measurements/TIC-101.PV/latest?limit=5
```

Para experimentar as outras fontes sem equipamento real, há simuladores:

| Para testar | Rode (em outro terminal)          | E ligue no `.env`                                               |
| ----------- | --------------------------------- | --------------------------------------------------------------- |
| MQTT        | já sobe com o `docker compose`    | `MQTT_ENABLED=true` (padrão no `.env.example`)                  |
| Modbus TCP  | `npm run sim:modbus` (porta 5020) | `MODBUS_ENABLED=true`, `MODBUS_PORT=5020`                       |
| OPC UA      | `npm run sim:opcua` (porta 4840)  | `OPCUA_ENABLED=true`, `OPCUA_ENDPOINT=opc.tcp://localhost:4840` |

Em seguida, cadastre tags para essas fontes (exemplos em cada seção abaixo).
Para rodar a API também em container, veja [Docker](#docker).

## Dashboard

Servido pela própria API, sem build: HTML, CSS e JavaScript (módulos ES) em
`public/`, e o Chart.js servido de `node_modules`, para funcionar sem
internet.

| Tela                     | O que mostra                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Gráficos**             | Um gráfico por tag (últimos 15 min, atualizado ao vivo) e os alarmes abertos, com reconhecimento um a um ou de todos |
| **Sinótico**             | Desenho do processo com os valores ao vivo; instrumentos em alarme ficam destacados                                  |
| **Histórico de alarmes** | Últimas 24 h: quando cada alarme ativou, normalizou e quem reconheceu                                                |
| **Métricas**             | Ingestão por fonte, armazenamento e compressão, comparação dos protocolos e exportação CSV                           |
| **Configuração**         | Faixa, limites de alarme, banda morta e posição no sinótico de cada tag                                              |

O tempo real chega por SSE (`/api/dashboard/stream`); se a conexão cair, o
navegador reconecta sozinho. Com o login ligado
([Autenticação](#autenticação)), o dashboard pede usuário e senha antes de
tudo. Todo texto vindo da API é escapado antes de ir para a tela: um nome de
tag como `<img onerror=...>` aparece como texto, sem executar nada.

## Fontes de aquisição

Cada fonte adquire as tags do cadastro com `source` igual ao seu nome e
`enabled = true`. Criar, alterar ou remover uma tag pela API reconfigura a
fonte na hora, sem reiniciar. Em comum, todas:

- sobem mesmo com o equipamento ou broker fora do ar, e reconectam sozinhas;
- registram o estado em `GET /api/sources` (conectada, tags, amostras, última
  amostra);
- convertem a qualidade do protocolo para o byte de qualidade interno
  (192 Good, 64 Uncertain, 0 Bad).

| Fonte    | Liga com              | `address` da tag                                  |
| -------- | --------------------- | ------------------------------------------------- |
| `sim`    | `SIM_ENABLED=true`    | — (gera as 4 tags de exemplo)                     |
| `mqtt`   | `MQTT_ENABLED=true`   | tópico exato, sem `+` ou `#`                      |
| `modbus` | `MODBUS_ENABLED=true` | `hr:0`, `ir:10?type=int16&scale=0.1`, `coil:3`... |
| `opcua`  | `OPCUA_ENABLED=true`  | NodeId: `ns=3;s=SlowUInt1`, `ns=2;i=1001`         |

O núcleo de ingestão trata o que é comum a todas:

- Sem horário da fonte, ou com um horário implausível (mais de 5 min no
  futuro ou mais de 1 dia no passado, típico de relógio de campo zerado),
  vale o instante de recebimento.
- Amostras inválidas são descartadas antes do banco: tag vazia, com mais de
  200 caracteres ou com caracteres de controle; valor não numérico, NaN ou
  infinito; qualidade fora de 0–255. Uma única amostra que o banco recusasse
  faria o lote inteiro falhar a cada nova tentativa. Os avisos no log saem no
  máximo uma vez por minuto por fonte.
- No encerramento (Ctrl+C ou SIGTERM), as fontes param primeiro e o buffer é
  gravado no banco antes de o processo sair.

### MQTT

Conecta em `MQTT_URL` (opcionalmente com `MQTT_USERNAME`/`MQTT_PASSWORD`) e
assina, com QoS 1, o tópico de cada tag MQTT. Ao reconectar, reassina os
tópicos.

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

Para testar com o broker do `docker compose` (sem autenticação: só para
laboratório):

```bash
# cadastra uma tag MQTT
curl -X POST localhost:3000/api/tags -H 'Content-Type: application/json' \
  -d '{"tag":"TT-900.PV","unit":"C","source":"mqtt","address":"lab/tt900"}'

# publica valores
docker exec talos-mosquitto mosquitto_pub -t lab/tt900 -q 1 -m 21.5
docker exec talos-mosquitto mosquitto_pub -t lab/tt900 -q 1 \
  -m '{"value": 22, "quality": 192}'

curl localhost:3000/api/measurements/TT-900.PV/latest
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

Com o simulador (`npm run sim:modbus`; mapa de registradores em
`tools/modbus-sim.ts`), cadastre por exemplo
`{"tag":"PT-101.PV","unit":"bar","source":"modbus","address":"hr:0?scale=0.01"}`
em `POST /api/tags`.

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
  `GET /api/sources`; as demais tags seguem normalmente.
- Ao reconectar, o node-opcua restaura sessão e assinaturas. Uma queda de
  conexão marca as tags monitoradas como Bad uma vez.
- Segurança: SecurityMode None e acesso anônimo, adequado a laboratório. O
  certificado do cliente fica em `OPCUA_PKI_DIR` (padrão `.opcua-pki/`, fora
  do git); ao ligar segurança num servidor real, é o certificado de
  `own/certs` que o servidor precisa confiar.
- O node-opcua (cerca de 1 s para carregar) só é importado com
  `OPCUA_ENABLED=true`.

Com o simulador (`npm run sim:opcua`; variáveis em `tools/opcua-sim.ts`),
cadastre por exemplo
`{"tag":"TT-201.PV","unit":"°C","source":"opcua","address":"ns=1;s=Reator.Temperatura"}`.
No simulador, `ns=1;s=Sensor.Instavel` entra em falha (Bad) por 10 s a cada
minuto, e `ns=1;s=Linha.Status` é texto (ignorado).

A fonte também foi testada com o Microsoft OPC PLC
(`docker run -p 50000:50000 mcr.microsoft.com/iotedge/opc-plc:2.15.9 --pn=50000 --autoaccept --unsecuretransport`),
cujas variáveis ficam em `ns=3` (ex: `ns=3;s=SpikeData`, `ns=3;s=StepUp` e
`ns=3;s=BadFastUInt1`, que alterna entre Good, Uncertain e Bad).

## Cadastro de tags

Cada tag tem um nome (ex: `TIC-101.PV`), metadados (descrição, unidade, faixa
de engenharia), limites de alarme e de onde ela é adquirida (`source` e
`address`). As 4 tags do simulador já vêm cadastradas.

```bash
curl -X POST localhost:3000/api/tags -H 'Content-Type: application/json' -d '{
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
}'
```

- Só `tag` é obrigatório. Nome: letras, dígitos e `. _ : -`.
- Limites em ordem (`alarmLL ≤ alarmL < alarmH ≤ alarmHH`, todo limite baixo
  abaixo de todo alto) e `engMin < engMax`. `alarmDeadband` (≥ 0) é a banda
  morta dos alarmes.
- `synopticKind` (`tank`, `pressure`, `flow`, `level` ou `sensor`) e
  `synopticX`/`synopticY` (0 a 100, em % da tela) põem a tag no sinótico.
- O `address` é conferido no formato da fonte (tópico MQTT, endereço Modbus,
  NodeId): um endereço errado é recusado já no cadastro.
- `PATCH /api/tags/:tag` altera campos (ausente = mantém; `null` = apaga).
  `DELETE /api/tags/:tag` remove do cadastro; o histórico de medições é mantido.
- Erros de validação respondem `400` com a lista de problemas; campos
  desconhecidos também são recusados.

## Alarmes

Cada limite cadastrado na tag (`alarmLL`, `alarmL`, `alarmH`, `alarmHH`) é um
alarme independente, avaliado a cada amostra que chega, de qualquer fonte:

- **Alto** (H, HH) ativa com valor ≥ limite; **baixo** (L, LL), com
  valor ≤ limite. Acima de HH, H e HH ficam ativos juntos.
- Normaliza quando o valor volta além da **banda morta**: um alarme alto só
  normaliza abaixo de (limite − banda). A banda é a `alarmDeadband` da tag
  ou, sem ela, `ALARM_HYSTERESIS_PCT` (padrão 2%) do limite. Sem banda morta,
  um valor oscilando em cima do limite geraria uma rajada de alarmes.
- Amostras com qualidade Bad não são avaliadas (o valor é o último bom).
- Um alarme fica **aberto** (em `GET /api/alarms`) enquanto estiver ativo **ou**
  não reconhecido. Estados: `ACTIVE_UNACKED`, `ACTIVE_ACKED`,
  `CLEARED_UNACKED` e, fora da lista, `CLOSED` (normalizado e reconhecido).
- O reconhecimento registra quem reconheceu: o usuário do login ou, com o
  login desligado, o `by` enviado no corpo (`{"by": "Maria"}`); sem nenhum
  dos dois, "anônimo".
- Remover um limite (ou a tag) normaliza o alarme ativo correspondente.

O estado vive em memória: os alarmes continuam ativando, normalizando e
podendo ser reconhecidos mesmo com o banco fora do ar. Cada transição vai para
uma fila de gravação que mantém a ordem e tenta de novo até o banco voltar; os
ids (UUID) são gerados pela própria API. Na subida, os alarmes abertos são
recarregados do banco.

Para ver funcionando com o simulador (vazão entre 95 e 145 m³/h a cada 45 s):

```bash
curl -X PATCH localhost:3000/api/tags/FIC-301.PV -H 'Content-Type: application/json' \
  -d '{"alarmH": 130, "alarmDeadband": 2}'
curl localhost:3000/api/alarms
curl -X POST localhost:3000/api/alarms/ack-all
```

## Tempo real (SSE e WebSocket)

Há dois canais, com o mesmo conteúdo:

- **SSE** em `GET /api/dashboard/stream`, o que o dashboard usa: HTTP comum,
  só do servidor para o cliente, sempre com todas as tags. O navegador
  reconecta sozinho.
- **socket.io** no namespace `/live`: bidirecional, com assinatura por tag.

### SSE

```js
const es = new EventSource('/api/dashboard/stream'); // com login: ?token=...
es.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  // { type: 'sample', tag, value, quality, source, time }
  // { type: 'alarm', change: 'raised' | 'cleared' | 'acknowledged', alarm }
  // { type: 'ping' } a cada 25 s, para proxies não fecharem a conexão ociosa
};
```

Para a primeira carga da tela, `GET /api/dashboard/tags` traz o último valor
de cada tag, e `GET /api/dashboard/alarms`, os alarmes abertos e o cadastro.

### socket.io

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000/live'); // com login: { auth: { token } }

// Assina tags (sem `tags`, ou lista vazia = todas). O ack já traz o último
// valor conhecido de cada tag, para o gráfico não começar vazio.
const ack = await socket.emitWithAck('subscribe', { tags: ['TIC-101.PV'] });
// ack = { ok: true, tags: [...], last: [...] }

socket.on('samples', (samples) => {
  /* [{ time, tag, value, quality, source, receivedAt }, ...] — um lote por tag */
});

socket.emit('unsubscribe', { tags: ['TIC-101.PV'] }); // sem tags = todas

// Alarmes chegam a todos os clientes, sem precisar assinar:
socket.on('alarm', ({ type, alarm }) => {
  /* type: 'raised' | 'cleared' | 'acknowledged'; alarm: { id, tag, level, state, ... } */
});
```

Nos dois canais, as amostras de cada tag saem agrupadas (`LiveFeedService`):
um lote por tag a cada `LIVE_FLUSH_MS` (padrão 200 ms; 0 = imediato), com no
máximo `LIVE_MAX_SAMPLES_PER_TAG` amostras (as mais recentes). Assim uma fonte
rápida não inunda o navegador; o histórico completo está no banco.

## Autenticação

Desligada por padrão (`AUTH_ENABLED=false`), o que basta para laboratório:
API e dashboard ficam abertos. Para ligar, no `.env`:

```env
AUTH_ENABLED=true
AUTH_USER=operador
AUTH_PASSWORD=uma-senha-forte
AUTH_SECRET=32-ou-mais-caracteres-aleatorios
```

O `AUTH_SECRET` assina os tokens. Gere um com
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
Sem senha, ou com segredo curto ou igual ao do exemplo, a API não sobe.

- `POST /api/auth/login` com `{"username": ..., "password": ...}` devolve
  `{ token, user }`. O token vale 24 h e vai no cabeçalho
  `Authorization: Bearer <token>`; no SSE, que não aceita cabeçalhos, vai em
  `?token=`; no socket.io, em `auth: { token }`.
- Sem token válido, a API responde `401`. Ficam abertos só
  `GET /api/health`, `GET /api/auth/status` e o login. Os arquivos do
  dashboard carregam sem token, mas a tela leva ao login antes de chamar a
  API.
- No máximo 5 tentativas de login por minuto por IP (`429` acima disso), o
  que inviabiliza adivinhar a senha por tentativa e erro. Senha e assinatura
  são comparadas em tempo constante.
- O token é `payload.assinatura` (HMAC-SHA256), escrito à mão para ser fácil
  de estudar em `src/auth/auth.service.ts`. Há um único usuário; ver
  [Próximos passos](#próximos-passos).

## Métricas, retenção e exportação

A tela **Métricas** e as rotas `/api/metrics` medem o próprio sistema:

| Rota                                            | O que traz                                                                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/metrics/overview`                     | Por fonte: amostras/s e lotes/s (janela de 60 s), totais e latência média da gravação no banco; clientes e eventos do SSE e do WebSocket      |
| `GET /api/metrics/storage`                      | Linhas e tamanho da hypertable, compressão (chunks e economia), período com dados, amostras por fonte nas últimas 24 h e política de retenção |
| `GET /api/metrics/protocols`                    | Perfil de cada protocolo (paradigma, transporte, uso típico, complexidade) ao lado das métricas ao vivo dele                                  |
| `GET /api/metrics/export?minutes=60&format=csv` | Resumo por fonte e tag (amostras, primeira e última, média, mínimo, máximo) dos últimos `minutes` (até 7 dias), em `csv` ou `json`            |

- Em tabelas grandes, a contagem de linhas usa a estimativa do TimescaleDB
  (`approximate_row_count`), sem varrer a tabela; a resposta indica quando o
  número é aproximado.
- O CSV abre direto no Excel (UTF-8 com BOM). Textos que começam com `=`,
  `+`, `-` ou `@` ganham um apóstrofo na frente, para a planilha não os
  executar como fórmula.

**Retenção.** Por padrão o histórico é guardado para sempre. Com
`RETENTION_ENABLED=true`, a API cria na subida a política de retenção do
TimescaleDB, que apaga as medições mais antigas que `RETENTION_DAYS` (padrão
90). O `.env` manda: ao mudar o prazo ou desligar e reiniciar a API, a
política é recriada ou removida. O mínimo é 8 dias, acima da janela de
reprocessamento do agregado de 1 hora (7 dias): com menos, o agregado seria
recalculado a partir de dados já apagados. Os agregados `measurements_1m` e
`measurements_1h` não são apagados pela retenção.

## API HTTP

Todas as rotas ficam sob `/api`. Com o login ligado, exigem
`Authorization: Bearer <token>`, exceto as marcadas com \*.

| Método | Rota                                               | Descrição                                            |
| ------ | -------------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api`                                             | Lista os endpoints                                   |
| GET    | `/api/health` \*                                   | `200` se o banco responde; `503` se não              |
| GET    | `/api/auth/status` \*                              | Se o login está ligado                               |
| POST   | `/api/auth/login` \*                               | Login (ver [Autenticação](#autenticação))            |
| GET    | `/api/auth/me`                                     | Usuário do token                                     |
| GET    | `/api/sources`                                     | Estado das fontes de aquisição                       |
| GET    | `/api/tags`                                        | Tags cadastradas                                     |
| GET    | `/api/tags/:tag`                                   | Uma tag (`404` se não existir)                       |
| POST   | `/api/tags`                                        | Cadastra uma tag (`409` se já existir)               |
| PATCH  | `/api/tags/:tag`                                   | Altera campos de uma tag                             |
| DELETE | `/api/tags/:tag`                                   | Remove uma tag do cadastro (`204`)                   |
| GET    | `/api/measurements/:tag/latest?limit=100`          | Últimas amostras (`limit` de 1 a 5000)               |
| GET    | `/api/measurements/:tag/history?from=&to=&bucket=` | Série para gráficos (ver abaixo)                     |
| GET    | `/api/alarms`                                      | Alarmes abertos, mais graves primeiro                |
| GET    | `/api/alarms/history?from=&to=&tag=&limit=`        | Histórico de alarmes (padrão: últimas 24 h, até 200) |
| POST   | `/api/alarms/:id/ack`                              | Reconhece um alarme (`404` se não estiver aberto)    |
| POST   | `/api/alarms/ack-all`                              | Reconhece todos os alarmes abertos                   |
| GET    | `/api/dashboard/tags`                              | Último valor de cada tag                             |
| GET    | `/api/dashboard/alarms`                            | Alarmes abertos e o cadastro de tags                 |
| GET    | `/api/dashboard/stream`                            | SSE: amostras e alarmes em tempo real                |
| GET    | `/api/metrics/overview`, `/storage`, `/protocols`  | Métricas (ver seção anterior)                        |
| GET    | `/api/metrics/export?minutes=&format=`             | Exportação CSV ou JSON                               |

`/api/measurements/:tag/history`: `from`/`to` em ISO 8601 (padrão: última
hora), ou `minutes=N` para os últimos N minutos (sem `from`). `bucket`:

- `auto` (padrão): escolhe pela duração — até 30 min `raw`, até 36 h `1m`,
  acima disso `1h` (gráficos com no máximo cerca de 2 mil pontos);
- `raw` (máx 6 h), `1m` (máx 7 dias), `1h` (máx 400 dias).

Resposta: `{ tag, bucket, from, to, points: [{ time, avg, min, max, count }] }`
(no `raw`, `avg = min = max = value` e `count = 1`).

## Modelo de dados

**`measurements`** — uma linha por amostra de cada tag (formato _long_, o
recomendado para hypertables: adicionar tags não altera o schema):
`time, tag, value, quality, source, received_at`.

- `time` é o instante da medição segundo a fonte; `received_at`, quando o
  servidor a recebeu. A diferença entre os dois é a latência de aquisição.
- `quality` segue o byte de qualidade do OPC DA (192 Good, 64 Uncertain,
  0 Bad); `source` é a fonte que gerou a amostra (`sim`, `mqtt`, `modbus`,
  `opcua`).
- `(tag, time)` é único, e a gravação usa `INSERT ... ON CONFLICT DO NOTHING`:
  regravar um lote (ex: a conexão caiu depois de o banco confirmar a gravação)
  não duplica amostras.
- Chunks com mais de 7 dias são comprimidos pelo TimescaleDB (formato colunar,
  agrupado por tag). A retenção (apagar medições antigas) é configurada no
  `.env`: ver [Métricas, retenção e exportação](#métricas-retenção-e-exportação).

**`measurements_1m`** e **`measurements_1h`** — _continuous aggregates_ com
`avg/min/max/count` por tag e intervalo, atualizadas por jobs do próprio
TimescaleDB (a cada 1 min e 30 min). São _real-time aggregates_: a consulta
completa o trecho ainda não materializado com os dados brutos, então nunca
ficam defasadas. A janela de reprocessamento (1 e 7 dias) cobre amostras que
chegam atrasadas, como as regravadas pelo buffer após uma queda do banco.

**`tags`** — o cadastro: descrição, unidade, faixa de engenharia, limites e
banda morta de alarme (ordem garantida também por CHECK), `source`,
`address` e a posição no sinótico. Não há chave estrangeira de `measurements.tag` para `tags`, de
propósito: uma amostra de tag não cadastrada faria o lote inteiro falhar e
travaria o buffer de ingestão.

**`alarms`** — cada ocorrência de alarme: tag, nível, limite, valor e horário
ao ativar e ao normalizar, horário do reconhecimento e quem reconheceu
(`acked_by`). O estado sai dos
carimbos (ativo = `cleared_at` nulo; reconhecido = `acked_at` preenchido). Um
índice único parcial garante no máximo uma ocorrência ativa por tag e nível.

## Configuração

Todas as variáveis estão em `.env.example`. Elas são validadas na subida: se
alguma estiver inválida (ex: `SIM_INTERVAL_MS=abc`), a API não sobe e lista os
problemas.

| Variável                   | Padrão                     | Descrição                                                         |
| -------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `DB_HOST`                  | `localhost`                | Host do banco                                                     |
| `DB_PORT`                  | `5432`                     | Porta do banco (o `.env.example` usa 5433, a do `docker compose`) |
| `DB_USER`                  | `scada`                    | Usuário                                                           |
| `DB_PASSWORD`              | `scada`                    | Senha                                                             |
| `DB_NAME`                  | `scada`                    | Nome do banco                                                     |
| `DB_MIGRATIONS_RUN`        | `true`                     | Aplica as migrations pendentes na subida                          |
| `PORT`                     | `3000`                     | Porta da API                                                      |
| `INGEST_FLUSH_MS`          | `2000`                     | Intervalo de gravação do buffer de ingestão                       |
| `INGEST_BUFFER_MAX`        | `100000`                   | Teto do buffer (banco fora: descarta as amostras mais antigas)    |
| `LIVE_FLUSH_MS`            | `200`                      | Janela de agrupamento do tempo real (0 = imediato)                |
| `LIVE_MAX_SAMPLES_PER_TAG` | `100`                      | Máximo de amostras por tag em cada envio do tempo real            |
| `ALARM_HYSTERESIS_PCT`     | `2`                        | Banda morta padrão (% do limite), para tag sem `alarmDeadband`    |
| `RETENTION_ENABLED`        | `false`                    | Apaga medições antigas (política de retenção do TimescaleDB)      |
| `RETENTION_DAYS`           | `90`                       | Prazo da retenção, em dias (mínimo 8)                             |
| `AUTH_ENABLED`             | `false`                    | Liga o login                                                      |
| `AUTH_USER`                | `operador`                 | Usuário                                                           |
| `AUTH_PASSWORD`            | vazio                      | Senha (obrigatória com o login ligado)                            |
| `AUTH_SECRET`              | vazio                      | Segredo que assina os tokens (32+ caracteres aleatórios)          |
| `SIM_ENABLED`              | `true`                     | Liga o simulador de senoides                                      |
| `SIM_INTERVAL_MS`          | `1000`                     | Intervalo do simulador                                            |
| `MQTT_ENABLED`             | `false`                    | Liga a fonte MQTT (`true` no `.env.example`)                      |
| `MQTT_URL`                 | `mqtt://localhost:1883`    | Broker (`mqtt`, `mqtts`, `tcp`, `ws` ou `wss`)                    |
| `MQTT_USERNAME`            | vazio                      | Usuário do broker (vazio = sem autenticação)                      |
| `MQTT_PASSWORD`            | vazio                      | Senha do broker                                                   |
| `MODBUS_ENABLED`           | `false`                    | Liga a fonte Modbus TCP                                           |
| `MODBUS_HOST`              | `localhost`                | Equipamento Modbus                                                |
| `MODBUS_PORT`              | `502`                      | Porta (o simulador usa 5020)                                      |
| `MODBUS_POLL_MS`           | `1000`                     | Intervalo entre ciclos de leitura                                 |
| `MODBUS_TIMEOUT_MS`        | `2000`                     | Timeout de cada request                                           |
| `OPCUA_ENABLED`            | `false`                    | Liga a fonte OPC UA                                               |
| `OPCUA_ENDPOINT`           | `opc.tcp://localhost:4840` | Servidor OPC UA                                                   |
| `OPCUA_SAMPLING_MS`        | `1000`                     | Amostragem e intervalo de publicação da assinatura                |
| `OPCUA_PKI_DIR`            | `.opcua-pki`               | Pasta dos certificados do cliente OPC UA                          |

## Docker

A API também roda em container, junto do banco e do broker:

```bash
docker compose --profile app up -d --build
```

- A imagem (`Dockerfile`) tem duas etapas: a primeira compila o TypeScript; a
  segunda leva só o JavaScript, o dashboard e as dependências de produção, e
  roda com usuário sem privilégios e _healthcheck_ em `/api/health`.
- O container lê o `.env`, trocando o endereço do banco e do broker pelos
  nomes da rede do Docker. Simuladores rodando no PC ficam em
  `host.docker.internal` (ex: `MODBUS_HOST=host.docker.internal`).
- Os certificados do cliente OPC UA ficam no volume `opcua_pki`.
- Pare o `npm run start:dev` antes: os dois usam a porta 3000.

## Migrations

O schema é versionado em `src/database/migrations` (TypeORM). Com
`DB_MIGRATIONS_RUN=true` (padrão), a API aplica as pendentes ao subir.

```bash
npm run migration:show                                 # aplicadas e pendentes
npm run migration:run                                  # aplica as pendentes
npm run migration:revert                               # desfaz a última
npm run migration:create src/database/migrations/Nome  # cria uma nova, vazia
```

Bancos criados pelo antigo `db/init.sql` são adotados sem alteração: a
migration inicial é idempotente e apenas se registra.

## Testes e qualidade de código

```bash
npm test            # testes (Jest)
npm run test:cov    # testes + relatório de cobertura em coverage/
npm run lint        # ESLint (typescript-eslint, regras com checagem de tipos)
npm run format      # formata com Prettier
```

As fontes são testadas contra servidores reais em memória, sem Docker: um
broker MQTT (aedes), um servidor Modbus TCP (`ServerTCP` do modbus-serial) e
um servidor OPC UA (node-opcua-server), inclusive com o servidor fora do ar na
subida e caindo no meio da operação.

## Estrutura do código

```
docker-compose.yml        TimescaleDB e Mosquitto (+ API e Adminer, opcionais)
Dockerfile                imagem da API
docker/mosquitto/         configuração do broker MQTT de desenvolvimento
public/                   dashboard (sem build)
  index.html, login.html
  css/dashboard.css
  js/                     um módulo por tela (dashboard, synoptic, alarms-history,
                          metrics, config), login e acesso à API (auth.js)
tools/
  modbus-sim.ts           simulador de CLP Modbus TCP (npm run sim:modbus)
  opcua-sim.ts            simulador de servidor OPC UA (npm run sim:opcua)
jest.esm-transformer.cjs  converte dependências só-ESM para o Jest
src/
  main.ts                 bootstrap: prefixo /api, dashboard estático, CORS, shutdown hooks
  app.module.ts           configuração, conexão com o banco, módulos
  app.controller.ts       GET /api e GET /api/health
  auth/                   login, token, guarda global (@Public() libera uma rota)
  common/                 utilitários (mensagens de erro, log com limite, filtro de erros do banco)
  config/
    env.validation.ts     validação e conversão das variáveis de ambiente
  database/
    typeorm.config.ts     opções do TypeORM (comuns à API e ao CLI)
    data-source.ts        DataSource do CLI de migrations
    migrations/           schema versionado
  ingestion/              núcleo comum a todas as fontes
    acquisition-source.ts   contrato que toda fonte implementa
    ingestion.service.ts    registro e ciclo de vida das fontes, normalização
    ingestion-buffer.ts     buffer limitado e gravação em lote
    sources.controller.ts   GET /sources
    sample.ts               formatos SampleInput (da fonte) e Sample (do banco)
  sources/                fontes de aquisição (uma pasta por protocolo)
    simulator/              senoides de teste
    mqtt/                   payloads e validação de tópico; fonte MQTT
    modbus/                 endereços, agrupamento de leituras; fonte Modbus
    opcua/                  NodeId, StatusCode, Variant; fonte OPC UA
  tags/                   cadastro de tags (DTOs, regras entre campos)
  measurements/           gravação em lote, latest e history
  alarms/                 motor de alarmes (alarm-rules.ts: regras puras)
  realtime/
    live-feed.service.ts  agrupa as amostras por tag (comum ao SSE e ao WebSocket)
    live.gateway.ts       WebSocket (socket.io /live)
  dashboard/              rotas do dashboard e o SSE
  metrics/                métricas, estatísticas do banco, retenção, exportação CSV
```

## CommonJS, ESM e o node-opcua

O Node.js tem dois sistemas de módulos: o **CommonJS** (`require` e
`module.exports`), histórico, e os **ES Modules** (`import` e `export`), o
padrão da linguagem. Este projeto compila para CommonJS (`"module":
"commonjs"` no `tsconfig.json`), que é o padrão do NestJS.

A partir da versão 2.184, o node-opcua passou a ser publicado só em ESM. Por
isso:

- O node-opcua está **fixado na 2.183.x** (em `package.json`, sem `^`), a
  última linha com o pacote principal em CommonJS. Dois subpacotes dela
  (`node-opcua-transport` e `node-opcua-crypto`) já são ESM.
- Na execução, isso não é problema: desde o Node 22.12, um `require` comum
  consegue carregar um módulo ESM. É um dos motivos do requisito de Node
  22.13+.
- O **Jest** roda em CommonJS com o seu próprio carregador de módulos, que não
  faz essa ponte. O `jest.esm-transformer.cjs` converte para CommonJS, só nos
  testes, os pacotes listados em `transformIgnorePatterns` (no
  `package.json`).

Para atualizar o node-opcua para a 2.184 ou mais nova, **não é preciso migrar
o projeto inteiro para ESM**: num teste isolado, o `require` do Node 24
carregou a 2.186 (com os 51 subpacotes em ESM) sem problemas. O trabalho fica
nos testes: ampliar a lista do transformador para todos os pacotes
`node-opcua-*` (e as dependências ESM deles), ou trocar o Jest por um
executor de testes com suporte nativo a ESM, como o Vitest. Migrar o projeto
todo para ESM (`"type": "module"` no `package.json`, `"module": "nodenext"`
no `tsconfig.json`, extensão `.js` nos imports relativos) é uma mudança maior,
que só se justifica se outras dependências passarem a exigir.

## Próximos passos

- **Usuários e perfis.** Hoje há um único usuário (`AUTH_USER`), sem
  distinção entre quem só acompanha e quem reconhece alarmes ou altera tags.
  O passo seguinte é guardar usuários no banco (senha com hash, ex: argon2) e
  criar perfis.
- **CORS e HTTPS.** O CORS está liberado para qualquer origem (o token vai no
  cabeçalho, não em cookie, então outro site não consegue usá-lo sozinho), e
  a API fala HTTP puro. Fora do laboratório: restringir as origens e pôr um
  proxy com HTTPS na frente.
- **Atualizar o node-opcua** para a linha 2.184+, conforme a seção anterior.
