import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  // Faz o Nest chamar onModuleDestroy no SIGTERM/SIGINT, para o simulador
  // gravar o buffer pendente antes de o processo encerrar.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const port = Number(config.get('PORT', 3000));
  await app.listen(port);
  console.log(`API em http://localhost:${port}`);
}

bootstrap();
