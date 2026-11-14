import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { UpdateUserDto } from './user.dto';

/** O mesmo ValidationPipe registrado no AppModule. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true });
const body: ArgumentMetadata = { type: 'body', metatype: UpdateUserDto };

describe('UpdateUserDto', () => {
  it('active aceita booleano e chega ao serviço como veio', async () => {
    await expect(pipe.transform({ active: false }, body)).resolves.toEqual({ active: false });
    await expect(pipe.transform({ active: true }, body)).resolves.toEqual({ active: true });
  });

  // Convertido com Boolean(), o texto "false" virava true e ativava a conta.
  it.each(['false', 'true', '0', 0, 1])('active recusa %p (não é booleano)', async (value) => {
    await expect(pipe.transform({ active: value }, body)).rejects.toThrow(BadRequestException);
  });
});
