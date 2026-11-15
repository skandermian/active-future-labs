/**
 * EARTHWATCH composition root (God's Eye View's standalone/application.js,
 * reduced): build services, register layers, wire three panes to one store.
 */
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles/console.css';
import { createPin, createViewer, flyToPlace, onPick } from './core/viewer.js';
import { findPlace, nearestSite } from './tools/places.js';
import { API, fetchLive, warmUp } from './ui/live.js';
import { createTour } from './ui/tour.js';
import { createStore } from './core/store.js';
import { createContextStore } from './core/contextStore.js';
import { createLayerManager } from './core/layerManager.js';
import { describeState, worstState } from './core/feedState.js';
import { createTrendDataSource } from './sources/trendData.js';
import { createStudyBoxesLayer } from './layers/studyBoxes/index.js';
import { createSitesLayer } from './layers/sites/index.js';
import { createLinksLayer } from './layers/links/index.js';
import { createTrendLens } from './lenses/trend.js';
import { SIGNAL_TYPES, signalIndex, siteCode } from './intel/signals.js';
import { createFeed } from './ui/feed.js';
import { createDossier } from './ui/dossier.js';
import { renderStatusbar } from './ui/statusbar.js';
import { esc } from './ui/dom.js';

const $ = (id) => document.getElementById(id);
const status = $('status');

