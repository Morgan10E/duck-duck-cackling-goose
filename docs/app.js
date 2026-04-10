const INAT_BASE = "https://api.inaturalist.org/v1/observations";
const TAXON_CACKLING = 59220;
const TAXON_CANADA = 7089;

/** How far back we draw a random cutoff when picking an observation (prior to `d2`). One year in MS. */
const OBS_RANDOM_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const INAT_DATE_FETCH_PER_PAGE = 1;

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
  statCurrentStreak: document.getElementById("statCurrentStreak"),
  statLongestStreak: document.getElementById("statLongestStreak"),
  statTotalPct: document.getElementById("statTotalPct"),
  statWhenCanadaGuessCanada: document.getElementById("statWhenCanadaGuessCanada"),
  statWhenCanadaGuessCackling: document.getElementById("statWhenCanadaGuessCackling"),
  statWhenCacklingGuessCanada: document.getElementById("statWhenCacklingGuessCanada"),
  statWhenCacklingGuessCackling: document.getElementById("statWhenCacklingGuessCackling"),
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
    const hint = res.status === 403 ? " (rate limits or blocking)" : "";
    throw new Error(`iNaturalist error ${res.status}${hint}`);
  }
  return res.json();
}

function photoToMediumUrl(url) {
  if (!url) return "";
  return url.replace(/\/(square|thumb|small)\.(jpg|jpeg|png|webp)/i, "/medium.$2");
}

function isoDateUTC(d) {
  return d.toISOString().slice(0, 10);
}

/** @param {{ time_observed_at?: string, observed_on?: string }} obs */
function observedAtMs(obs) {
  const s = obs.time_observed_at || obs.observed_on;
  if (!s) return NaN;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Picks a random instant in the last {@link OBS_RANDOM_WINDOW_MS}, then loads the newest
 * research-grade observation with photos for `taxonId` that is observed on or before that
 * instant (`order_by=observed_on`, `order=desc`).
 *
 * @param {number} taxonId
 * @returns {Promise<{ imageUrl: string, login: string, observation: object }>}
 */
async function fetchObservationForRandomCutoff(taxonId) {
  const now = Date.now();
  const cutoff = new Date(now - Math.random() * OBS_RANDOM_WINDOW_MS);
  let d2 = isoDateUTC(cutoff);

  const data = await fetchInatJson(
    buildSearchParams({
      taxon_id: String(taxonId),
      per_page: String(INAT_DATE_FETCH_PER_PAGE),
      d2,
      order_by: "observed_on",
      order: "desc",
    })
  );
  const list = data.results ?? [];
  for (const obs of list) {
    if (!Array.isArray(obs.photos) || obs.photos.length === 0) continue;
    const rawUrl = obs.photos[0].url;
    const imageUrl = photoToMediumUrl(rawUrl);
    const login = obs.user?.login ?? "unknown";
    return { imageUrl, login, observation: obs };
  }

  throw new Error("Could not load a photo for this species. Try again.");
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
    const merged = { ...STATS_DEFAULT, ...parsed };
    delete merged.cacklingGooseIndex;
    delete merged.canadaGooseIndex;
    return merged;
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
  el.statCurrentStreak.textContent = formatStreak(s.currentStreak);
  el.statLongestStreak.textContent = formatStreak(s.longestStreak);
  el.statTotalPct.textContent = pct(s.totalCorrect, s.totalAttempts);

  const canadaWrongCackling = Math.max(0, s.canadaShown - s.canadaCorrect);
  const cacklingWrongCanada = Math.max(0, s.cacklingShown - s.cacklingCorrect);

  el.statWhenCanadaGuessCanada.textContent = String(s.canadaCorrect);
  el.statWhenCanadaGuessCackling.textContent = String(canadaWrongCackling);
  el.statWhenCacklingGuessCanada.textContent = String(cacklingWrongCanada);
  el.statWhenCacklingGuessCackling.textContent = String(s.cacklingCorrect);
}

function hideError() {
  el.errorMsg.classList.add("hidden");
  el.errorMsg.textContent = "";
}

function showError(msg) {
  el.errorMsg.textContent = msg;
  el.errorMsg.classList.remove("hidden");
}

/** @param {string | null | undefined} login */
function setPhotoCredit(login) {
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
    const { imageUrl, login } = await fetchObservationForRandomCutoff(taxonId);
    roundActualCackling = actual;

    setPhotoCredit(login);
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
    setPhotoCredit(null);
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
