import { apiFetch } from './auth.js';
import { esc, fmtNum } from './util.js';

/**
 * Sinótico: desenho do processo com o valor de cada tag na sua posição.
 * Desenho e posição (x, y em % da área) vêm do cadastro da tag; tags sem
 * desenho (synopticKind vazio) não aparecem.
 */
const svg = document.getElementById('synoptic-svg');
const nodes = new Map(); // tag -> { el, cfg }

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

export async function initSynoptic(inAlarm = new Set()) {
  const res = await apiFetch('/api/tags');
  if (!res.ok) return;
  const configs = (await res.json()).filter((c) => c.synopticKind);

  nodes.clear();
  svg.innerHTML =
    '<text x="50" y="6" text-anchor="middle" font-size="3" fill="#8b949e">Processo</text>' +
    configs
      .map((c) => {
        const x = c.synopticX ?? 50;
        const y = c.synopticY ?? 50;
        return `<g class="syn-node" data-tag="${esc(c.tag)}" transform="translate(${x},${y})">${SHAPES[c.synopticKind] ?? SHAPES.sensor}</g>`;
      })
      .join('');

  for (const cfg of configs) {
    const el = svg.querySelector(`.syn-node[data-tag="${CSS.escape(cfg.tag)}"]`);
    if (!el) continue;
    el.querySelector('.syn-label').textContent = cfg.description || cfg.tag; // textContent: sem HTML
    el.addEventListener('click', () => (location.hash = 'dashboard'));
    nodes.set(cfg.tag, { el, cfg });
    el.classList.toggle('syn-node--alarm', inAlarm.has(cfg.tag));
  }

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
    // Preenchimento proporcional à faixa de engenharia (engMin–engMax).
    const { engMin, engMax } = node.cfg;
    const pct =
      engMin !== null && engMax !== null && engMax > engMin
        ? Math.min(1, Math.max(0, (s.value - engMin) / (engMax - engMin)))
        : 0.5;
    const h = pct * geo.height;
    fill.setAttribute('height', String(h));
    fill.setAttribute('y', String(geo.bottom - h));
  }
}

export function setSynopticAlarms(inAlarm) {
  for (const [tag, { el }] of nodes) el.classList.toggle('syn-node--alarm', inAlarm.has(tag));
}
