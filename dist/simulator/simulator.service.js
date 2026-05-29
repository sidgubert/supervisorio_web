"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var SimulatorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimulatorService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const measurements_service_1 = require("../measurements/measurements.service");
const signal_1 = require("./signal");
let SimulatorService = SimulatorService_1 = class SimulatorService {
    constructor(config, measurements) {
        this.config = config;
        this.measurements = measurements;
        this.logger = new common_1.Logger(SimulatorService_1.name);
        this.buffer = [];
    }
    onModuleInit() {
        const enabled = this.config.get('SIM_ENABLED', 'true') === 'true';
        if (!enabled) {
            this.logger.log('Simulador desabilitado (SIM_ENABLED=false).');
            return;
        }
        const interval = Number(this.config.get('SIM_INTERVAL_MS', 1000));
        const flush = Number(this.config.get('SIM_BATCH_FLUSH_MS', 2000));
        this.genTimer = setInterval(() => this.generate(), interval);
        this.flushTimer = setInterval(() => this.flush(), flush);
        this.logger.log(`Simulador ativo: ${signal_1.DEFAULT_SIGNALS.length} tags, gerando a cada ${interval}ms, gravando a cada ${flush}ms.`);
    }
    onModuleDestroy() {
        if (this.genTimer)
            clearInterval(this.genTimer);
        if (this.flushTimer)
            clearInterval(this.flushTimer);
    }
    generate() {
        const now = new Date();
        for (const spec of signal_1.DEFAULT_SIGNALS) {
            this.buffer.push((0, signal_1.generateSample)(spec, now));
        }
    }
    async flush() {
        if (this.buffer.length === 0)
            return;
        const batch = this.buffer;
        this.buffer = [];
        try {
            const n = await this.measurements.insertBatch(batch);
            this.logger.debug(`Gravadas ${n} amostras.`);
        }
        catch (err) {
            this.buffer.unshift(...batch);
            this.logger.error(`Falha ao gravar lote: ${err.message}`);
        }
    }
};
exports.SimulatorService = SimulatorService;
exports.SimulatorService = SimulatorService = SimulatorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService,
        measurements_service_1.MeasurementsService])
], SimulatorService);
//# sourceMappingURL=simulator.service.js.map