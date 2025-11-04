import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const state = {
  year: 2010,
  buffer: 30,
  selectedIso3: null,
  showPlants: false,
  playing: false
};

const years = [1990, 2000, 2010];
const buffers = [30, 75, 300];

const mapWidth = 720;
const mapHeight = 430;

// detail chart layout
const detailWidth = 420;
const detailHeight = 260;
const detailMargin = { top: 30, right: 20, bottom: 40, left: 60 };
const innerDetailWidth = detailWidth - detailMargin.left - detailMargin.right;
const innerDetailHeight = detailHeight - detailMargin.top - detailMargin.bottom;

// DOM refs
const mapSvg = d3
  .select("#map-svg")
  .attr("viewBox", `0 0 ${mapWidth} ${mapHeight}`)
  .attr("preserveAspectRatio", "xMidYMid meet");

const detailSvg = d3
  .select("#detail-svg")
  .attr("viewBox", `0 0 ${detailWidth} ${detailHeight}`)
  .attr("preserveAspectRatio", "xMidYMid meet");

const tooltip = d3.select("#tooltip");
const yearSlider = d3.select("#year-slider");
const yearLabel = d3.select("#year-label");
const bufferSelect = d3.select("#buffer-select");
const playBtn = d3.select("#play-btn");
const togglePlants = d3.select("#toggle-plants");
const detailTitle = d3.select("#detail-title");
const detailSummary = d3.select("#detail-summary");

// Groups inside SVGs
const mapG = mapSvg.append("g").attr("class", "map-root");
const countriesG = mapG.append("g").attr("class", "countries");
const plantsG = mapG.append("g").attr("class", "plants-layer");

const detailG = detailSvg
  .append("g")
  .attr("transform", `translate(${detailMargin.left},${detailMargin.top})`);

// Scales & axes for detail chart (Q3: exposure vs distance)
const xDetail = d3
  .scaleBand()
  .domain(buffers) // [30, 75, 300]
  .range([0, innerDetailWidth])
  .padding(0.2);

const yDetail = d3.scaleLinear().range([innerDetailHeight, 0]);

const colorBuffer = d3
  .scaleOrdinal()
  .domain(buffers)
  .range(["#2166ac", "#1a9850", "#f46d43"]);

detailG
  .append("g")
  .attr("class", "x-axis")
  .attr("transform", `translate(0,${innerDetailHeight})`);

detailG.append("g").attr("class", "y-axis");

// y-axis label
detailG
  .append("text")
  .attr("class", "y-label")
  .attr("transform", "rotate(-90)")
  .attr("x", -innerDetailHeight / 2)
  .attr("y", -detailMargin.left + 15)
  .attr("text-anchor", "middle")
  .attr("font-size", 11)
  .text("% of population near plants");

// x-axis label
detailSvg
  .append("text")
  .attr("class", "x-label")
  .attr("x", detailMargin.left + innerDetailWidth / 2)
  .attr("y", detailHeight - 5)
  .attr("text-anchor", "middle")
  .attr("font-size", 11)
  .text("Distance from plant");

// Data containers
let world;
let countryRows;
let plantRows;

let exposureByKey = new Map(); // `${iso3}_${year}_${buffer}` -> row
let exposuresByCountry = d3.group(); // iso3 -> rows
let rankByYearBuffer = new Map(); // `${year}_${buffer}` -> Map(iso3 -> rank)

// NEW: change in exposure per decade (absolute people)
let deltaExposureByKey = new Map(); // `${iso3}_${year}_${buffer}` -> Δpop_near vs previous decade (clipped at 0)
let maxDeltaByBuffer = new Map();   // buffer -> max positive Δpop_near

function keyExposure(iso3, year, buffer) {
  return `${iso3}_${year}_${buffer}`;
}

function keyYearBuffer(year, buffer) {
  return `${year}_${buffer}`;
}

