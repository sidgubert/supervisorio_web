import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.enableCors();
  // Faz o Nest chamar onModuleDestroy no SIGTERM/SIGINT, para as fontes
  // pararem e o buffer pendente ser gravado antes de o processo encerrar.
  app.enableShutdownHooks();

  // A API fica sob /api; o resto é o dashboard (arquivos estáticos).
  app.setGlobalPrefix('api');
  const root = join(__dirname, '..');
  app.useStaticAssets(join(root, 'public'), { index: 'index.html' });
  // Chart.js servido pela própria API: o dashboard funciona sem internet.
  app.useStaticAssets(join(root, 'node_modules', 'chart.js', 'dist'), {
    prefix: '/vendor/chart.js',
  });

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`TALOS em http://localhost:${port} (API em /api)`);
}

void bootstrap();
