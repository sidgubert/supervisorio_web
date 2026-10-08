# SCADA-EDU — Backend (Fase 1)

Sistema supervisório web educacional 4.0. Esqueleto da **Fase 1**: banco de
séries temporais, backend NestJS e o "Teste de Carga Simulado" (gerador de
senoides que persiste continuamente no banco).

## Stack desta fase

- **TimescaleDB** (extensão do PostgreSQL) — banco de séries temporais.
- **NestJS** sobre **Express** (adaptador HTTP padrão do Nest).
- **TypeORM** + driver `pg` — acesso ao banco.
- **TypeScript** — tipagem estática das variáveis de processo.

## Pré-requisitos

- Docker + Docker Compose
- Node.js 20+

## Passo a passo

```bash
# 1. Copie as variáveis de ambiente
cp .env.example .env

# 2. Suba o banco
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
docker-compose.yml      TimescaleDB (+ Adminer opcional)
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
    migrations/         schema versionado (hypertable, tags, ...)
  measurements/         entidade + service (insert em lote, consulta)
  tags/                 cadastro de tags (unidade, faixa, limites de alarme)
  ingestion/            núcleo comum a todas as fontes de dados
    acquisition-source.ts  contrato que toda fonte implementa
    ingestion.service.ts   registro/ciclo de vida das fontes + normalização
    ingestion-buffer.ts    buffer limitado + gravação em lote no banco
    sample.ts              formatos SampleInput (da fonte) e Sample (do banco)
  simulator/
    signal.ts           geração de senoides (lógica pura, testável)
    simulator.source.ts fonte "sim": emite as senoides a cada SIM_INTERVAL_MS
```

## Arquitetura de ingestão

```
SimulatorSource ─┐
(MqttSource)    ─┼─ emit(SampleInput[]) ─► IngestionService ─► IngestionBuffer ─► MeasurementsService ─► TimescaleDB
(ModbusSource)  ─┤                         normaliza + valida   limitado, 1 flush   insert em blocos
(OpcUaSource)   ─┘                                              por vez             numa transação
```

- Uma fonte implementa `AcquisitionSource` (`name`, `start(emit)`, `stop()`)
  e se registra no `IngestionService` no seu `onModuleInit`. Ela não conhece
  buffer nem banco: só converte o payload do protocolo para `SampleInput`.
- O `IngestionService` aplica a qualidade padrão (192 = Good), grava o nome da
  fonte em `source` e descarta amostras inválidas (tag vazia, valor
  NaN/Infinity, data inválida).
- Na subida, as fontes são iniciadas; uma que falhe não derruba as outras. No
  encerramento, as fontes param **antes** de o buffer ser esvaziado no banco.

## Configuração

Todas as variáveis estão em `.env.example`. Elas são validadas na subida:
se alguma estiver inválida (ex: `SIM_INTERVAL_MS=abc`), a API não sobe e
lista os problemas.

`INGEST_BUFFER_MAX` limita o buffer em memória da ingestão: se o banco ficar
fora do ar, as amostras mais antigas são descartadas (com aviso no log) em
vez de a memória crescer sem limite.

## Endpoints

- `GET /health` — `200 {status:'ok', db:'up'}` ou `503` se o banco não responder.
- `GET /measurements/:tag/latest?limit=100` — últimas amostras da tag
  (`limit` entre 1 e 5000).
- `GET /tags` — tags cadastradas.
- `GET /tags/:tag` — uma tag (`404` se não cadastrada).

## Modelo de dados

Tabela única `measurements` em formato _long_ (uma linha por amostra de cada
tag): `time, tag, value, quality, source`. Esse formato evita alterar o schema
ao adicionar novas tags e é o recomendado para hypertables.

O campo `source` (`sim` por enquanto) já antecipa a Fase 2: distinguir a
origem dos dados entre `mqtt`, `modbus`, `opcua`.

A tabela `tags` guarda os metadados de cada variável: descrição, unidade,
faixa de engenharia (`eng_min`/`eng_max`), limites de alarme
(`alarm_ll`/`alarm_l`/`alarm_h`/`alarm_hh`, com ordem garantida por CHECK) e
onde ela é adquirida (`source`/`address`). As tags do simulador já vêm
cadastradas. Não há FK de `measurements.tag` para `tags`, de propósito: uma
amostra de tag não cadastrada faria o lote inteiro falhar e travaria o buffer
de ingestão.

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

- Fontes reais via MQTT, Modbus TCP e OPC UA: cada uma é um novo
  `AcquisitionSource` (ver `simulator.source.ts` como modelo), convertendo o
  payload do protocolo para `SampleInput`.
