const INAT_BASE = "https://api.inaturalist.org/v1/observations";
const OBS_RANDOM_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const INAT_DATE_FETCH_PER_PAGE = 50;
const INAT_DATE_FETCH_MAX_PAGES = 5;

const STORAGE_KEY = "ddcg_v2";
const LEGACY_STATS_COOKIE = "ddcg_stats";
const FEEDBACK_MS = 450;

type TaxonSlot = "a" | "b";

interface TaxonPair {
  idA: number;
  idB: number;
  labelA: string;
  labelB: string;
}

interface StatsSnapshot {
  totalAttempts: number;
  totalCorrect: number;
  currentStreak: number;
  longestStreak: number;
  shownA: number;
  correctA: number;
  shownB: number;
  correctB: number;
}

interface PersistedState {
  activePair: TaxonPair;
  statsByPairKey: Record<string, StatsSnapshot>;
}

interface InatPhoto {
  url?: string;
}

interface InatObservation {
  taxon?: { id?: number };
  photos?: InatPhoto[];
  user?: { login?: string };
  time_observed_at?: string;
  observed_on?: string;
}

interface InatObservationsResponse {
  total_results?: number;
  results?: InatObservation[];
}

const STATS_DEFAULT: StatsSnapshot = {
  totalAttempts: 0,
  totalCorrect: 0,
  currentStreak: 0,
  longestStreak: 0,
  shownA: 0,
  correctA: 0,
  shownB: 0,
  correctB: 0,
};

const PRESETS: ReadonlyArray<{ id: string; title: string; pair: TaxonPair }> = [
  {
    id: "geese",
    title: "Cackling Goose / Canada Goose",
    pair: {
      idA: 59220,
      idB: 7089,
      labelA: "Cackling Goose",
      labelB: "Canada Goose",
    },
  },
  {
    id: "finches",
    title: "Purple Finch / House Finch",
    pair: {
      idA: 199841,
      idB: 199840,
      labelA: "Purple Finch",
      labelB: "House Finch",
    },
  },
  {
    id: "swallows",
    title: "Violet-green Swallow / Tree Swallow",
    pair: {
      idA: 11931,
      idB: 11935,
      labelA: "Violet-green Swallow",
      labelB: "Tree Swallow",
    },
  },
];

const DEFAULT_PAIR = PRESETS[0]!.pair;

function pairKey(pair: TaxonPair): string {
  return `${pair.idA}-${pair.idB}`;
}

function clonePair(pair: TaxonPair): TaxonPair {
  return { ...pair };
}

function getEl<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

const el = {
  placeholder: getEl<HTMLDivElement>("imagePlaceholder"),
  img: getEl<HTMLImageElement>("gooseImage"),
  credit: getEl<HTMLParagraphElement>("photoCredit"),
  feedback: getEl<HTMLDivElement>("feedback"),
  btnTaxonA: getEl<HTMLButtonElement>("btnTaxonA"),
  btnTaxonB: getEl<HTMLButtonElement>("btnTaxonB"),
  errorMsg: getEl<HTMLParagraphElement>("errorMsg"),
  statsModal: getEl<HTMLDialogElement>("statsModal"),
  settingsModal: getEl<HTMLDialogElement>("settingsModal"),
  statsTrigger: getEl<HTMLButtonElement>("statsTrigger"),
  settingsTrigger: getEl<HTMLButtonElement>("settingsTrigger"),
  statsClose: getEl<HTMLButtonElement>("statsClose"),
  settingsClose: getEl<HTMLButtonElement>("settingsClose"),
  presetList: getEl<HTMLUListElement>("presetList"),
  statCurrentStreak: getEl<HTMLElement>("statCurrentStreak"),
  statLongestStreak: getEl<HTMLElement>("statLongestStreak"),
  statTotalPct: getEl<HTMLElement>("statTotalPct"),
  statMatrixColGuessA: getEl<HTMLElement>("statMatrixColGuessA"),
  statMatrixColGuessB: getEl<HTMLElement>("statMatrixColGuessB"),
  statMatrixRowWhenA: getEl<HTMLElement>("statMatrixRowWhenA"),
  statMatrixRowWhenB: getEl<HTMLElement>("statMatrixRowWhenB"),
  statWhenAGuessA: getEl<HTMLElement>("statWhenAGuessA"),
  statWhenAGuessB: getEl<HTMLElement>("statWhenAGuessB"),
  statWhenBGuessA: getEl<HTMLElement>("statWhenBGuessA"),
  statWhenBGuessB: getEl<HTMLElement>("statWhenBGuessB"),
};

let roundActual: TaxonSlot | null = null;
let roundBusy = false;

function buildSearchParams(overrides: Record<string, string>): URLSearchParams {
  return new URLSearchParams({
    photos: "true",
    quality_grade: "research",
    ...overrides,
  });
}

