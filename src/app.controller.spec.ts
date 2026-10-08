import { ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppController } from './app.controller';

describe('AppController.health', () => {
  it('responde ok quando o banco responde', async () => {
    const ds = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const controller = new AppController(ds as unknown as DataSource);
    await expect(controller.health()).resolves.toEqual({ status: 'ok', db: 'up' });
  });

  it('responde 503 quando o banco está fora', async () => {
    const ds = { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const controller = new AppController(ds as unknown as DataSource);
    await expect(controller.health()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
