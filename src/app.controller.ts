import { Controller, Get } from '@nestjs/common';

@Controller()
export class AppController {
  @Get()
  root() {
    return {
      name: 'scada-edu',
      status: 'ok',
      phase: 1,
      endpoints: {
        health: 'GET /health',
        latest: 'GET /measurements/:tag/latest?limit=100',
      },
    };
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
