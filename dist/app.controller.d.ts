export declare class AppController {
    root(): {
        name: string;
        status: string;
        phase: number;
        endpoints: {
            health: string;
            latest: string;
        };
    };
    health(): {
        status: string;
    };
}