function featureIso3(f) {
  const p = f.properties || {};
  const alias = { ANT: "NLD", KOS: "XKX" }; // expand if needed
  const candidates = [
    f.id,
    p.iso_a3,
    p.ISO_A3,
    p.adm0_a3,
    p.ADM0_A3,
    p.iso3,
    p.ISO3
  ];
  for (const c of candidates) {
    if (!c) continue;
    const s = c.toString().trim();
    if (/^[A-Za-z]{3}$/.test(s)) {
      const up = s.toUpperCase();
      return alias[up] || up;
    }
  }
  return null;
}

async function loadData() {
  [world, countryRows, plantRows] = await Promise.all([
    d3.json("./data/world.geojson"),
    d3.csv("./data/country_exposure_long.csv", d3.autoType),
    d3.csv("./data/plants_exposure_clean.csv", d3.autoType)
  ]);

  // keep only our chosen buffers
  countryRows = countryRows.filter(d => buffers.includes(d.buffer_km));

  // Build exposure lookup
  countryRows.forEach(d => {
    exposureByKey.set(keyExposure(d.iso3, d.year, d.buffer_km), d);
  });

  exposuresByCountry = d3.group(countryRows, d => d.iso3);

  // Ranks per (year, buffer) by pct_near
  years.forEach(year => {
    buffers.forEach(buffer => {
      const subset = countryRows.filter(
        d => d.year === year && d.buffer_km === buffer && d.pct_near != null
      );
      subset.sort((a, b) => d3.descending(a.pct_near, b.pct_near));
      const map = new Map();
      subset.forEach((d, i) => map.set(d.iso3, i + 1));
      rankByYearBuffer.set(keyYearBuffer(year, buffer), map);
    });
  });

  // NEW: precompute decade change in pop_near for Q1
  deltaExposureByKey = new Map();
  maxDeltaByBuffer = new Map();

  const grouped = d3.group(countryRows, d => d.iso3, d => d.buffer_km);
  grouped.forEach((byBuffer, iso3) => {
    byBuffer.forEach((rows, buffer) => {
      const sorted = rows.slice().sort((a, b) => d3.ascending(a.year, b.year));
      let prev = null;
      for (const r of sorted) {
        if (!prev) {
          // first snapshot has no "change" yet
          deltaExposureByKey.set(keyExposure(iso3, r.year, buffer), null);
        } else {
          let delta = r.pop_near - prev.pop_near;
          if (!isFinite(delta)) delta = null;
          // focus on newly exposed people; drop decreases
          if (delta != null && delta < 0) delta = 0;
          deltaExposureByKey.set(keyExposure(iso3, r.year, buffer), delta);
          if (delta != null) {
            const old = maxDeltaByBuffer.get(buffer) || 0;
            if (delta > old) maxDeltaByBuffer.set(buffer, delta);
          }
        }
        prev = r;
      }
    });
  });

  initMap();
  initDetailChart();
  initControls();
  renderAll();
}

