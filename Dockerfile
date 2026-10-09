# Imagens do TALOS.
#
#   docker compose --profile app up -d --build          a API (backend + dashboard)
#   docker compose --profile simulators up -d --build   os simuladores de equipamentos
#
# A etapa build compila o TypeScript (com as dependências de desenvolvimento).
# A imagem da API (última etapa, a padrão) leva só o JavaScript compilado, o
# dashboard e as dependências de produção. A dos simuladores roda os scripts
# de tools/ com ts-node.

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- simuladores (Modbus, OPC UA, MQTT) ----
FROM build AS simulators
COPY tools ./tools
# Pasta do certificado do simulador OPC UA (volume), gravável pelo usuário node.
RUN mkdir -p /pki && chown node:node /pki
USER node
CMD ["node", "-r", "ts-node/register/transpile-only", "tools/modbus-sim.ts"]

# ---- API ----
FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Pasta dos certificados do cliente OPC UA (OPCUA_PKI_DIR), gravável pelo
# usuário sem privilégios que roda a API.
RUN mkdir -p .opcua-pki && chown node:node .opcua-pki
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health > /dev/null || exit 1
CMD ["node", "dist/main.js"]
