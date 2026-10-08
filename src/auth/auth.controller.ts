import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Post,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { CurrentUser } from './auth.guard';
import { AuthService, AuthUser } from './auth.service';
import { Public } from './public.decorator';

export class LoginDto {
  @IsString()
  @MaxLength(100)
  username!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}

/** Tentativas de login por IP numa janela. */
export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 60_000;

@Controller('auth')
export class AuthController {
  private readonly attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly auth: AuthService) {}

  /** Se a autenticação está ligada (o frontend decide se mostra o login). */
  @Public()
  @Get('status')
  status() {
    return { enabled: this.auth.isEnabled() };
  }

  /**
   * Devolve um token válido por 24 h. Limitado a MAX_LOGIN_ATTEMPTS tentativas
   * por IP por minuto (429 acima disso), o que torna inviável adivinhar a
   * senha por tentativa e erro. O controle é em memória: basta para uma
   * instância; com várias, precisaria de um armazenamento compartilhado.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto, @Ip() ip: string) {
    this.checkRateLimit(ip);
    return this.auth.login(body.username, body.password);
  }

  /** Quem está autenticado (401 sem token válido). */
  @Get('me')
  me(@CurrentUser() user?: AuthUser) {
    return user;
  }

  private checkRateLimit(ip: string) {
    const now = Date.now();
    if (this.attempts.size > 10_000) {
      for (const [key, b] of this.attempts) if (b.resetAt < now) this.attempts.delete(key);
    }
    const bucket = this.attempts.get(ip);
    if (!bucket || bucket.resetAt < now) {
      this.attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      return;
    }
    bucket.count++;
    if (bucket.count > MAX_LOGIN_ATTEMPTS) {
      const wait = Math.ceil((bucket.resetAt - now) / 1000);
      throw new HttpException(
        `Muitas tentativas de login. Aguarde ${wait} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
