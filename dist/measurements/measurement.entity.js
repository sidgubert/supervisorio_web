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
Object.defineProperty(exports, "__esModule", { value: true });
exports.Measurement = void 0;
const typeorm_1 = require("typeorm");
let Measurement = class Measurement {
};
exports.Measurement = Measurement;
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: 'timestamptz' }),
    __metadata("design:type", Date)
], Measurement.prototype, "time", void 0);
__decorate([
    (0, typeorm_1.PrimaryColumn)({ type: 'text' }),
    __metadata("design:type", String)
], Measurement.prototype, "tag", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'double precision' }),
    __metadata("design:type", Number)
], Measurement.prototype, "value", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'smallint', default: 192 }),
    __metadata("design:type", Number)
], Measurement.prototype, "quality", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", String)
], Measurement.prototype, "source", void 0);
exports.Measurement = Measurement = __decorate([
    (0, typeorm_1.Entity)('measurements')
], Measurement);
//# sourceMappingURL=measurement.entity.js.map