function initMap() {
  const projection = d3.geoNaturalEarth1().fitSize([mapWidth, mapHeight], world);
  const geoPath = d3.geoPath().projection(projection);

  mapG.node().__projection__ = projection;
  mapG.node().__path__ = geoPath;

  const countryPaths = countriesG
    .selectAll("path.country")
    .data(world.features)
    .join("path")
    .attr("class", "country")
    .attr("d", geoPath)
    .attr("stroke", "#555")
    .attr("stroke-width", 0.3)
    .attr("fill", "#eee")
    .on("mousemove", (event, d) => {
      const iso3 = featureIso3(d);
      const row =
        iso3 && exposureByKey.get(keyExposure(iso3, state.year, state.buffer));
      const pct = row?.pct_near;
      const popNear = row?.pop_near;
      const numPlants = row?.num_plants;
      const delta =
        iso3 &&
        deltaExposureByKey.get(keyExposure(iso3, state.year, state.buffer));
      const name =
        d.properties?.name ||
        d.properties?.ADMIN ||
        d.properties?.NAME ||
        "Unknown";

      const lines = [];
      lines.push(`<strong>${name}</strong>`);

      if (state.year === 1990) {
        lines.push(`Baseline exposure in 1990, within ${state.buffer} km`);
      } else {
        const prevYear = state.year - 10;
        lines.push(`New exposure ${prevYear}–${state.year}, within ${state.buffer} km`);
      }

      if (pct == null || popNear == null) {
        lines.push("No exposure data");
      } else {
        lines.push(
          `People near plants in ${state.year}: ${(popNear / 1e6).toFixed(2)}M`
        );
        lines.push(`Share of population: ${pct.toFixed(1)}%`);
      }

      if (state.year !== 1990 && delta != null) {
        if (delta > 0) {
          lines.push(
            `Newly exposed since ${state.year - 10}: ${(delta / 1e6).toFixed(
              2
            )}M`
          );
        } else {
          lines.push(`No newly exposed people in this decade`);
        }
      }

      if (numPlants != null) {
        lines.push(`# of plants: ${numPlants}`);
      }

      tooltip
        .style("display", "block")
        .html(lines.join("<br/>"))
        .style("left", event.pageX + 12 + "px")
        .style("top", event.pageY + 12 + "px");
    })
    .on("mouseout", () => {
      tooltip.style("display", "none");
    })
    .on("click", (event, d) => {
      const iso3 = featureIso3(d);
      if (!iso3) return;
      state.selectedIso3 = iso3;
      renderAll();
    });

  mapG.node().__countryPaths__ = countryPaths;

  // zoom
  const zoom = d3.zoom().scaleExtent([1, 6]).on("zoom", event => {
    mapG.attr("transform", event.transform);
  });

  mapSvg.call(zoom);
}

function initDetailChart() {
  // legend for buffers
  const legend = detailSvg
    .append("g")
    .attr("class", "buffer-legend")
    .attr("transform", "translate(60,15)");

  const legendItem = legend
    .selectAll("g.item")
    .data(buffers)
    .join("g")
    .attr("class", "item")
    .attr("transform", (d, i) => `translate(${i * 100},0)`);

  legendItem
    .append("rect")
    .attr("x", 0)
    .attr("y", -6)
    .attr("width", 16)
    .attr("height", 8)
    .attr("fill", d => colorBuffer(d));

  legendItem
    .append("text")
    .attr("x", 22)
    .attr("y", 1)
    .attr("font-size", 11)
    .text(d => `${d} km`);
}

function initControls() {
  yearSlider
    .attr("min", d3.min(years))
    .attr("max", d3.max(years))
    .attr("step", 10)
    .property("value", state.year);

  yearLabel.text(state.year);

  yearSlider.on("input", () => {
    state.year = +yearSlider.property("value");
    yearLabel.text(state.year);
    renderAll();
  });

  bufferSelect
    .property("value", String(state.buffer))
    .on("change", () => {
      state.buffer = +bufferSelect.property("value");
      renderAll();
    });

  togglePlants.on("change", () => {
    state.showPlants = togglePlants.property("checked");
    renderPlants();
  });

  playBtn.on("click", () => {
    if (state.playing) {
      stopPlayback();
    } else {
      startPlayback();
    }
  });
}

function renderAll() {
  renderMapFills();
  renderPlants();
  renderDetail();
}

