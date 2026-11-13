import { apiFetch } from './auth.js';
import {
  arrowStep,
  clampPosition,
  fillFraction,
  readingState,
  screenToDrawing,
} from './synoptic-geometry.js';
import { apiError, esc, fmtNum } from './util.js';

/**
 * Sinótico: desenho do processo com o valor de cada tag na sua posição.
 * Desenho e posição (x, y em % da área) vêm do cadastro da tag; tags sem
 * desenho (synopticKind vazio) não aparecem.
 *
 * Modo de edição ("Editar posições"): arrastar um instrumento (mouse ou toque)
 * muda a sua posição, gravada ao soltar (PATCH /api/tags/:tag); com o
 * instrumento em foco, as setas movem 1% (5% com Shift). Fora do modo de
 * edição nada se move, para o operador não desarrumar a tela sem querer, e
 * clicar num instrumento leva aos gráficos.
 */
const svg = document.getElementById('synoptic-svg');
const editBtn = document.getElementById('synoptic-edit');
const statusEl = document.getElementById('synoptic-status');
const queueEl = document.getElementById('synoptic-queue');
const nodes = new Map(); // tag -> { el, cfg, x, y, value }
/** Tags com alarme ativo (define o estado na fila de prioridade). */
let alarmTags = new Set();

let editing = false;
/** Arraste em andamento: { node, pointerId, dx, dy, from }. */
let drag = null;
/** Espera após a última seta antes de gravar (uma gravação por ajuste). */
const KEY_SAVE_DELAY_MS = 500;

/**
 * Desenhos em traço único (cores e espessuras no CSS, classes syn-*): corpo,
 * detalhe, preenchimento, valor, rótulo e o ponto de estado no canto.
 */
const SHAPES = {
  tank: `
    <rect class="syn-body" x="-8" y="-6" width="16" height="12" rx="1.2"/>
    <rect class="syn-fill" x="-7" y="5" width="14" height="0"/>
    <path class="syn-detail" d="M-6 6v1.6M6 6v1.6M-8 -3.6h16"/>
    <circle class="syn-dot" cx="8" cy="-6" r="0.8"/>
    <text class="syn-val" y="11.6" text-anchor="middle" font-size="2.6">—</text>
    <text class="syn-label" y="-7.6" text-anchor="middle" font-size="2"></text>`,
  pressure: `
    <circle class="syn-body" r="5"/>
    <path class="syn-detail" d="M-3 2.4A3.9 3.9 0 1 1 3 2.4M0 0L2 -2.4"/>
    <circle class="syn-hub" r="0.55"/>
    <circle class="syn-dot" cx="3.6" cy="-3.6" r="0.8"/>
    <text class="syn-val" y="9" text-anchor="middle" font-size="2.6">—</text>
    <text class="syn-label" y="-6.6" text-anchor="middle" font-size="2"></text>`,
  flow: `
    <path class="syn-pipe" d="M-10 0H10"/>
    <rect class="syn-body" x="-4" y="-2.8" width="8" height="5.6" rx="0.9"/>
    <path class="syn-detail" d="M-1.1 -1.3L1.1 0L-1.1 1.3"/>
    <circle class="syn-dot" cx="4" cy="-2.8" r="0.8"/>
    <text class="syn-val" y="6.8" text-anchor="middle" font-size="2.6">—</text>
    <text class="syn-label" y="-4.6" text-anchor="middle" font-size="2"></text>`,
  level: `
    <rect class="syn-body" x="-4" y="-8" width="8" height="16" rx="1"/>
    <rect class="syn-fill" x="-3" y="7" width="6" height="0"/>
    <path class="syn-detail" d="M4 -4h1.3M4 0h1.3M4 4h1.3"/>
    <circle class="syn-dot" cx="4" cy="-8" r="0.8"/>
    <text class="syn-val" y="11.8" text-anchor="middle" font-size="2.6">—</text>
    <text class="syn-label" y="-9.6" text-anchor="middle" font-size="2"></text>`,
  sensor: `
    <rect class="syn-body" x="-6" y="-3" width="12" height="6" rx="0.9"/>
    <circle class="syn-dot" cx="6" cy="-3" r="0.8"/>
    <text class="syn-val" y="0.9" text-anchor="middle" font-size="2.3">—</text>
    <text class="syn-label" y="-4.6" text-anchor="middle" font-size="2"></text>`,
};

/** Altura útil do preenchimento de cada desenho (tanque e nível). */
const FILL = { tank: { bottom: 5, height: 10 }, level: { bottom: 7, height: 14 } };

/** Grade de 10 em 10%, visível só no modo de edição, para alinhar instrumentos. */
const GRID = (() => {
  const lines = [];
  for (let i = 10; i < 100; i += 10) {
    lines.push(
      `<line x1="${i}" y1="0" x2="${i}" y2="100"/>`,
      `<line x1="0" y1="${i}" x2="100" y2="${i}"/>`,
    );
  }
  return `<g class="syn-grid" aria-hidden="true">${lines.join('')}</g>`;
})();

