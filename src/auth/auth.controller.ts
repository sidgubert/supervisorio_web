import {
  BadRequestException,
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
import { ChangePasswordDto } from '../users/dto/user.dto';
import { UsersService } from '../users/users.service';
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

  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

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
  async login(@Body() body: LoginDto, @Ip() ip: string) {
    this.checkRateLimit(ip);
    return this.auth.login(body.username, body.password);
  }

  /** Quem está autenticado, com o perfil (401 sem token válido). */
  @Get('me')
  me(@CurrentUser() user?: AuthUser) {
    return user;
  }

  /** Troca a própria senha, exigindo a atual (mesmo limite de tentativas do login). */
  @Post('password')
  @HttpCode(204)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Ip() ip: string,
    @CurrentUser() user?: AuthUser,
  ) {
    this.checkRateLimit(ip);
    if (!this.auth.isEnabled() || !user) {
      throw new BadRequestException('A autenticação está desligada.');
    }
    await this.users.changePassword(user.username, body.current, body.password);
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
