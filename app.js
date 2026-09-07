/* ---------------------------------------------------------------------
   The Allotment Ledger — client-side logic
   No data leaves the browser: the cached data/ipos.json is fetched once,
   everything else (search, odds, allocation) runs locally.
   --------------------------------------------------------------------- */

const state = {
  ipos: [],
  selected: null,
};

const els = {
  search: document.getElementById("ipo-search"),
  results: document.getElementById("search-results"),
  freshness: document.getElementById("data-freshness"),
  ipoSection: document.getElementById("ipo-section"),
  ipoCard: document.getElementById("ipo-card"),
  inputsSection: document.getElementById("inputs-section"),
  numPans: document.getElementById("num-pans"),
  totalMoney: document.getElementById("total-money"),
  calcBtn: document.getElementById("calc-btn"),
  resultsSection: document.getElementById("results-section"),
  resultsCard: document.getElementById("results-card"),
  lastUpdatedFooter: document.getElementById("last-updated-footer"),
};

const money = (n) =>
  n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN");

const pct = (p) =>
  p == null ? "no data" : (p * 100).toFixed(p < 0.01 ? 2 : 1) + "%";

/* ----------------------------- Load data ----------------------------- */

async function loadData() {
  try {
    const res = await fetch("data/ipos.json", { cache: "no-store" });
    const json = await res.json();
    state.ipos = json.ipos || [];
    if (json.generated_at) {
      const when = new Date(json.generated_at);
      els.freshness.textContent =
        `${state.ipos.length} live issue(s) tracked · list refreshed ${when.toLocaleString("en-IN")}`;
      els.lastUpdatedFooter.textContent = `Data snapshot: ${when.toLocaleString("en-IN")}.`;
    } else {
      els.freshness.textContent =
        "No data yet — the first automated fetch hasn't run. Check back shortly, or trigger the workflow manually.";
    }
  } catch (e) {
    els.freshness.textContent =
      "Couldn't load the data file. If you just deployed this, make sure data/ipos.json exists and the scrape workflow has run at least once.";
  }
}

/* ----------------------------- Search UI ------------------------------ */

els.search.addEventListener("input", () => {
  const q = els.search.value.trim().toLowerCase();
  if (!q) {
    els.results.hidden = true;
    return;
  }
  const matches = state.ipos.filter((ipo) => ipo.name.toLowerCase().includes(q)).slice(0, 12);

  els.results.innerHTML = "";
  if (matches.length === 0) {
    els.results.innerHTML = `<div class="search-empty">No live issue matches "${escapeHtml(els.search.value)}" in the current cache. It may not be open for bidding yet, or the data hasn't refreshed — try the exact company name, or check chittorgarh.com directly.</div>`;
  } else {
    matches.forEach((ipo) => {
      const row = document.createElement("div");
      row.className = "search-result-item";
      row.tabIndex = 0;
      row.innerHTML = `<span>${escapeHtml(ipo.name)}</span><span class="type-tag">${ipo.type}</span>`;
      row.addEventListener("click", () => selectIpo(ipo));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") selectIpo(ipo); });
      els.results.appendChild(row);
    });
  }
  els.results.hidden = false;
});

