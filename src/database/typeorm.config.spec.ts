import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { buildDataSourceOptions } from './typeorm.config';

describe('buildDataSourceOptions', () => {
  const options = buildDataSourceOptions({
    DB_HOST: 'h',
    DB_PORT: 1234,
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    DB_NAME: 'd',
  });

  it('usa as variáveis de conexão e nunca sincroniza o schema', () => {
    expect(options).toMatchObject({
      type: 'postgres',
      host: 'h',
      port: 1234,
      username: 'u',
      password: 'p',
      database: 'd',
      synchronize: false,
    });
  });

  it('aponta para a pasta de migrations, que existe e não está vazia', () => {
    const [pattern] = options.migrations as string[];
    const dir = pattern.slice(0, pattern.lastIndexOf('*') - 1);
    expect(dir).toBe(join(__dirname, 'migrations'));
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
