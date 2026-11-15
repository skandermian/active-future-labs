/**
 * Guided tour: a spotlight on one part of the screen at a time, with a short
 * card saying what it is and what to do. Starts on a first visit; "Take the
 * tour" in the status bar replays it. Plain DOM, no library.
 */
import { esc } from './dom.js';

export function createTour({ steps, onFinish = () => {} }) {
  let i = 0;
  let open = false;
  const shade = document.createElement('div');
  shade.className = 'tour-shade';
  const card = document.createElement('div');
  card.className = 'tour-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-live', 'polite');
  shade.hidden = card.hidden = true;
  document.body.append(shade, card);

  card.addEventListener('click', (e) => {
    const a = e.target.closest('[data-tour]')?.dataset.tour;
    if (a === 'next') go(i + 1);
    if (a === 'back') go(i - 1);
    if (a === 'skip') close();
  });
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') go(i + 1);
    if (e.key === 'ArrowLeft') go(i - 1);
  });
  window.addEventListener('resize', () => open && place());

  async function go(n) {
    if (n >= steps.length) return close();
    i = Math.max(0, n);
    const step = steps[i];
    if (step.before) await step.before();
    await new Promise((r) => setTimeout(r, step.wait ?? 60));
    const target = step.target ? document.querySelector(step.target) : null;
    target?.scrollIntoView?.({ block: 'nearest' });
    card.innerHTML = `
      <p class="tour-count">${i + 1} of ${steps.length}</p>
      <h3>${esc(step.title)}</h3>
      <p>${step.text}</p>
      <div class="tour-actions">
        <button type="button" data-tour="skip">${i === steps.length - 1 ? 'Close' : 'Skip tour'}</button>
        <span>${i > 0 ? '<button type="button" data-tour="back">Back</button>' : ''}
        <button type="button" data-tour="next" class="tour-next">${i === steps.length - 1 ? 'Start exploring' : 'Next'}</button></span>
      </div>`;
    place();
    card.querySelector('.tour-next').focus({ preventScroll: true });
  }

  function place() {
    const step = steps[i];
    const target = step.target ? document.querySelector(step.target) : null;
    const r = target?.getBoundingClientRect();
    const visible = r && r.width > 0 && r.height > 0;
    if (visible) {
      const pad = 6;
      Object.assign(shade.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      shade.dataset.mode = 'spot';
    } else {
      Object.assign(shade.style, { left: '50%', top: '50%', width: '0px', height: '0px' });
      shade.dataset.mode = 'full';
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(360, vw - 24);
    card.style.width = `${cw}px`;
    const ch = card.offsetHeight || 220;
    let left = (vw - cw) / 2;
    let top = (vh - ch) / 2;
    if (visible && vw >= 700) {
      // beside the target if there is room, else below or above it
      if (r.right + 16 + cw < vw) { left = r.right + 16; top = Math.min(Math.max(12, r.top), vh - ch - 12); }
      else if (r.left - 16 - cw > 0) { left = r.left - 16 - cw; top = Math.min(Math.max(12, r.top), vh - ch - 12); }
      else if (r.bottom + 12 + ch < vh) { left = Math.min(Math.max(12, r.left), vw - cw - 12); top = r.bottom + 12; }
      else { left = Math.min(Math.max(12, r.left), vw - cw - 12); top = Math.max(12, r.top - ch - 12); }
    } else if (visible) {
      top = r.bottom + 12 + ch < vh ? r.bottom + 12 : Math.max(12, vh - ch - 12);
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` });
  }

  function start() {
    open = true;
    shade.hidden = card.hidden = false;
    go(0);
  }
  function close() {
    open = false;
    shade.hidden = card.hidden = true;
    onFinish();
  }
  return { start, close, isOpen: () => open };
}