async function fetchInatJson(searchParams: URLSearchParams): Promise<InatObservationsResponse> {
  const url = `${INAT_BASE}?${searchParams}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const hint = res.status === 403 ? " (rate limits or blocking)" : "";
    throw new Error(`iNaturalist error ${res.status}${hint}`);
  }
  return res.json() as Promise<InatObservationsResponse>;
}

function photoToMediumUrl(url: string): string {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small)\.(jpg|jpeg|png|webp)/i, "/medium.$2");
}

function isoDateUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function observedAtMs(obs: InatObservation): number {
  const s = obs.time_observed_at || obs.observed_on;
  if (!s) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

async function fetchObservationForRandomCutoff(taxonId: number): Promise<{
  imageUrl: string;
  login: string;
  observation: InatObservation;
}> {
  const now = Date.now();
  const cutoff = new Date(now - Math.random() * OBS_RANDOM_WINDOW_MS);
  const windowStart = new Date(now - OBS_RANDOM_WINDOW_MS);
  let d1 = isoDateUTC(windowStart);
  let d2 = isoDateUTC(cutoff);
  if (d1 > d2) {
    const swap = d1;
    d1 = d2;
    d2 = swap;
  }
  const cutoffMs = cutoff.getTime();

  for (let page = 1; page <= INAT_DATE_FETCH_MAX_PAGES; page++) {
    const data = await fetchInatJson(
      buildSearchParams({
        taxon_id: String(taxonId),
        per_page: String(INAT_DATE_FETCH_PER_PAGE),
        page: String(page),
        d1,
        d2,
        order_by: "observed_on",
        order: "desc",
      })
    );
    const list = data.results ?? [];
    for (const obs of list) {
      if (!obs || obs.taxon?.id !== taxonId) continue;
      if (!Array.isArray(obs.photos) || obs.photos.length === 0) continue;
      const obsMs = observedAtMs(obs);
      if (!Number.isFinite(obsMs) || obsMs > cutoffMs) continue;
      const rawUrl = obs.photos[0]!.url;
      if (!rawUrl) continue;
      const imageUrl = photoToMediumUrl(rawUrl);
      const login = obs.user?.login ?? "unknown";
      return { imageUrl, login, observation: obs };
    }
    if (list.length < INAT_DATE_FETCH_PER_PAGE) break;
  }

  throw new Error("Could not load a photo for this species. Try again.");
}

function readCookie(name: string): string | null {
  const prefix = `${name}=`;
  const parts = document.cookie.split(";").map((c) => c.trim());
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function writeCookie(name: string, value: string, maxAgeSeconds: number): void {
  const safe = encodeURIComponent(value);
  document.cookie = `${name}=${safe}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function clearLegacyStatsCookie(): void {
  writeCookie(LEGACY_STATS_COOKIE, "", 0);
}

interface LegacyStatsPartial {
  totalAttempts?: number;
  totalCorrect?: number;
  currentStreak?: number;
  longestStreak?: number;
  canadaShown?: number;
  canadaCorrect?: number;
  cacklingShown?: number;
  cacklingCorrect?: number;
}

function migrateLegacyCookie(): StatsSnapshot | null {
  const raw = readCookie(LEGACY_STATS_COOKIE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LegacyStatsPartial;
    const s: StatsSnapshot = { ...STATS_DEFAULT };
    if (typeof parsed.totalAttempts === "number") s.totalAttempts = parsed.totalAttempts;
    if (typeof parsed.totalCorrect === "number") s.totalCorrect = parsed.totalCorrect;
    if (typeof parsed.currentStreak === "number") s.currentStreak = parsed.currentStreak;
    if (typeof parsed.longestStreak === "number") s.longestStreak = parsed.longestStreak;
    if (typeof parsed.cacklingShown === "number") s.shownA = parsed.cacklingShown;
    if (typeof parsed.cacklingCorrect === "number") s.correctA = parsed.cacklingCorrect;
    if (typeof parsed.canadaShown === "number") s.shownB = parsed.canadaShown;
    if (typeof parsed.canadaCorrect === "number") s.correctB = parsed.canadaCorrect;
    clearLegacyStatsCookie();
    return s;
  } catch {
    return null;
  }
}

function loadPersisted(): PersistedState {
  const migrated = migrateLegacyCookie();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      const activePair =
        parsed.activePair &&
        typeof parsed.activePair.idA === "number" &&
        typeof parsed.activePair.idB === "number" &&
        typeof parsed.activePair.labelA === "string" &&
        typeof parsed.activePair.labelB === "string"
          ? clonePair(parsed.activePair)
          : clonePair(DEFAULT_PAIR);
      const statsByPairKey: Record<string, StatsSnapshot> = {};
      if (parsed.statsByPairKey && typeof parsed.statsByPairKey === "object") {
        for (const [k, v] of Object.entries(parsed.statsByPairKey)) {
          if (v && typeof v === "object") statsByPairKey[k] = { ...STATS_DEFAULT, ...v };
        }
      }
      const key = pairKey(activePair);
      if (migrated && !statsByPairKey[key]) {
        statsByPairKey[key] = migrated;
      } else if (migrated && statsByPairKey[key]) {
        const cur = statsByPairKey[key]!;
        if (cur.totalAttempts === 0 && migrated.totalAttempts > 0) {
          statsByPairKey[key] = migrated;
        }
      }
      return { activePair, statsByPairKey };
    }
  } catch {
    /* ignore */
  }

  const statsByPairKey: Record<string, StatsSnapshot> = {};
  if (migrated) {
    statsByPairKey[pairKey(DEFAULT_PAIR)] = migrated;
  }
  return { activePair: clonePair(DEFAULT_PAIR), statsByPairKey };
}

