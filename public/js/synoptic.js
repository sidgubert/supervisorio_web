import { apiFetch } from './auth.js';
import { arrowStep, clampPosition, fillFraction, screenToDrawing } from './synoptic-geometry.js';
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
const nodes = new Map(); // tag -> { el, cfg, x, y }

let editing = false;
/** Arraste em andamento: { node, pointerId, dx, dy, from }. */
let drag = null;
/** Espera após a última seta antes de gravar (uma gravação por ajuste). */
const KEY_SAVE_DELAY_MS = 500;

const SHAPES = {
  tank: `
    <rect x="-8" y="-6" width="16" height="12" rx="2" fill="#21262d" stroke="#58a6ff" stroke-width="0.4"/>
    <rect class="syn-fill" x="-7" y="5" width="14" height="0" fill="#58a6ff" opacity="0.5"/>
    <text class="syn-val" y="1.5" text-anchor="middle" font-size="2.8" fill="#e6edf3">—</text>
    <text class="syn-label" y="-7.5" text-anchor="middle" font-size="2" fill="#8b949e"></text>`,
  pressure: `
    <circle r="5" fill="#21262d" stroke="#f0883e" stroke-width="0.4"/>
    <text class="syn-val" y="1.2" text-anchor="middle" font-size="2.5" fill="#e6edf3">—</text>
    <text class="syn-label" y="-6.5" text-anchor="middle" font-size="2" fill="#8b949e"></text>`,
  flow: `
    <polygon points="-6,0 6,0 3,-4 -3,-4" fill="#21262d" stroke="#3fb950" stroke-width="0.4"/>
    <text class="syn-val" y="3" text-anchor="middle" font-size="2.5" fill="#e6edf3">—</text>
    <text class="syn-label" y="-6" text-anchor="middle" font-size="2" fill="#8b949e"></text>`,
  level: `
    <rect x="-4" y="-8" width="8" height="16" rx="1" fill="#21262d" stroke="#a371f7" stroke-width="0.4"/>
    <rect class="syn-fill" x="-3" y="7" width="6" height="0" fill="#a371f7" opacity="0.6"/>
    <text class="syn-val" y="11" text-anchor="middle" font-size="2.2" fill="#e6edf3">—</text>
    <text class="syn-label" y="-10" text-anchor="middle" font-size="2" fill="#8b949e"></text>`,
  sensor: `
    <rect x="-5" y="-3.5" width="10" height="7" rx="1" fill="#21262d" stroke="#8b949e" stroke-width="0.35"/>
    <text class="syn-val" y="1.2" text-anchor="middle" font-size="2.2" fill="#e6edf3">—</text>
    <text class="syn-label" y="-5.5" text-anchor="middle" font-size="1.8" fill="#8b949e"></text>`,
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
  svg.innerHTML =
    GRID +
    '<text x="50" y="6" text-anchor="middle" font-size="3" fill="#8b949e">Processo</text>' +
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
}

export function updateSynoptic(s) {
  const node = nodes.get(s.tag);
  if (!node) return;
  const unit = node.cfg.unit ? ` ${node.cfg.unit}` : '';
  node.el.querySelector('.syn-val').textContent = `${fmtNum(s.value, 1)}${unit}`;

  const fill = node.el.querySelector('.syn-fill');
  const geo = FILL[node.cfg.synopticKind];
  if (fill && geo) {
    const h = fillFraction(s.value, node.cfg.engMin, node.cfg.engMax) * geo.height;
    fill.setAttribute('height', String(h));
    fill.setAttribute('y', String(geo.bottom - h));
  }
}

export function setSynopticAlarms(inAlarm) {
  for (const [tag, { el }] of nodes) el.classList.toggle('syn-node--alarm', inAlarm.has(tag));
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
