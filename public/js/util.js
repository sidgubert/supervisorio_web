/**
 * Utilitários do dashboard.
 *
 * esc(): todo texto que vem da API e entra num template HTML passa por aqui.
 * Descrição e unidade de uma tag são editáveis por qualquer operador; sem o
 * escape, um texto como <img src=x onerror=...> executaria script na tela dos
 * outros (XSS armazenado).
 */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export function fmtTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('pt-BR') : '—';
}

export function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

export function fmtNum(value, digits = 3) {
  if (value === null || value === undefined || value === '') return '—';
  return Number(value).toLocaleString('pt-BR', { maximumFractionDigits: digits });
}

export function fmtDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min ${s} s` : `${s} s`;
}

export const LEVEL_LABEL = { HH: 'Muito alto', H: 'Alto', L: 'Baixo', LL: 'Muito baixo' };

export const STATE_LABEL = {
  ACTIVE_UNACKED: 'Ativo, não reconhecido',
  ACTIVE_ACKED: 'Ativo, reconhecido',
  CLEARED_UNACKED: 'Normalizado, não reconhecido',
  CLOSED: 'Encerrado',
};

export const ROLE_LABEL = {
  viewer: 'Visualizador',
  operator: 'Operador',
  engineer: 'Engenheiro',
  admin: 'Administrador',
};

/** Mensagem de erro de uma resposta da API (a validação devolve uma lista). */
export async function apiError(res) {
  try {
    const body = await res.json();
    return Array.isArray(body.message)
      ? body.message.join('; ')
      : String(body.message ?? GENERIC_ERROR);
  } catch {
    return GENERIC_ERROR;
  }
}

/** Resposta sem mensagem legível (servidor fora, proxy): texto sem código cru. */
const GENERIC_ERROR = 'Não foi possível concluir. Tente de novo em instantes.';

// ---------------------------------------------------------------- formulários

/** Mensagem de um campo inválido, ou '' se está ok. Diz o que fazer, sem culpar. */
function fieldError(input) {
  const value = input.value;
  if (input.required && value.trim() === '') return 'Preencha este campo.';
  if (value && input.minLength > 0 && value.length < input.minLength) {
    return `Use ao menos ${input.minLength} caracteres.`;
  }
  return '';
}

let errorSeq = 0;

function setFieldError(input, message) {
  let el = input.nextElementSibling;
  if (!el?.classList.contains('field-error')) {
    if (!message) return;
    el = document.createElement('span');
    el.className = 'field-error';
    el.id = `field-error-${++errorSeq}`;
    input.insertAdjacentElement('afterend', el);
  }
  el.textContent = message;
  el.hidden = !message;
  if (message) {
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', el.id);
  } else {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  }
}

/**
 * Validação no próprio campo, no lugar dos balões do navegador: o erro aparece
 * quando o campo perde o foco (nunca enquanto se digita pela primeira vez) e
 * some assim que o campo volta a ser editado. O botão de enviar fica sempre
 * clicável. Devolve a função que valida tudo no envio: mostra os erros, leva
 * o foco ao primeiro e responde se o formulário pode seguir.
 */
export function bindValidation(form) {
  form.noValidate = true;
  const fields = () => [...form.querySelectorAll('input, select')];
  form.addEventListener('focusout', (e) => {
    if (e.target.matches?.('input, select')) setFieldError(e.target, fieldError(e.target));
  });
  const clear = (e) => {
    if (e.target.matches?.('input, select')) setFieldError(e.target, '');
  };
  form.addEventListener('focusin', clear);
  form.addEventListener('input', clear);
  form.addEventListener('reset', () => fields().forEach((f) => setFieldError(f, '')));
  return () => {
    let first;
    for (const field of fields()) {
      const message = fieldError(field);
      setFieldError(field, message);
      if (message) first ??= field;
    }
    if (!first) return true;
    // O foco limpa o erro do campo (focusin); ele é reposto logo em seguida.
    first.focus();
    setFieldError(first, fieldError(first));
    return false;
  };
}

// ---------------------------------------------------------------- confirmação

/**
 * Confirmação de uma ação que não dá para desfazer: diz o que será afetado, o
 * botão que confirma traz o verbo da ação, e o foco começa em Cancelar. Esc
 * cancela. Resolve true só se a pessoa confirmar.
 */
export function confirmAction({ title, body, confirmLabel }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    dialog.innerHTML = `
      <h2 id="dialog-title">${esc(title)}</h2>
      <p>${esc(body)}</p>
      <div class="dialog__actions">
        <button type="button" class="btn btn--ghost" data-choice="cancel">Cancelar</button>
        <button type="button" class="btn btn--danger" data-choice="confirm">${esc(confirmLabel)}</button>
      </div>`;
    const finish = (ok) => {
      dialog.remove();
      opener?.focus?.();
      resolve(ok);
    };
    dialog.addEventListener('click', (e) => {
      const choice = e.target.closest?.('[data-choice]')?.dataset.choice;
      if (choice) finish(choice === 'confirm');
    });
    // Esc: 'cancel' no <dialog> modal; keydown onde showModal não existe.
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(false);
    });
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') finish(false);
    });
    document.body.appendChild(dialog);
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    dialog.querySelector('[data-choice="cancel"]').focus();
  });
}

// ---------------------------------------------------------------- vazio e erro

/** Erro de uma ação, escrito ao lado do botão que a disparou. */
export function showInlineError(btn, message) {
  let el = btn.parentElement.querySelector('.inline-error');
  if (!el) {
    el = document.createElement('span');
    el.className = 'inline-error';
    el.setAttribute('role', 'alert');
    btn.insertAdjacentElement('afterend', el);
  }
  el.textContent = message;
}

/** Estado vazio: o que aparece aqui, por que vale preencher e por onde começar. */
export function emptyBlock({ title, text, action }) {
  const cta = action ? `<a class="btn" href="${esc(action.href)}">${esc(action.label)}</a>` : '';
  return `<div class="empty-block"><h3>${esc(title)}</h3><p>${esc(text)}</p>${cta}</div>`;
}

/**
 * Falha ao carregar uma tela: diz o que não veio e oferece tentar de novo. Os
 * detalhes técnicos (rota, status) não vão para a tela; ficam num botão de
 * copiar, para mandar a quem dá suporte.
 */
export function showLoadError(container, { what, details, retry }) {
  container.innerHTML = `
    <div class="load-error" role="alert">
      <p>Não foi possível carregar ${esc(what)}. Confira a conexão com o servidor.</p>
      <button type="button" class="btn btn--ghost" data-act="retry">Tentar de novo</button>
      <button type="button" class="btn btn--ghost" data-act="copy">Copiar detalhes do erro</button>
    </div>`;
  container.querySelector('[data-act="retry"]').addEventListener('click', retry);
  const copy = container.querySelector('[data-act="copy"]');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(details);
      copy.textContent = 'Detalhes copiados';
    } catch {
      copy.textContent = details;
    }
  });
}

/** Detalhes técnicos de uma resposta, para o botão de copiar. */
export const errorDetails = (res) => `${res.url || 'requisição'} respondeu ${res.status}`;
