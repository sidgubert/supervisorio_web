import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { Env } from './config/env.validation';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Faz o Nest chamar onModuleDestroy no SIGTERM/SIGINT, para o simulador
  // gravar o buffer pendente antes de o processo encerrar.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  console.log(`API em http://localhost:${port}`);
}

void bootstrap();
