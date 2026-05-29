"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const app_controller_1 = require("./app.controller");
const measurement_entity_1 = require("./measurements/measurement.entity");
const measurements_module_1 = require("./measurements/measurements.module");
const simulator_module_1 = require("./simulator/simulator.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        controllers: [app_controller_1.AppController],
        imports: [
            config_1.ConfigModule.forRoot({ isGlobal: true }),
            typeorm_1.TypeOrmModule.forRootAsync({
                inject: [config_1.ConfigService],
                useFactory: (config) => ({
                    type: 'postgres',
                    host: config.get('DB_HOST', 'localhost'),
                    port: Number(config.get('DB_PORT', 5432)),
                    username: config.get('DB_USER', 'scada'),
                    password: config.get('DB_PASSWORD', 'scada'),
                    database: config.get('DB_NAME', 'scada'),
                    entities: [measurement_entity_1.Measurement],
                    synchronize: false,
                }),
            }),
            measurements_module_1.MeasurementsModule,
            simulator_module_1.SimulatorModule,
        ],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map