// Choropleth fills & legend
function renderMapFills() {
  const countryPaths = mapG.node().__countryPaths__;
  if (!countryPaths) return;

  if (state.year === 1990) {
    // baseline exposure map
    const subset = countryRows.filter(
      d =>
        d.year === 1990 &&
        d.buffer_km === state.buffer &&
        d.pct_near != null
    );
    const maxPct = d3.max(subset, d => d.pct_near) || 1;

    const color = d3
      .scaleSequential()
      .domain([0, maxPct])
      .interpolator(d3.interpolateYlOrRd);

    countryPaths
      .transition()
      .duration(400)
      .attr("fill", d => {
        const iso3 = featureIso3(d);
        const row =
          iso3 && exposureByKey.get(keyExposure(iso3, 1990, state.buffer));
        const pct = row?.pct_near;
        if (pct == null) return "#eeeeee";
        return color(pct);
      })
      .attr("stroke-width", d => {
        const iso3 = featureIso3(d);
        return iso3 === state.selectedIso3 ? 1.2 : 0.4;
      })
      .attr("stroke", d => {
        const iso3 = featureIso3(d);
        return iso3 === state.selectedIso3 ? "#111" : "#555";
      });

    d3.select("#map-container h2").text("Baseline exposure in 1990");
    renderChoroplethLegend(color, maxPct, "baseline");
  } else {
    // change map: newly exposed people per decade
    const maxDeltaPeople = maxDeltaByBuffer.get(state.buffer) || 1;
    const maxDeltaMillions = maxDeltaPeople / 1e6;

    const color = d3
      .scaleSequential()
      .domain([0, maxDeltaMillions])
      .interpolator(d3.interpolateYlOrRd);

    countryPaths
      .transition()
      .duration(400)
      .attr("fill", d => {
        const iso3 = featureIso3(d);
        const deltaPeople =
          iso3 &&
          deltaExposureByKey.get(
            keyExposure(iso3, state.year, state.buffer)
          );
        if (deltaPeople == null || deltaPeople <= 0) return "#eeeeee";
        const valM = deltaPeople / 1e6;
        return color(valM);
      })
      .attr("stroke-width", d => {
        const iso3 = featureIso3(d);
        return iso3 === state.selectedIso3 ? 1.2 : 0.4;
      })
      .attr("stroke", d => {
        const iso3 = featureIso3(d);
        return iso3 === state.selectedIso3 ? "#111" : "#555";
      });

    const prevYear = state.year - 10;
    d3
      .select("#map-container h2")
      .text(`Newly exposed people, ${prevYear}–${state.year}`);
    renderChoroplethLegend(color, maxDeltaMillions, "delta");
  }
}

function renderChoroplethLegend(color, maxVal, mode) {
  const legendRoot = d3.select("#map-legend");
  legendRoot.selectAll("*").remove();

  const legendWidth = 300;
  const legendHeight = 55;  // more vertical space

  const svg = legendRoot
    .append("svg")
    .attr("width", legendWidth)
    .attr("height", legendHeight);

  const gradId = `legend-gradient-${mode}`;

  // gradient definition
  const defs = svg.append("defs");
  const gradient = defs
    .append("linearGradient")
    .attr("id", gradId)
    .attr("x1", "0%")
    .attr("x2", "100%")
    .attr("y1", "0%")
    .attr("y2", "0%");

  const stops = d3.range(0, 1.0001, 0.1);
  stops.forEach(t => {
    gradient
      .append("stop")
      .attr("offset", `${t * 100}%`)
      .attr("stop-color", color(t * maxVal));
  });

  // color bar
  svg
    .append("rect")
    .attr("x", 0)
    .attr("y", 8)              // slightly lower
    .attr("width", legendWidth)
    .attr("height", 10)
    .attr("rx", 3)
    .attr("fill", `url(#${gradId})`);

  // axis under the bar
  const scale = d3
    .scaleLinear()
    .domain([0, maxVal])
    .range([0, legendWidth]);

  const axis = d3
    .axisBottom(scale)
    .ticks(4)
    .tickSize(4)
    .tickFormat(d =>
      mode === "baseline" ? d.toFixed(0) + "%" : d.toFixed(1) + "M"
    );

  svg
    .append("g")
    .attr("transform", "translate(0,26)")  // move axis down
    .call(axis)
    .call(g => g.select(".domain").remove())
    .call(g => g.selectAll("text").attr("font-size", 10));

  const labelText =
    mode === "baseline"
      ? "Share of people living near nuclear plants"
      : "New people living near nuclear plants since previous decade";

  svg
    .append("text")
    .attr("x", 0)
    .attr("y", 54)             // well below axis ticks
    .attr("font-size", 11)
    .text(labelText);
}