export async function initSynoptic(inAlarm = new Set()) {
  const res = await apiFetch('/api/tags');
  if (!res.ok) return;
  const configs = (await res.json()).filter((c) => c.synopticKind);

  drag = null;
  nodes.clear();
  alarmTags = inAlarm;
  svg.innerHTML =
    GRID +
    configs
      .map((c) => {
        const x = c.synopticX ?? 50;
        const y = c.synopticY ?? 50;
        return `<g class="syn-node" data-tag="${esc(c.tag)}" transform="translate(${x},${y})">${SHAPES[c.synopticKind] ?? SHAPES.sensor}</g>`;
      })
      .join('');

  // Os desenhos saem na mesma ordem do cadastro.
  const elements = svg.querySelectorAll('.syn-node');
  configs.forEach((cfg, i) => {
    const el = elements[i];
    el.querySelector('.syn-label').textContent = cfg.description || cfg.tag; // textContent: sem HTML
    el.addEventListener('click', () => {
      if (!editing) location.hash = 'dashboard';
    });
    const node = { el, cfg, x: cfg.synopticX ?? 50, y: cfg.synopticY ?? 50 };
    nodes.set(cfg.tag, node);
    el.classList.toggle('syn-node--alarm', inAlarm.has(cfg.tag));
  });
  applyEditing();

  const latest = await apiFetch('/api/dashboard/tags');
  if (latest.ok) for (const s of await latest.json()) updateSynoptic(s);
  renderQueue();
}

export function updateSynoptic(s) {
  const node = nodes.get(s.tag);
  if (!node) return;
  node.value = s.value;
  node.el.querySelector('.syn-val').textContent = reading(node);

  const fill = node.el.querySelector('.syn-fill');
  const geo = FILL[node.cfg.synopticKind];
  if (fill && geo) {
    const h = fillFraction(s.value, node.cfg.engMin, node.cfg.engMax) * geo.height;
    fill.setAttribute('height', String(h));
    fill.setAttribute('y', String(geo.bottom - h));
  }
  renderQueue();
}

export function setSynopticAlarms(inAlarm) {
  alarmTags = inAlarm;
  for (const [tag, { el }] of nodes) el.classList.toggle('syn-node--alarm', inAlarm.has(tag));
  renderQueue();
}

// ---------------------------------------------------------------- fila de prioridade

const reading = (node) => `${fmtNum(node.value, 1)}${node.cfg.unit ? ` ${node.cfg.unit}` : ''}`;

const STATE_ORDER = { alarm: 0, warn: 1, ok: 2, none: 3 };
const STATE_TEXT = { alarm: 'Alarme', warn: 'Atenção', ok: 'Normal', none: 'Sem leitura' };
const QUEUE_MAX = 8;

/**
 * Lista ao lado do desenho: primeiro o que está em alarme, depois o que está
 * perto de um limite; dentro de cada grupo, a ordem do cadastro (a lista não
 * fica trocando de lugar a cada amostra).
 */
function renderQueue() {
  if (!queueEl) return;
  const rows = [...nodes.values()]
    .map((node, i) => ({
      node,
      i,
      state: readingState(node.value, node.cfg, alarmTags.has(node.cfg.tag)),
    }))
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.i - b.i)
    .slice(0, QUEUE_MAX);
  if (rows.length === 0) {
    queueEl.innerHTML =
      '<li class="queue__empty">Nenhuma tag no sinótico. Escolha o desenho em Configuração.</li>';
    return;
  }
  queueEl.innerHTML = rows
    .map(({ node, state }) => {
      const { cfg } = node;
      const value = state === 'none' ? '—' : esc(reading(node));
      return `
        <li class="queue__row queue__row--${state}">
          <div class="queue__main">
            <span class="queue__title">${esc(cfg.description || cfg.tag)}</span>
            <span class="queue__sub">${esc(cfg.tag)}</span>
          </div>
          <div class="queue__reading">
            <span class="queue__value">${value}</span>
            <span class="queue__state">${STATE_TEXT[state]}</span>
          </div>
        </li>`;
    })
    .join('');
}

// ---------------------------------------------------------------- edição

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `synoptic-status ${kind}`.trim();
}

function applyEditing() {
  svg.classList.toggle('synoptic--editing', editing);
  editBtn.textContent = editing ? 'Concluir' : 'Editar posições';
  editBtn.setAttribute('aria-pressed', String(editing));
  for (const { el, cfg } of nodes.values()) {
    if (editing) {
      el.setAttribute('tabindex', '0');
      el.setAttribute(
        'aria-label',
        `${cfg.description || cfg.tag}: arraste ou use as setas para mover`,
      );
    } else {
      el.removeAttribute('tabindex');
      el.removeAttribute('aria-label');
    }
  }
}

function place(node, x, y) {
  node.x = x;
  node.y = y;
  node.el.setAttribute('transform', `translate(${x},${y})`);
}