function savePersisted(state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function getActivePair(): TaxonPair {
  return loadPersisted().activePair;
}

function getCurrentStats(): StatsSnapshot {
  const { activePair, statsByPairKey } = loadPersisted();
  const key = pairKey(activePair);
  return statsByPairKey[key] ? { ...STATS_DEFAULT, ...statsByPairKey[key] } : { ...STATS_DEFAULT };
}

function saveCurrentStats(stats: StatsSnapshot): void {
  const state = loadPersisted();
  state.statsByPairKey[pairKey(state.activePair)] = { ...stats };
  savePersisted(state);
}

function setActivePair(pair: TaxonPair): void {
  const state = loadPersisted();
  state.activePair = clonePair(pair);
  const k = pairKey(pair);
  if (!state.statsByPairKey[k]) {
    state.statsByPairKey[k] = { ...STATS_DEFAULT };
  }
  savePersisted(state);
}

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${Math.round((100 * n) / d)}%`;
}

function formatStreak(n: number): string {
  return String(n);
}

function applyTaxonLabels(): void {
  const pair = getActivePair();
  el.btnTaxonA.textContent = pair.labelA;
  el.btnTaxonB.textContent = pair.labelB;

  const short = (s: string) => (s.length > 22 ? `${s.slice(0, 20)}…` : s);
  el.statMatrixColGuessA.textContent = short(pair.labelA);
  el.statMatrixColGuessB.textContent = short(pair.labelB);
  el.statMatrixRowWhenA.textContent = short(pair.labelA);
  el.statMatrixRowWhenB.textContent = short(pair.labelB);
}

function refreshStatsUI(): void {
  const s = getCurrentStats();
  el.statCurrentStreak.textContent = formatStreak(s.currentStreak);
  el.statLongestStreak.textContent = formatStreak(s.longestStreak);
  el.statTotalPct.textContent = pct(s.totalCorrect, s.totalAttempts);

  const wrongGuessBWhenA = Math.max(0, s.shownA - s.correctA);
  const wrongGuessAWhenB = Math.max(0, s.shownB - s.correctB);

  el.statWhenAGuessA.textContent = String(s.correctA);
  el.statWhenAGuessB.textContent = String(wrongGuessBWhenA);
  el.statWhenBGuessA.textContent = String(wrongGuessAWhenB);
  el.statWhenBGuessB.textContent = String(s.correctB);
}

function hideError(): void {
  el.errorMsg.classList.add("hidden");
  el.errorMsg.textContent = "";
}

function showError(msg: string): void {
  el.errorMsg.textContent = msg;
  el.errorMsg.classList.remove("hidden");
}

function setPhotoCredit(login: string | null | undefined): void {
  el.credit.replaceChildren();
  const safe = String(login ?? "").trim();
  if (!safe) return;

  el.credit.append(document.createTextNode("Photo via iNaturalist · observer "));
  if (safe === "unknown") {
    el.credit.append(document.createTextNode(`@${safe}`));
    return;
  }
  const a = document.createElement("a");
  a.href = `https://www.inaturalist.org/observations?user_id=${encodeURIComponent(safe)}`;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.className = "credit-link";
  a.textContent = `@${safe}`;
  el.credit.append(a);
}

function setLoading(loading: boolean): void {
  if (loading) {
    el.placeholder.classList.remove("hidden");
    el.img.classList.add("hidden");
  }
  el.btnTaxonA.disabled = loading || roundBusy;
  el.btnTaxonB.disabled = loading || roundBusy;
}

function hideFeedback(): void {
  el.feedback.classList.add("hidden");
  el.feedback.textContent = "";
  el.feedback.classList.remove("correct", "wrong");
}