// Plant overlay
function renderPlants() {
  plantsG.selectAll("*").remove();
  if (!state.showPlants) return;

  const projection = mapG.node().__projection__;
  if (!projection) return;

  const yearKey = `pop${state.buffer}_${state.year}`;
  const rows = plantRows.filter(d => d[yearKey] != null);
  const maxPop = d3.max(rows, d => d[yearKey]) || 1;

  const size = d3
    .scaleSqrt()
    .domain([0, maxPop])
    .range([1, 10]);

  plantsG
    .selectAll("circle.plant")
    .data(rows)
    .join("circle")
    .attr("class", "plant")
    .attr("cx", d => projection([d.lon, d.lat])[0])
    .attr("cy", d => projection([d.lon, d.lat])[1])
    .attr("r", d => size(d[yearKey]))
    .attr("fill", "rgba(0, 0, 0, 0.15)")
    .attr("stroke", "rgba(0, 0, 0, 0.7)")
    .attr("stroke-width", 0.6)
    .on("mousemove", (event, d) => {
      const millions = d[yearKey] / 1e6;
      const lines = [
        `<strong>${d.plant}</strong> (${d.country})`,
        `Reactors: ${d.num_reactors}`,
        `${state.buffer} km population, ${state.year}: ${millions.toFixed(2)}M`
      ];
      tooltip
        .style("display", "block")
        .html(lines.join("<br/>"))
        .style("left", event.pageX + 12 + "px")
        .style("top", event.pageY + 12 + "px");
    })
    .on("mouseout", () => {
      tooltip.style("display", "none");
    });
}