async function start() {
  const source = createTrendDataSource({ baseUrl: `${import.meta.env.BASE_URL}data/` });
  const core = await source.loadCore();
  const { intel, regions, variables } = core;
  const byId = signalIndex(intel);

  const viewer = createViewer($('globe'));
  const contextStore = createContextStore();
  const layers = createLayerManager({ viewer, requestRender: () => viewer.scene.requestRender() });
  layers.register(createStudyBoxesLayer({ contextStore, regions }));
  layers.register(createLinksLayer({ regions, intel }));
  layers.register(createSitesLayer({ contextStore, regions, intel }));
  layers.setEnabled('sites', true);
  layers.setEnabled('links', true);

  // Context field: when a site is open, the focus variable's trend everywhere,
  // faint, so the site can be read against its neighbourhood.
  const trendLens = createTrendLens();
  const contextLens = {
    paint: (i) => {
      const p = trendLens.paint(i);
      return p && { rgb: p.rgb, alpha: p.alpha * 0.5 };
    },
  };

  const hash = new URLSearchParams(location.hash.slice(1));
  const initialSite = hash.get('site') ? regions.findIndex((r) => siteCode(r) === hash.get('site')) : -1;
  const store = createStore({
    filter: SIGNAL_TYPES[hash.get('filter')] ? hash.get('filter') : 'all',
    query: '',
    selectedIndex: initialSite >= 0 ? initialSite : null,
    focusVar: variables[hash.get('var')] ? hash.get('var') : null,
    view: initialSite >= 0 ? 'dossier' : 'feed',
    probe: null, // { label, lat, lon, km, how: 'search' | 'click' } when the user picked a spot rather than a site
    live: null, // { status: 'loading' | 'ready' | 'error', radius, data?, message? } from the Python server
    liveVar: 'T2M',
  });
  warmUp();
  const pin = createPin(viewer);

  const leadVar = (i) => {
    for (const id of intel.sites[i].signals) {
      const s = byId.get(id);
      if (s.var && variables[s.var]) return s.var;
      if (s.pair) return s.pair[0];
    }
    return 'T2M';
  };
  let liveToken = 0;
  const requestLive = async (probe, radius) => {
    if (!API || !probe) return;
    const mine = ++liveToken;
    store.set({ live: { status: 'loading', radius } });
    try {
      const data = await fetchLive({ lat: probe.lat, lon: probe.lon, label: probe.label, radius });
      if (mine === liveToken) store.set({ live: { status: 'ready', radius, data } });
    } catch (e) {
      if (mine === liveToken) store.set({ live: { status: 'error', radius, message: e.message } });
    }
  };
  const selectSite = (i, focusVar, probe = null) => {
    liveToken++;
    store.set({ selectedIndex: i, focusVar: focusVar ?? leadVar(i), view: 'dossier', probe, live: null });
    if (probe) requestLive(probe, 0);
    if (probe) pin.set(probe.lat, probe.lon, probe.label);
    else pin.hide();
    flyToPlace(viewer, probe ? probe.lon : regions[i].lon, probe ? probe.lat : regions[i].lat, { height: 6_000_000 });
  };
  // Any spot on Earth -> the nearest analysed site, with an honest note of how far away it is.
  const openSpot = (lat, lon, label, how) => {
    const near = nearestSite(regions, lat, lon);
    selectSite(near.index, undefined, { label, lat, lon, km: Math.round(near.km), how });
  };

  const searchForm = $('place-search');
  const searchMsg = $('place-msg');
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchForm.elements.q.value.trim();
    if (!q) return;
    searchMsg.textContent = 'Searching…';
    const place = await findPlace(regions, q);
    if (!place) {
      searchMsg.textContent = `Couldn't find "${q}". Try a bigger town, a country, or coordinates like 53.5, -2.2.`;
      return;
    }
    searchMsg.textContent = '';
    if (place.site !== undefined && place.label === regions[place.site].name) selectSite(place.site);
    else openSpot(place.lat, place.lon, place.label, 'search');
  });
  if (store.get().selectedIndex !== null && !store.get().focusVar) store.set({ focusVar: leadVar(store.get().selectedIndex) });

  renderStatusbar($('statusbar'), core, 'nominal');
  const feed = createFeed({
    root: $('feed'),
    core,
    store,
    onOpen: (id) => {
      const s = byId.get(id);
      selectSite(s.site, s.var && variables[s.var] ? s.var : s.pair?.[0]);
    },
  });
  const dossier = createDossier({ root: $('dossier'), core, source, store, onSelectSite: (i) => selectSite(i), onRadius: (r) => requestLive(store.get().probe, r) });

  for (const b of document.querySelectorAll('.view-tabs [data-view]'))
    b.addEventListener('click', () => store.set({ view: b.dataset.view }));

  onPick(viewer, (entityId, where) => {
    const ctx = entityId ? contextStore.resolve(entityId) : null;
    if (ctx && (ctx.kind === 'site' || ctx.kind === 'region')) selectSite(ctx.key);
    else if (where) openSpot(where.lat, where.lon, `${Math.abs(where.lat).toFixed(1)}°${where.lat >= 0 ? 'N' : 'S'} ${Math.abs(where.lon).toFixed(1)}°${where.lon >= 0 ? 'E' : 'W'}`, 'click');
  });

  async function render(changed) {
    const s = store.get();
    try {
      $('console').dataset.view = s.view;
      for (const b of document.querySelectorAll('.view-tabs [data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === s.view));

      const boxesOn = s.selectedIndex !== null;
      if (boxesOn) await trendLens.prepare({ core, source, state: { variable: s.focusVar } });
      layers.setEnabled('study-boxes', boxesOn);
      layers.update({ lens: contextLens, filter: s.filter, selectedIndex: s.selectedIndex });
      renderHud(core, s);

      if (!changed || changed.some((k) => ['filter', 'query', 'selectedIndex'].includes(k))) feed.render();
      if (!changed || changed.some((k) => ['selectedIndex', 'focusVar', 'probe', 'live', 'liveVar'].includes(k))) await dossier.render();

      const feedState = worstState(layers.stats().filter((l) => l.enabled).map((l) => l.state));
      status.hidden = feedState === 'nominal';
      status.textContent = describeState(feedState);
      const h = new URLSearchParams();
      if (s.filter !== 'all') h.set('filter', s.filter);
      if (s.selectedIndex !== null) {
        h.set('site', siteCode(regions[s.selectedIndex]));
        h.set('var', s.focusVar);
      }
      try {
        history.replaceState(null, '', h.toString() ? `#${h}` : location.pathname);
      } catch {
        /* sandboxed hosts may refuse; the console works without it */
      }
    } catch (error) {
      console.error(error);
      status.hidden = false;
      status.textContent = describeState('unavailable', error.message);
    }
  }

  function renderHud(core, s) {
    const meta = s.filter === 'all' ? null : SIGNAL_TYPES[s.filter];
    const tag = meta
      ? `<span class="glyph" style="color:${meta.color}">${meta.glyph}</span> ${esc(meta.label)}<span class="hud-q"> · ${esc(meta.question)}</span>`
      : '<span class="glyph">◆</span> All signals<span class="hud-q"> · size = fused signal strength</span>';
    $('hud-tag').innerHTML = s.selectedIndex === null ? tag : `${tag}<br><span class="hud-sub">Field: ${esc(variables[s.focusVar].label)} trend at every site</span>`;
    $('hud-legend').innerHTML = ['drift', 'erratic', 'conflict', 'migrate']
      .map((k) => `<span style="--c:${SIGNAL_TYPES[k].color}"><i>${SIGNAL_TYPES[k].glyph}</i>${SIGNAL_TYPES[k].label}</span>`)
      .join('');
  }

  store.subscribe((_, __, changed) => render(changed));
  await render();

  // ---- guided tour: first visit, and the "Take the tour" button ----
  const wide = () => window.innerWidth >= 1280;
  const london = regions.findIndex((r) => r.name === 'London');
  const tour = createTour({
    onFinish: () => { try { localStorage.setItem('ew-tour-done', '1'); } catch { /* private mode */ } },
    steps: [
      { title: 'Welcome to EARTHWATCH', text: 'NASA has measured the whole planet every month for decades: temperature, rain, soil, haze and more. This site finds where things are <b>really</b> changing, not just one odd year, and what that means for heatwaves, droughts, floods and fires. This tour takes about a minute.', before: () => store.set({ selectedIndex: null, probe: null, live: null, view: 'feed' }) },
      { title: 'Search anywhere', target: '#place-search', text: `Type any town, country or coordinates, or <b>click anywhere on the globe</b>. ${API ? 'We download 44 years of NASA data for that exact spot and test it live.' : 'We open the nearest of our 360 analysed areas.'}` },
      { title: 'The globe', target: '#globe', text: 'Each dot is one of 360 analysed areas. <b>Bigger dots = more change.</b> The colour shows the kind of change (see the key at the top). Drag to spin, scroll to zoom.' },
      { title: 'Five kinds of change', target: '.tally', text: 'The computer looks for five kinds of change: the normal level moving (Drift), weather getting more erratic, NASA records disagreeing (Conflict), and climates that now look like somewhere else (Migrate). <b>Tap one to filter the globe.</b>', before: () => !wide() && store.set({ view: 'feed' }) },
      { title: 'The signal feed', target: '.signal-list', text: 'Every change found, strongest first. "Confirmed" = very strong evidence or two NASA records agree. Tap any line to open that place.', before: () => !wide() && store.set({ view: 'feed' }) },
      { title: 'A place\'s case file', target: '#dossier', text: 'Here is London. Each place has a case file: what is changing, how sure we are, and whether the sources agree.', wait: 900, before: () => { if (london >= 0) selectSite(london, 'T2M'); store.set({ view: 'dossier' }); } },
      { title: 'Disaster outlook', target: '.outlook', text: 'Are heatwaves, dry soil, very wet months or fire weather becoming more common? Each comes with today\'s chance that a month is extreme, plus dry spells, desertification and a stability score out of 100.', wait: 400 },
      { title: 'Stuck on a word?', target: '.dossier-body .explain summary', text: 'Every section has a <b>What does this mean?</b> button, and there is a word list at the bottom of every case file.' },
      { title: 'You\'re ready', text: 'Search your own town, or click anywhere on the globe. You can replay this tour any time with <b>Take the tour</b> at the top.' },
    ],
  });
  const tourBtn = document.createElement('button');
  tourBtn.type = 'button';
  tourBtn.className = 'tour-button';
  tourBtn.textContent = 'Take the tour';
  tourBtn.addEventListener('click', () => tour.start());
  $('statusbar').append(tourBtn);
  let seen = false;
  try { seen = localStorage.getItem('ew-tour-done') === '1'; } catch { /* private mode */ }
  if (!seen && !location.hash) setTimeout(() => tour.start(), 800);
  if (store.get().selectedIndex !== null) {
    const r = regions[store.get().selectedIndex];
    flyToPlace(viewer, r.lon, r.lat, { height: 6_000_000, duration: 0 });
  }
  window.__earthwatch = { viewer, store, layers, core };
}

start().catch((error) => {
  console.error('Startup failed', error);
  status.hidden = false;
  status.textContent = describeState('unavailable', error.message);
});