function showFeedback(correct: boolean): void {
  el.feedback.textContent = correct ? "✓" : "✗";
  el.feedback.classList.remove("hidden", "correct", "wrong");
  el.feedback.classList.add(correct ? "correct" : "wrong");
}

function applyGuess(guess: TaxonSlot): void {
  if (roundBusy || roundActual === null) return;
  const actual = roundActual;
  const correct = guess === actual;

  roundBusy = true;
  el.btnTaxonA.disabled = true;
  el.btnTaxonB.disabled = true;
  showFeedback(correct);

  const stats = getCurrentStats();
  stats.totalAttempts += 1;
  if (correct) {
    stats.totalCorrect += 1;
    stats.currentStreak += 1;
    if (stats.currentStreak > stats.longestStreak) {
      stats.longestStreak = stats.currentStreak;
    }
  } else {
    stats.currentStreak = 0;
  }

  if (actual === "a") {
    stats.shownA += 1;
    if (correct) stats.correctA += 1;
  } else {
    stats.shownB += 1;
    if (correct) stats.correctB += 1;
  }

  saveCurrentStats(stats);
  refreshStatsUI();

  window.setTimeout(() => {
    hideFeedback();
    roundBusy = false;
    void startRound();
  }, FEEDBACK_MS);
}

async function startRound(): Promise<void> {
  hideError();
  hideFeedback();
  roundActual = null;
  setLoading(true);

  const pair = getActivePair();
  const actual: TaxonSlot = Math.random() < 0.5 ? "a" : "b";
  const taxonId = actual === "a" ? pair.idA : pair.idB;

  try {
    const { imageUrl, login } = await fetchObservationForRandomCutoff(taxonId);
    roundActual = actual;

    setPhotoCredit(login);
    const label = actual === "a" ? pair.labelA : pair.labelB;
    el.img.alt = `${label} (quiz image)`;

    const reveal = (): void => {
      el.placeholder.classList.add("hidden");
      el.img.classList.remove("hidden");
      el.btnTaxonA.disabled = false;
      el.btnTaxonB.disabled = false;
    };

    el.img.onload = reveal;
    el.img.onerror = () => {
      roundActual = null;
      showError("Image failed to load. Trying another…");
      el.placeholder.classList.remove("hidden");
      el.img.classList.add("hidden");
      window.setTimeout(() => void startRound(), 800);
    };

    el.img.removeAttribute("src");
    el.img.src = imageUrl;
    if (typeof el.img.decode === "function") {
      el.img.decode().then(reveal).catch(() => {});
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Something went wrong.";
    showError(`${msg} Retrying…`);
    el.placeholder.classList.remove("hidden");
    el.img.classList.add("hidden");
    setPhotoCredit(null);
    el.btnTaxonA.disabled = true;
    el.btnTaxonB.disabled = true;
    window.setTimeout(() => {
      hideError();
      void startRound();
    }, 2500);
  }
}

function openStats(): void {
  applyTaxonLabels();
  refreshStatsUI();
  el.statsModal.showModal();
}

function closeStats(): void {
  el.statsModal.close();
}

function openSettings(): void {
  el.settingsModal.showModal();
}

function closeSettings(): void {
  el.settingsModal.close();
}

function applyPresetById(presetId: string): void {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  setActivePair(preset.pair);
  applyTaxonLabels();
  buildPresetList();
  refreshStatsUI();
  closeSettings();
  void startRound();
}

function buildPresetList(): void {
  el.presetList.replaceChildren();
  const active = pairKey(getActivePair());
  for (const p of PRESETS) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "preset-btn";
    btn.textContent = p.title;
    if (pairKey(p.pair) === active) {
      btn.classList.add("preset-btn--active");
      btn.setAttribute("aria-current", "true");
    }
    btn.addEventListener("click", () => applyPresetById(p.id));
    li.appendChild(btn);
    el.presetList.appendChild(li);
  }
}

function boot(): void {
  try {
    localStorage.removeItem("ddcg_inat_jwt");
  } catch {
    /* ignore */
  }
  applyTaxonLabels();
  buildPresetList();
  refreshStatsUI();
  void startRound();
}

el.btnTaxonA.addEventListener("click", () => applyGuess("a"));
el.btnTaxonB.addEventListener("click", () => applyGuess("b"));

el.statsTrigger.addEventListener("click", openStats);
el.statsClose.addEventListener("click", closeStats);
el.settingsTrigger.addEventListener("click", openSettings);
el.settingsClose.addEventListener("click", closeSettings);

el.statsModal.addEventListener("click", (ev) => {
  if (ev.target === el.statsModal) closeStats();
});

el.settingsModal.addEventListener("click", (ev) => {
  if (ev.target === el.settingsModal) closeSettings();
});

boot();
