const INAT_BASE = "https://api.inaturalist.org/v1/observations";
const TAXON_CACKLING = 59220;
const TAXON_CANADA = 7089;

/**
 * Observation search returns HTTP 403 when `page` exceeds this limit (verified 2026-04).
 * With {@link INAT_OBSERVATIONS_PER_PAGE}, only the first N results are addressable by pagination.
 */
const INAT_OBSERVATIONS_MAX_PAGE = 200;
const INAT_OBSERVATIONS_PER_PAGE = 50;
const INAT_MAX_ACCESSIBLE_RESULTS = INAT_OBSERVATIONS_MAX_PAGE * INAT_OBSERVATIONS_PER_PAGE;

/** @type {Readonly<Record<'cackling' | 'canada', number>>} */
const TAXON_ID_BY_SPECIES = Object.freeze({
  cackling: TAXON_CACKLING,
  canada: TAXON_CANADA,
});

const COOKIE_NAME = "ddcg_stats";
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;
const FEEDBACK_MS = 450;

const STATS_DEFAULT = {
  totalAttempts: 0,
  totalCorrect: 0,
  currentStreak: 0,
  longestStreak: 0,
  canadaShown: 0,
  canadaCorrect: 0,
  cacklingShown: 0,
  cacklingCorrect: 0,
};

const el = {
  placeholder: document.getElementById("imagePlaceholder"),
  img: document.getElementById("gooseImage"),
  credit: document.getElementById("photoCredit"),
  feedback: document.getElementById("feedback"),
  btnCackling: document.getElementById("btnCackling"),
  btnCanada: document.getElementById("btnCanada"),
  errorMsg: document.getElementById("errorMsg"),
  statsModal: document.getElementById("statsModal"),
  statsTrigger: document.querySelector(".stats-trigger"),
  statsClose: document.getElementById("statsClose"),
  statLongestStreak: document.getElementById("statLongestStreak"),
  statTotalPct: document.getElementById("statTotalPct"),
  statCanadaPct: document.getElementById("statCanadaPct"),
  statCacklingPct: document.getElementById("statCacklingPct"),
};

/**
 * Which goose this round shows (`null` before the image is ready).
 * @type {'cackling' | 'canada' | null}
 */
let roundActualCackling = null;
let roundBusy = false;

function buildSearchParams(overrides) {
  const p = new URLSearchParams({
    photos: "true",
    quality_grade: "research",
    ...overrides,
  });
  return p;
}

