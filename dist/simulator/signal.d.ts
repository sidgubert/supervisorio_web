export interface SignalSpec {
    tag: string;
    mean: number;
    amplitude: number;
    periodSec: number;
    noise: number;
    unit?: string;
}
export interface Sample {
    time: Date;
    tag: string;
    value: number;
    quality: number;
    source: string;
}
export declare function sampleSignal(spec: SignalSpec, atMs: number): number;
export declare function generateSample(spec: SignalSpec, at?: Date): Sample;
export declare const DEFAULT_SIGNALS: SignalSpec[];
