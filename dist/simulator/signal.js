"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SIGNALS = void 0;
exports.sampleSignal = sampleSignal;
exports.generateSample = generateSample;
function sampleSignal(spec, atMs) {
    const omega = (2 * Math.PI) / (spec.periodSec * 1000);
    const base = spec.mean + spec.amplitude * Math.sin(omega * atMs);
    const noise = (Math.random() * 2 - 1) * spec.noise;
    return Number((base + noise).toFixed(3));
}
function generateSample(spec, at = new Date()) {
    return {
        time: at,
        tag: spec.tag,
        value: sampleSignal(spec, at.getTime()),
        quality: 192,
        source: 'sim',
    };
}
exports.DEFAULT_SIGNALS = [
    { tag: 'TIC-101.PV', mean: 75, amplitude: 8, periodSec: 60, noise: 0.4, unit: '°C' },
    { tag: 'PIC-201.PV', mean: 4.2, amplitude: 0.6, periodSec: 90, noise: 0.05, unit: 'bar' },
    { tag: 'FIC-301.PV', mean: 120, amplitude: 25, periodSec: 45, noise: 1.5, unit: 'm³/h' },
    { tag: 'LIC-401.PV', mean: 60, amplitude: 15, periodSec: 120, noise: 0.8, unit: '%' },
];
//# sourceMappingURL=signal.js.map