async function fetchInatJson(searchParams) {
  const url = `${INAT_BASE}?${searchParams}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const hint =
      res.status === 403
        ? " (often page > 200 on this API, or rate limits)"
        : "";
    throw new Error(`iNaturalist error ${res.status}${hint}`);
  }
  return res.json();
}

function photoToMediumUrl(url) {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small)\.(jpg|jpeg|png|webp)/i, "/medium.$2");
}

/** @param {number} taxonId */
function gooseIndexKey(taxonId) {
  return taxonId === TAXON_CACKLING ? "cacklingGooseIndex" : "canadaGooseIndex";
}

/**
 * Next observation for this taxon uses a running index in cookies (random seed once per species),
 * then increments by one (mod wrapped size) after each successful pick.
 * Indices wrap within {@link INAT_MAX_ACCESSIBLE_RESULTS} because the API forbids `page` > 200.
 *
 * @param {number} taxonId
 * @returns {Promise<{ imageUrl: string, login: string, observation: object }>}
 */
async function fetchSequentialObservation(taxonId) {
  const countData = await fetchInatJson(
    buildSearchParams({ taxon_id: String(taxonId), per_page: "1" })
  );
  const total = countData.total_results ?? 0;
  if (total === 0) {
    throw new Error("No research-grade observations with photos for this species.");
  }

  const perPage = INAT_OBSERVATIONS_PER_PAGE;
  /** @type {number} */
  const wrappedTotal = Math.min(total, INAT_MAX_ACCESSIBLE_RESULTS);

  const key = gooseIndexKey(taxonId);
  const stats = loadStats();

  if (typeof stats[key] !== "number" || !Number.isFinite(stats[key])) {
    stats[key] = Math.floor(Math.random() * wrappedTotal);
    saveStats(stats);
  }

  let idx = ((Math.trunc(stats[key] ?? 0) % wrappedTotal) + wrappedTotal) % wrappedTotal;
  const maxTries = Math.min(wrappedTotal, 300);

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const page = Math.floor(idx / perPage) + 1;
    const offset = idx % perPage;
    const pageData = await fetchInatJson(
      buildSearchParams({
        taxon_id: String(taxonId),
        per_page: String(perPage),
        page: String(page),
      })
    );
    const list = pageData.results ?? [];
    const obs = list[offset];
    if (
      obs &&
      obs.taxon?.id === taxonId &&
      Array.isArray(obs.photos) &&
      obs.photos.length > 0
    ) {
      stats[key] = (idx + 1) % wrappedTotal;
      saveStats(stats);
      const rawUrl = obs.photos[0].url;
      const imageUrl = photoToMediumUrl(rawUrl);
      const login = obs.user?.login ?? "unknown";
      return { imageUrl, login, observation: obs };
    }
    idx = (idx + 1) % wrappedTotal;
  }

  throw new Error("Could not load a photo. Try again.");
}

function readCookie(name) {
  const prefix = `${name}=`;
  const parts = document.cookie.split(";").map((c) => c.trim());
  for (const part of parts) {
    if (part.startsWith(prefix)) {
      return decodeURIComponent(part.slice(prefix.length));
    }
  }
  return null;
}

function writeCookie(name, value, maxAgeSeconds) {
  const safe = encodeURIComponent(value);
  document.cookie = `${name}=${safe}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax`;
}

function loadStats() {
  const raw = readCookie(COOKIE_NAME);
  if (!raw) return { ...STATS_DEFAULT };
  try {
    const parsed = JSON.parse(raw);
    return { ...STATS_DEFAULT, ...parsed };
  } catch {
    return { ...STATS_DEFAULT };
  }
}

function saveStats(stats) {
  writeCookie(COOKIE_NAME, JSON.stringify(stats), COOKIE_MAX_AGE);
}

function pct(n, d) {
  if (d === 0) return "—";
  return `${Math.round((100 * n) / d)}%`;
}

function formatStreak(n) {
  return String(n);
}

function refreshStatsUI() {
  const s = loadStats();
  el.statLongestStreak.textContent = formatStreak(s.longestStreak);
  el.statTotalPct.textContent = pct(s.totalCorrect, s.totalAttempts);
  el.statCanadaPct.textContent = pct(s.canadaCorrect, s.canadaShown);
  el.statCacklingPct.textContent = pct(s.cacklingCorrect, s.cacklingShown);
}

function hideError() {
  el.errorMsg.classList.add("hidden");
  el.errorMsg.textContent = "";
}

function showError(msg) {
  el.errorMsg.textContent = msg;
  el.errorMsg.classList.remove("hidden");
}

function setLoading(loading) {
  if (loading) {
    el.placeholder.classList.remove("hidden");
    el.img.classList.add("hidden");
  }
  el.btnCackling.disabled = loading || roundBusy;
  el.btnCanada.disabled = loading || roundBusy;
}

function hideFeedback() {
  el.feedback.classList.add("hidden");
  el.feedback.textContent = "";
  el.feedback.classList.remove("correct", "wrong");
}

function showFeedback(correct) {
  el.feedback.textContent = correct ? "✓" : "✗";
  el.feedback.classList.remove("hidden", "correct", "wrong");
  el.feedback.classList.add(correct ? "correct" : "wrong");
}

/** @param {'cackling' | 'canada'} guess */
function applyGuess(guess) {
  if (roundBusy || roundActualCackling === null) return;
  const actual = roundActualCackling;
  const correct = guess === actual;

  roundBusy = true;
  el.btnCackling.disabled = true;
  el.btnCanada.disabled = true;
  showFeedback(correct);

  const stats = loadStats();
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

  if (actual === "cackling") {
    stats.cacklingShown += 1;
    if (correct) stats.cacklingCorrect += 1;
  } else {
    stats.canadaShown += 1;
    if (correct) stats.canadaCorrect += 1;
  }

  saveStats(stats);
  refreshStatsUI();

  window.setTimeout(() => {
    hideFeedback();
    roundBusy = false;
    startRound();
  }, FEEDBACK_MS);
}

async function startRound() {
  hideError();
  hideFeedback();
  roundActualCackling = null;
  setLoading(true);

  const actual = Math.random() < 0.5 ? "cackling" : "canada";
  const taxonId = TAXON_ID_BY_SPECIES[actual];

  try {
    const { imageUrl, login } = await fetchSequentialObservation(taxonId);
    roundActualCackling = actual;

    el.credit.textContent = login
      ? `Photo via iNaturalist · observer @${login}`
      : "";
    el.img.alt =
      actual === "cackling" ? "Cackling Goose (quiz image)" : "Canada Goose (quiz image)";

    const reveal = () => {
      el.placeholder.classList.add("hidden");
      el.img.classList.remove("hidden");
      el.btnCackling.disabled = false;
      el.btnCanada.disabled = false;
    };

    el.img.onload = reveal;
    el.img.onerror = () => {
      roundActualCackling = null;
      showError("Image failed to load. Trying another…");
      el.placeholder.classList.remove("hidden");
      el.img.classList.add("hidden");
      window.setTimeout(startRound, 800);
    };

    // Reset decode state so we never treat the *previous* round’s image as “already loaded”.
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
    el.credit.textContent = "";
    el.btnCackling.disabled = true;
    el.btnCanada.disabled = true;
    window.setTimeout(() => {
      hideError();
      startRound();
    }, 2500);
  }
}

function openStats() {
  refreshStatsUI();
  el.statsModal.showModal();
}

function closeStats() {
  el.statsModal.close();
}

function boot() {
  try {
    localStorage.removeItem("ddcg_inat_jwt");
  } catch {
    /* ignore */
  }
  refreshStatsUI();
  startRound();
}

el.btnCackling.addEventListener("click", () => applyGuess("cackling"));
el.btnCanada.addEventListener("click", () => applyGuess("canada"));

el.statsTrigger.addEventListener("click", openStats);
el.statsClose.addEventListener("click", closeStats);

el.statsModal.addEventListener("click", (ev) => {
  if (ev.target === el.statsModal) closeStats();
});

boot();