document.addEventListener("click", (e) => {
  if (!els.search.contains(e.target) && !els.results.contains(e.target)) {
    els.results.hidden = true;
  }
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------- Category modelling -------------------------

   For each IPO we build a list of categories an *individual* applicant can
   actually choose between, each with:
     - key, label
     - minInvestment (₹ an applicant must put in to qualify for that bucket)
     - probability (chance a single application in that bucket wins at least
       one minimum lot, estimated as 1 / subscription-times — see README for
       the reasoning and its limits)

   QIB is deliberately excluded: individuals can't apply as QIBs.
------------------------------------------------------------------------- */

function buildCategories(ipo) {
  const price = ipo.price_band_max || ipo.price_band_min;
  const lot = ipo.lot_size;
  const cats = [];

  if (!price || !lot) {
    return { cats, error: "Price band or lot size wasn't captured for this issue, so exact ₹ thresholds can't be computed." };
  }
  const lotValue = price * lot;

  const probFrom = (key) => {
    const c = ipo.categories && ipo.categories[key];
    const t = c && c.subscription_times;
    if (!t || t <= 0) return null;
    return Math.min(1, 1 / t);
  };

  if (ipo.type === "SME") {
    // Post-July-2025 SME rules: individual/retail minimum bid is 2 lots.
    const minLots = 2;
    cats.push({
      key: "retail",
      label: "Individual Investor (min. 2 lots)",
      minInvestment: minLots * lotValue,
      probability: probFrom("retail"),
    });
    const niiMinLots = Math.floor(200000 / lotValue) + 1;
    cats.push({
      key: "nii_total",
      label: "NII / HNI",
      minInvestment: Math.max(niiMinLots, minLots + 1) * lotValue,
      probability: probFrom("nii_total") ?? probFrom("shni") ?? probFrom("bhni"),
    });
  } else {
    // Mainboard
    cats.push({
      key: "retail",
      label: "Retail Individual (RII)",
      minInvestment: lotValue,
      maxInvestment: 200000,
      probability: probFrom("retail"),
    });

    const shniMinLots = Math.floor(200000 / lotValue) + 1;
    const shniProb = probFrom("shni") ?? probFrom("nii_total");
    cats.push({
      key: "shni",
      label: "sNII (₹2L–10L)",
      minInvestment: shniMinLots * lotValue,
      probability: shniProb,
    });

    const bhniMinLots = Math.floor(1000000 / lotValue) + 1;
    const bhniProb = probFrom("bhni") ?? probFrom("nii_total");
    cats.push({
      key: "bhni",
      label: "bNII (>₹10L)",
      minInvestment: bhniMinLots * lotValue,
      probability: bhniProb,
    });
  }

  return { cats, lotValue };
}

/* ------------------------------ Selecting an IPO ------------------------------ */

function selectIpo(ipo) {
  state.selected = ipo;
  els.search.value = ipo.name;
  els.results.hidden = true;
  renderIpoCard(ipo);
  els.ipoSection.hidden = false;
  els.inputsSection.hidden = false;
  els.resultsSection.hidden = true;
}

function renderIpoCard(ipo) {
  const { cats, error, lotValue } = buildCategories(ipo);

  let rowsHtml = "";
  cats.forEach((c) => {
    const tag = c.probability == null ? "" :
      c.probability < 0.15 ? "tight" : "loose";
    rowsHtml += `<tr>
      <td>${escapeHtml(c.label)}<br><span style="font-family:var(--mono);font-size:11px;color:#8a8464;">min ${money(c.minInvestment)}</span></td>
      <td class="odds-tag ${tag}">${pct(c.probability)}</td>
    </tr>`;
  });

  const priceText = ipo.price_band_min && ipo.price_band_max
    ? (ipo.price_band_min === ipo.price_band_max
        ? money(ipo.price_band_max)
        : `${money(ipo.price_band_min)} – ${money(ipo.price_band_max)}`)
    : "—";

  els.ipoCard.innerHTML = `
    <div class="ipo-heading">
      <h3>${escapeHtml(ipo.name)}</h3>
      <span class="type-badge">${ipo.type}</span>
    </div>
    <table class="ledger-rows">
      <tr><td>Price band</td><td>${priceText}</td></tr>
      <tr><td>Lot size</td><td>${ipo.lot_size ?? "—"} shares</td></tr>
      <tr><td>Bidding window</td><td>${escapeHtml(ipo.open_date || "—")} to ${escapeHtml(ipo.close_date || "—")}</td></tr>
      <tr><td>Overall subscription</td><td>${ipo.total_subscription_times ? ipo.total_subscription_times + "x" : "—"}</td></tr>
    </table>
    <h4 style="font-family:var(--mono);font-size:12px;color:#6b6650;margin:18px 0 4px;">Chance a single application wins, by category</h4>
    <table class="ledger-rows">${rowsHtml}</table>
    ${(ipo.notes && ipo.notes.length) ? `<div class="notes-box">${ipo.notes.map(escapeHtml).join("<br>")}</div>` : ""}
    ${error ? `<div class="notes-box">${escapeHtml(error)}</div>` : ""}
    ${ipo.last_updated_text ? `<p class="hint">Registrar figures as of ${escapeHtml(ipo.last_updated_text)}.</p>` : ""}
  `;
}

/* --------------------------- The optimizer ---------------------------

   Goal (per your instructions): maximise the probability that AT LEAST ONE
   of N independent PAN applications gets an allotment, given a total ₹
   budget M, by choosing which category each PAN applies under (or sits out).

   Each application in a lottery-style category is one independent ticket;
   applying more money within a category doesn't raise that ticket's odds
   (SEBI's draw-of-lots gives every valid application an equal shot at
   exactly one minimum lot) — so within a chosen category we always apply
   the *minimum* qualifying amount per PAN. That turns this into a small
   knapsack: choose non-negative integers n_i (PANs assigned to category i)
   to maximise  1 - Π (1-p_i)^n_i , i.e. maximise Σ n_i * -ln(1-p_i),
   subject to Σ n_i ≤ N and Σ n_i * cost_i ≤ M.

   With only a handful of categories this is solved exactly by exhaustive
   search over integer counts (see solve()).
------------------------------------------------------------------------- */

function solve(categories, N, M) {
  // Only categories with known odds and an affordable minimum are usable.
  const usable = categories
    .filter((c) => c.probability != null && c.probability > 0 && c.minInvestment > 0)
    .map((c) => ({ ...c, value: -Math.log(1 - Math.min(c.probability, 0.999999)) }));

  if (usable.length === 0) {
    return { assignments: [], probability: null, spent: 0, reason: "no-live-odds" };
  }

  // Sort cheapest-first; not required for correctness (search is exhaustive)
  // but keeps the search well-behaved for larger N.
  usable.sort((a, b) => a.minInvestment - b.minInvestment);

  let best = { value: -1, counts: new Array(usable.length).fill(0) };

  function recurse(idx, remainingN, remainingM, counts, valueSoFar) {
    if (idx === usable.length) {
      if (valueSoFar > best.value) {
        best = { value: valueSoFar, counts: counts.slice() };
      }
      return;
    }
    const cat = usable[idx];
    const maxByMoney = cat.minInvestment > 0 ? Math.floor(remainingM / cat.minInvestment) : 0;
    const maxCount = Math.max(0, Math.min(remainingN, maxByMoney));
    for (let n = maxCount; n >= 0; n--) {
      counts[idx] = n;
      recurse(idx + 1, remainingN - n, remainingM - n * cat.minInvestment, counts, valueSoFar + n * cat.value);
    }
    counts[idx] = 0;
  }

  recurse(0, N, M, new Array(usable.length).fill(0), 0);

  const assignments = usable
    .map((c, i) => ({ ...c, count: best.counts[i] }))
    .filter((c) => c.count > 0);

  const spent = assignments.reduce((s, c) => s + c.count * c.minInvestment, 0);
  const usedPans = assignments.reduce((s, c) => s + c.count, 0);

  // Probability of at least one win = 1 - probability every ticket loses.
  let surviveProb = 1;
  assignments.forEach((c) => {
    surviveProb *= Math.pow(1 - c.probability, c.count);
  });

  return {
    assignments,
    probability: assignments.length ? 1 - surviveProb : 0,
    spent,
    usedPans,
    leftoverPans: N - usedPans,
    leftoverMoney: M - spent,
  };
}

/* ------------------------------ Wire up UI ------------------------------ */

els.calcBtn.addEventListener("click", () => {
  const ipo = state.selected;
  if (!ipo) return;

  const N = Math.max(1, parseInt(els.numPans.value, 10) || 1);
  const M = Math.max(0, parseFloat(els.totalMoney.value) || 0);

  const { cats } = buildCategories(ipo);
  const result = solve(cats, N, M);

  renderResults(result, N, M);
  els.resultsSection.hidden = false;
  els.resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
});

function renderResults(result, N, M) {
  if (!result.assignments.length) {
    els.resultsCard.innerHTML = `<div class="empty-state">
      Either this issue doesn't have live category odds yet, or ₹${Math.round(M).toLocaleString("en-IN")}
      isn't enough to cover even one minimum lot in any category. Try a larger amount, or check back once
      bidding has opened and subscription figures start coming in.
    </div>`;
    return;
  }

  const tag = result.probability >= 0.5 ? "" : "tight";
  let rows = "";
  result.assignments.forEach((a) => {
    rows += `<tr>
      <td class="cat-name">${escapeHtml(a.label)}</td>
      <td>${a.count}</td>
      <td>${money(a.minInvestment)}</td>
      <td>${money(a.count * a.minInvestment)}</td>
      <td>${pct(a.probability)}</td>
    </tr>`;
  });

  const leftoverBits = [];
  if (result.leftoverPans > 0) leftoverBits.push(`${result.leftoverPans} PAN(s) unused — no category was worth putting them in at this budget`);
  if (result.leftoverMoney > 0) leftoverBits.push(`₹${Math.round(result.leftoverMoney).toLocaleString("en-IN")} left unallocated`);

  els.resultsCard.innerHTML = `
    <div class="headline-odds">
      <span class="figure ${tag}">${pct(result.probability)}</span>
      <span class="caption">estimated chance at least one of your ${N} PAN(s) gets an allotment</span>
    </div>
    <table class="alloc-table">
      <thead><tr><th>Apply as</th><th>PANs</th><th>₹ per PAN</th><th>₹ total</th><th>Odds per ticket</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${leftoverBits.length ? `<p class="leftover-note">${leftoverBits.join(" · ")}.</p>` : ""}
  `;
}

loadData();