/** Move na grade de 1%, com o desenho inteiro (e o rótulo) dentro da área. */
function moveTo(node, x, y) {
  const p = clampPosition(x, y, node.box);
  place(node, p.x, p.y);
}

/** Ponto do mouse/toque na escala do desenho (viewBox 0–100). */
function toSvg(evt) {
  const ctm = svg.getScreenCTM();
  return ctm ? screenToDrawing(ctm, evt.clientX, evt.clientY) : null;
}

/**
 * Grava a posição atual. Se falhar, o instrumento volta para `from`. As
 * gravações de um mesmo instrumento ficam em fila, na ordem dos movimentos.
 */
function save(node, from) {
  const { tag } = node.cfg;
  const to = { x: node.x, y: node.y };
  if (to.x === from.x && to.y === from.y) return;
  setStatus(`Salvando ${tag}…`);
  node.saving = (node.saving ?? Promise.resolve()).then(async () => {
    try {
      const res = await apiFetch(`/api/tags/${encodeURIComponent(tag)}`, {
        method: 'PATCH',
        body: JSON.stringify({ synopticX: to.x, synopticY: to.y }),
      });
      if (!res.ok) throw new Error(await apiError(res));
      node.cfg.synopticX = to.x;
      node.cfg.synopticY = to.y;
      setStatus(`${tag}: posição salva (${to.x}, ${to.y}).`, 'ok');
    } catch (err) {
      // Só desfaz se o instrumento ainda está onde esta gravação o deixou.
      if (node.x === to.x && node.y === to.y) place(node, from.x, from.y);
      setStatus(
        `${tag}: não foi possível salvar (${err.message}); posição anterior restaurada.`,
        'err',
      );
    }
  });
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Mede o desenho (para limitar o arraste) e cria a moldura de destaque, na
 * primeira vez que o instrumento recebe foco (o desenho precisa estar visível).
 */
function ensureFrame(node) {
  if (node.frame) return;
  const box = node.el.getBBox();
  if (box.width === 0) return;
  node.box = { x: box.x, y: box.y, width: box.width, height: box.height };
  const pad = 1;
  const frame = document.createElementNS(SVG_NS, 'rect');
  frame.setAttribute('class', 'syn-frame');
  frame.setAttribute('x', String(box.x - pad));
  frame.setAttribute('y', String(box.y - pad));
  frame.setAttribute('width', String(box.width + 2 * pad));
  frame.setAttribute('height', String(box.height + 2 * pad));
  frame.setAttribute('rx', '1');
  node.el.appendChild(frame);
  node.frame = frame;
}

function nodeOf(target) {
  const el = target instanceof Element ? target.closest('.syn-node') : null;
  return el ? nodes.get(el.dataset.tag) : undefined;
}

editBtn.addEventListener('click', () => {
  editing = !editing;
  if (!editing && drag) {
    // Concluir no meio de um arraste (ex: toque com dois dedos): grava onde estiver.
    const { node, from, pointerId } = drag;
    drag = null;
    node.el.classList.remove('syn-node--dragging');
    if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
    save(node, from);
  }
  applyEditing();
  setStatus(editing ? 'Arraste os instrumentos (ou use as setas) para posicioná-los.' : '');
});

svg.addEventListener('focusin', (e) => {
  const node = editing ? nodeOf(e.target) : undefined;
  if (node) ensureFrame(node);
});

svg.addEventListener('pointerdown', (e) => {
  if (!editing || drag || e.button !== 0) return;
  const node = nodeOf(e.target);
  const p = node && toSvg(e);
  if (!p) return;
  e.preventDefault();
  node.el.focus({ preventScroll: true });
  drag = {
    node,
    pointerId: e.pointerId,
    dx: p.x - node.x,
    dy: p.y - node.y,
    from: { x: node.x, y: node.y },
  };
  svg.setPointerCapture(e.pointerId);
  node.el.classList.add('syn-node--dragging');
});

svg.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const p = toSvg(e);
  if (p) moveTo(drag.node, p.x - drag.dx, p.y - drag.dy);
});

function endDrag(e, cancelled) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const { node, from } = drag;
  drag = null;
  node.el.classList.remove('syn-node--dragging');
  if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  if (cancelled) place(node, from.x, from.y);
  else save(node, from);
}

svg.addEventListener('pointerup', (e) => endDrag(e, false));
svg.addEventListener('pointercancel', (e) => endDrag(e, true));

svg.addEventListener('keydown', (e) => {
  const step = arrowStep(e.key, e.shiftKey);
  const node = editing && step && !drag ? nodeOf(e.target) : undefined;
  if (!node) return;
  e.preventDefault();
  // Várias setas seguidas viram uma gravação só, a partir da posição inicial.
  node.keyFrom ??= { x: node.x, y: node.y };
  moveTo(node, node.x + step.dx, node.y + step.dy);
  clearTimeout(node.keyTimer);
  node.keyTimer = setTimeout(() => {
    save(node, node.keyFrom);
    node.keyFrom = undefined;
  }, KEY_SAVE_DELAY_MS);
});