// Detail panel (Q3: how exposure is distributed across distances)
function renderDetail() {
  const iso3 = state.selectedIso3;
  if (!iso3 || !exposuresByCountry.has(iso3)) {
    detailTitle.text("Click a country to see its exposure profile");
    detailSummary.text("");
    detailG.selectAll(".bar").remove();

    yDetail.domain([0, 10]);
    detailG
      .select(".x-axis")
      .call(d3.axisBottom(xDetail).tickFormat(d => d + " km"));
    detailG
      .select(".y-axis")
      .call(d3.axisLeft(yDetail).ticks(5).tickFormat(d => d + "%"));
    return;
  }

  const rows = exposuresByCountry.get(iso3);
  const name = rows[0].country;

  detailTitle.text(`Exposure profile in ${name}, ${state.year}`);

  // rows for current year (one per buffer)
  const yearRows = rows.filter(d => d.year === state.year);
  const data = buffers.map(b => {
    const r = yearRows.find(d => d.buffer_km === b);
    return {
      buffer_km: b,
      pct_near: r ? r.pct_near : 0,
      pop_near: r ? r.pop_near : 0,
      num_plants: r ? r.num_plants : 0
    };
  });

  const maxPct = d3.max(data, d => d.pct_near || 0) || 1;
  yDetail.domain([0, maxPct * 1.1]);

  detailG
    .select(".x-axis")
    .call(d3.axisBottom(xDetail).tickFormat(d => d + " km"));

  detailG
    .select(".y-axis")
    .call(d3.axisLeft(yDetail).ticks(5).tickFormat(d => d + "%"));

  const bars = detailG.selectAll("rect.bar").data(data, d => d.buffer_km);

  bars
    .join(
      enter =>
        enter
          .append("rect")
          .attr("class", "bar")
          .attr("x", d => xDetail(d.buffer_km))
          .attr("width", xDetail.bandwidth())
          .attr("y", d => yDetail(d.pct_near))
          .attr("height", d => yDetail(0) - yDetail(d.pct_near))
          .attr("fill", d => colorBuffer(d.buffer_km)),
      update =>
        update
          .transition()
          .duration(400)
          .attr("x", d => xDetail(d.buffer_km))
          .attr("width", xDetail.bandwidth())
          .attr("y", d => yDetail(d.pct_near))
          .attr("height", d => yDetail(0) - yDetail(d.pct_near))
    );

  // bar tooltip
  detailG
    .selectAll("rect.bar")
    .on("mousemove", (event, d) => {
      const lines = [
        `<strong>${name}</strong>`,
        `${d.buffer_km} km: ${d.pct_near.toFixed(1)}% of population`,
        `People near plants: ${(d.pop_near / 1e6).toFixed(2)}M`,
        `Plants: ${d.num_plants}`
      ];
      tooltip
        .style("display", "block")
        .html(lines.join("<br/>"))
        .style("left", event.pageX + 12 + "px")
        .style("top", event.pageY + 12 + "px");
    })
    .on("mouseout", () => {
      tooltip.style("display", "none");
    });

  // narrative summary: newly exposed + concentration & rank
  const current = data.find(d => d.buffer_km === state.buffer);
  const key = keyYearBuffer(state.year, state.buffer);
  const rankMap = rankByYearBuffer.get(key);
  const rank = rankMap ? rankMap.get(iso3) : null;
  const denom = rankMap ? rankMap.size : null;
  const pctRank = rank && denom ? ((rank / denom) * 100).toFixed(0) : null;

  const pieces = [];

  if (current) {
    pieces.push(
      `${name} — in ${state.year}, about ${current.pct_near.toFixed(
        1
      )}% of people live within ${state.buffer} km of a nuclear plant.`
    );
  }

  // change vs previous decade at current buffer
  if (state.year !== 1990 && current) {
    const prevYear = state.year - 10;
    const prevRow = rows.find(
      d => d.year === prevYear && d.buffer_km === state.buffer
    );
    if (prevRow) {
      const deltaPeople = current.pop_near - prevRow.pop_near;
      const deltaPct = current.pct_near - prevRow.pct_near;
      if (deltaPeople > 0 || deltaPct !== 0) {
        pieces.push(
          `Compared with ${prevYear}, this is ${
            deltaPeople > 0 ? "an increase" : "no change"
          } of ${(deltaPeople / 1e6).toFixed(
            2
          )}M people (${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(
            1
          )} percentage points) living near plants.`
        );
      }
    }
  }

  // global rank at selected buffer
  if (pctRank && rank) {
    pieces.push(
      `This places ${name} around the top ${pctRank}% most exposed countries at ${state.buffer} km (rank ${rank} of ${denom}).`
    );
  }

  // distance concentration (Q3)
  const nearRow = data.find(d => d.buffer_km === 30);
  const farRow = data.find(d => d.buffer_km === 300);
  if (nearRow && farRow && farRow.pct_near > 0) {
    const concentration = nearRow.pct_near / farRow.pct_near;
    if (concentration > 0.7) {
      pieces.push(
        "Exposure is highly concentrated close to plants: most people living near nuclear plants are within 30 km."
      );
    } else if (concentration < 0.3) {
      pieces.push(
        "Exposure is mostly from people further away: only a small share of exposed people are within 30 km."
      );
    } else {
      pieces.push(
        "Exposure is fairly evenly spread between people very close to plants and those further out."
      );
    }
  }

  detailSummary.text(pieces.join(" "));
}

// playback
let playTimer = null;

function startPlayback() {
  state.playing = true;
  playBtn.text("Pause ❚❚");

  let idx = years.indexOf(state.year);
  if (idx < 0) idx = 0;

  playTimer = setInterval(() => {
    idx = (idx + 1) % years.length;
    state.year = years[idx];
    yearSlider.property("value", state.year);
    yearLabel.text(state.year);
    renderAll();
  }, 1200);
}

function stopPlayback() {
  state.playing = false;
  playBtn.text("Play ▶");
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
}

// go
loadData().catch(err => {
  console.error(err);
  d3.select("#app").append("p").text("Failed to load data.");
});