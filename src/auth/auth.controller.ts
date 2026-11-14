import {
  BadRequestException,
  Body,
  ForbiddenException,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { ChangePasswordDto } from '../users/dto/user.dto';
import { UsersService } from '../users/users.service';
import { CurrentUser } from './auth.guard';
import { AuthService, AuthUser, TOKEN_TTL_MS } from './auth.service';
import { Public } from './public.decorator';

export class LoginDto {
  @IsString()
  @MaxLength(100)
  username!: string;

  @IsString()
  @MaxLength(200)
  password!: string;
}

/** Senhas erradas toleradas por IP e usuário numa janela. */
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
   * Devolve um token válido por 24 h. Depois de MAX_LOGIN_ATTEMPTS senhas
   * erradas num minuto para o mesmo usuário, vindas do mesmo IP, responde 429:
   * adivinhar a senha por tentativa e erro fica inviável. A chave inclui o
   * usuário porque, atrás de um proxy ou do Docker, todos chegam com o mesmo
   * IP, e os erros de um bloqueariam o login de todos. O controle é em
   * memória: basta para uma instância; com várias, precisaria de um
   * armazenamento compartilhado.
   */
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Ip() ip: string) {
    return this.limited(`${ip}|${body.username}`, () =>
      this.auth.login(body.username, body.password),
    );
  }

  /** Quem está autenticado, com o perfil (401 sem token válido). */
  @Get('me')
  me(@CurrentUser() user?: AuthUser) {
    return user;
  }

  /**
   * Troca a própria senha, exigindo a atual (mesmo limite de tentativas do
   * login). Os tokens anteriores deixam de valer; devolve um novo para a
   * sessão que fez a troca continuar.
   */
  @Post('password')
  @HttpCode(200)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @Ip() ip: string,
    @CurrentUser() user?: AuthUser,
  ) {
    if (!this.auth.isEnabled() || !user) {
      throw new BadRequestException('A autenticação está desligada.');
    }
    return this.limited(`${ip}|${user.username}`, async () => {
      await this.users.changePassword(user.username, body.current, body.password);
      return { token: this.auth.sign(user.username, Date.now() + TOKEN_TTL_MS) };
    });
  }

  /** Executa `fn`, contando as senhas erradas (401/403) da chave; bloqueada, responde 429. */
  private async limited<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const bucket = this.attempts.get(key);
    if (bucket && bucket.resetAt >= now && bucket.count >= MAX_LOGIN_ATTEMPTS) {
      const wait = Math.ceil((bucket.resetAt - now) / 1000);
      throw new HttpException(
        `Muitas tentativas de login. Aguarde ${wait} s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof UnauthorizedException || err instanceof ForbiddenException) {
        this.recordFailure(key, now);
      }
      throw err;
    }
  }

  private recordFailure(key: string, now: number) {
    if (this.attempts.size > 10_000) {
      for (const [k, b] of this.attempts) if (b.resetAt < now) this.attempts.delete(k);
      // Ainda cheio (enxurrada de nomes diferentes): recomeça, para a memória não crescer.
      if (this.attempts.size > 10_000) this.attempts.clear();
    }
    const bucket = this.attempts.get(key);
    if (!bucket || bucket.resetAt < now) {
      this.attempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    } else {
      bucket.count++;
    }
  }
}
