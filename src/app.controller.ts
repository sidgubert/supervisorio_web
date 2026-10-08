import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Controller()
export class AppController {
  constructor(private readonly dataSource: DataSource) {}

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

  /** Saudável só se o banco responder; senão 503 (útil para Docker/orquestradores). */
  @Get('health')
  async health() {
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', db: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }
  }
}
