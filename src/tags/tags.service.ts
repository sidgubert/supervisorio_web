import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, Subject } from 'rxjs';
import { Repository } from 'typeorm';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { checkTagLimits, TagLimits } from './tag-rules';
import { Tag } from './tag.entity';

/**
 * Confere o `address` de uma tag no formato da fonte (ex: tópico MQTT,
 * registrador Modbus). Devolve a mensagem de erro, ou undefined se estiver ok.
 */
export type AddressValidator = (address: string | null | undefined) => string | undefined;

export interface TagChange {
  type: 'created' | 'updated' | 'deleted';
  /** Estado atual (no `deleted`, o último antes de apagar). */
  tag: Tag;
  /** Estado anterior, no `updated`. */
  previous?: Tag;
}

@Injectable()
export class TagsService {
  private readonly validators = new Map<string, AddressValidator>();
  private readonly changeSubject = new Subject<TagChange>();

  /**
   * Alterações no cadastro, para as fontes de aquisição se reconfigurarem
   * sem reiniciar a API.
   */
  readonly changes$: Observable<TagChange> = this.changeSubject.asObservable();

  constructor(
    @InjectRepository(Tag)
    private readonly repo: Repository<Tag>,
  ) {}

  /**
   * Cada fonte registra (no seu onModuleInit) como validar os endereços das
   * suas tags; assim um endereço errado é recusado já no POST/PATCH.
   */
  registerAddressValidator(source: string, validator: AddressValidator) {
    this.validators.set(source, validator);
  }

  findAll(): Promise<Tag[]> {
    return this.repo.find({ order: { tag: 'ASC' } });
  }

  async findOne(tag: string): Promise<Tag> {
    const found = await this.repo.findOneBy({ tag });
    if (!found) throw new NotFoundException(`Tag "${tag}" não cadastrada`);
    return found;
  }

  /** Tags habilitadas de uma fonte (o que ela deve adquirir). */
  findEnabledBySource(source: string): Promise<Tag[]> {
    return this.repo.find({ where: { source, enabled: true }, order: { tag: 'ASC' } });
  }

  async create(dto: CreateTagDto): Promise<Tag> {
    if (await this.repo.existsBy({ tag: dto.tag })) {
      throw new ConflictException(`Tag "${dto.tag}" já cadastrada`);
    }
    this.validate(dto);
    await this.repo.insert(this.repo.create(dto));
    const created = await this.findOne(dto.tag);
    this.changeSubject.next({ type: 'created', tag: created });
    return created;
  }

  async update(tag: string, dto: UpdateTagDto): Promise<Tag> {
    const previous = await this.findOne(tag);
    this.validate({ ...previous, ...dto });
    if (Object.keys(dto).length > 0) await this.repo.update({ tag }, dto);
    const updated = await this.findOne(tag);
    this.changeSubject.next({ type: 'updated', tag: updated, previous });
    return updated;
  }

  async remove(tag: string): Promise<void> {
    const existing = await this.findOne(tag);
    await this.repo.delete({ tag });
    this.changeSubject.next({ type: 'deleted', tag: existing });
  }

  /** Regras entre campos + endereço no formato da fonte. */
  private validate(t: TagLimits & { source?: string | null; address?: string | null }) {
    const errors = checkTagLimits(t);
    const validator = t.source ? this.validators.get(t.source) : undefined;
    const addressError = validator?.(t.address);
    if (addressError) errors.push(`address: ${addressError}`);
    if (errors.length > 0) throw new BadRequestException(errors);
  }
}
