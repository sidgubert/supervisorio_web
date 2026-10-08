import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from './auth/public.decorator';

@Controller()
export class AppController {
  constructor(private readonly dataSource: DataSource) {}

  /** GET /api: índice dos endpoints. */
  @Get()
  root() {
    return {
      name: 'talos',
      status: 'ok',
      endpoints: {
        health: 'GET /api/health',
        auth: 'GET /api/auth/status, POST /api/auth/login, GET /api/auth/me',
        dashboard: 'GET /api/dashboard/tags, GET /api/dashboard/alarms, SSE /api/dashboard/stream',
        tags: 'GET|POST /api/tags, GET|PATCH|DELETE /api/tags/:tag',
        latest: 'GET /api/measurements/:tag/latest?limit=100',
        history: 'GET /api/measurements/:tag/history?minutes=|from=&to=&bucket=auto|raw|1m|1h',
        alarms:
          'GET /api/alarms, GET /api/alarms/history, POST /api/alarms/:id/ack, POST /api/alarms/ack-all',
        sources: 'GET /api/sources',
        metrics:
          'GET /api/metrics/overview, /storage, /protocols, /export?minutes=60&format=csv|json',
        live: 'socket.io, namespace /live (subscribe { tags? })',
      },
    };
  }

  /** Saudável só se o banco responder; senão 503 (útil para Docker/orquestradores). */
  @Public()
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
