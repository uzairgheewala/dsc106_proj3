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
const detailWidth = 420;
const detailHeight = 260;

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
const detailG = detailSvg.append("g").attr("transform", "translate(50,20)");

// Scales & axes for detail chart
// const xDetail = d3.scalePoint().domain(years).range([0, detailWidth - 80]);
// const yDetail = d3.scaleLinear().range([detailHeight - 60, 0]);
const xDetail = d3
  .scaleBand()
  .domain(buffers)             // [30, 75, 300]
  .range([0, detailWidth - 80])
  .padding(0.2);

const yDetail = d3
  .scaleLinear()
  .range([detailHeight - 60, 0]);

const colorBuffer = d3
  .scaleOrdinal()
  .domain(buffers)
  .range(["#2166ac", "#1a9850", "#f46d43"]);

detailG
  .append("g")
  .attr("class", "x-axis")
  .attr("transform", `translate(0,${detailHeight - 60})`);
detailG.append("g").attr("class", "y-axis");

detailG
  .append("text")
  .attr("class", "y-label")
  .attr("x", -30)
  .attr("y", -10)
  .attr("text-anchor", "start")
  .attr("font-size", 11)
  .text("% of population near plants");

// Data containers
let world;
let countryRows;
let plantRows;

let exposureByKey = new Map(); // `${iso3}_${year}_${buffer}` -> row
let exposuresByCountry = d3.group(); // iso3 -> rows
let rankByYearBuffer = new Map(); // `${year}_${buffer}` -> Map(iso3 -> rank)

function keyExposure(iso3, year, buffer) {
  return `${iso3}_${year}_${buffer}`;
}

function keyYearBuffer(year, buffer) {
  return `${year}_${buffer}`;
}

function featureIso3(f) {
  const p = f.properties || {};
  const alias = { ANT: "NLD", "KOS": "XKX" }; // expand if needed
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

  // Filter to the buffers we care about, just in case
  countryRows = countryRows.filter(d => buffers.includes(d.buffer_km));

  // Build exposure lookup
  countryRows.forEach(d => {
    exposureByKey.set(
      keyExposure(d.iso3, d.year, d.buffer_km),
      d
    );
  });

  exposuresByCountry = d3.group(countryRows, d => d.iso3);

  // Precompute ranks per (year, buffer) by pct_near
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

  initMap();
  initDetailChart();
  initControls();
  renderAll();
}

function initMap() {
  const projection = d3.geoNaturalEarth1()
    .fitSize([mapWidth, mapHeight], world);

  const geoPath = d3.geoPath().projection(projection);

  mapG.attr("data-projection", "geoNaturalEarth1"); // just for debugging

  // save projection for plants use
  mapG.node().__projection__ = projection;
  mapG.node().__path__ = geoPath;

  // base countries
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
        iso3 &&
        exposureByKey.get(
          keyExposure(iso3, state.year, state.buffer)
        );
      const pct = row?.pct_near;
      const popNear = row?.pop_near;
      const numPlants = row?.num_plants;
      const name =
        d.properties?.name ||
        d.properties?.ADMIN ||
        d.properties?.NAME ||
        "Unknown";

      const lines = [];
      lines.push(`<strong>${name}</strong>`);
      lines.push(`Year: ${state.year}, ${state.buffer} km`);

      if (pct == null) {
        lines.push("No exposure data");
      } else {
        lines.push(
          `Share near plants: ${pct.toFixed(1)}%`
        );
        if (popNear != null) {
          lines.push(
            `People near plants: ${(popNear / 1e6).toFixed(2)}M`
          );
        }
        if (numPlants != null) {
          lines.push(`# of plants: ${numPlants}`);
        }
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

  // add simple zoom
  const zoom = d3.zoom()
    .scaleExtent([1, 6])
    .on("zoom", (event) => {
      mapG.attr("transform", event.transform);
    });

  mapSvg.call(zoom);
}

function initDetailChart() {
  detailG
    .append("text")
    .attr("class", "x-label")
    .attr("x", detailWidth - 90)
    .attr("y", detailHeight - 20)
    .attr("text-anchor", "end")
    .attr("font-size", 11)
    .text("Year");

  // legend for buffers
  const legend = detailSvg
    .append("g")
    .attr("class", "buffer-legend")
    .attr("transform", "translate(60,10)");

  const legendItem = legend
    .selectAll("g.item")
    .data(buffers)
    .join("g")
    .attr("class", "item")
    .attr("transform", (d, i) => `translate(${i * 100},0)`);

  legendItem
    .append("line")
    .attr("x1", 0)
    .attr("x2", 18)
    .attr("y1", 0)
    .attr("y2", 0)
    .attr("stroke-width", 3)
    .attr("stroke", d => colorBuffer(d));

  legendItem
    .append("text")
    .attr("x", 24)
    .attr("y", 4)
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

  const subset = countryRows.filter(
    d =>
      d.year === state.year &&
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
        iso3 &&
        exposureByKey.get(
          keyExposure(iso3, state.year, state.buffer)
        );
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

  renderChoroplethLegend(color, maxPct);
}

function renderChoroplethLegend(color, maxPct) {
  const legendRoot = d3.select("#map-legend");
  legendRoot.selectAll("*").remove();

  const legendWidth = 180;
  const legendHeight = 10;
  const n = 80;

  const canvas = legendRoot
    .append("canvas")
    .attr("width", n)
    .attr("height", 1)
    .style("width", legendWidth + "px")
    .style("height", legendHeight + "px");

  const ctx = canvas.node().getContext("2d");
  for (let i = 0; i < n; ++i) {
    ctx.fillStyle = color((i / (n - 1)) * maxPct);
    ctx.fillRect(i, 0, 1, 1);
  }

  const svg = legendRoot
    .append("svg")
    .attr("width", legendWidth)
    .attr("height", 24);

  const scale = d3.scaleLinear().domain([0, maxPct]).range([0, legendWidth]);
  const axis = d3
    .axisBottom(scale)
    .ticks(4)
    .tickFormat(d => d.toFixed(0) + "%");

  svg
    .append("g")
    .attr("transform", `translate(0,10)`)
    .call(axis)
    .call(g => g.select(".domain").remove());

  legendRoot
    .append("div")
    .style("font-size", "11px")
    .style("margin-top", "2px")
    .text("Share of people living near nuclear plants");
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
    .attr("fill", "rgba(0, 0, 0, 0.15)")   // light fill
    .attr("stroke", "rgba(0, 0, 0, 0.7)")  // darker ring
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

// Detail panel
function renderDetail() {
  const iso3 = state.selectedIso3;
  if (!iso3 || !exposuresByCountry.has(iso3)) {
    detailTitle.text("Click a country to see its exposure profile");
    detailSummary.text("");
    detailG.selectAll(".bar").remove();
    detailG.selectAll(".x-axis").call(
      d3.axisBottom(xDetail).tickFormat(d => d + " km")
    );
    detailG.select(".y-axis").call(d3.axisLeft(yDetail.domain([0, 1])));
    return;
  }

  const rows = exposuresByCountry.get(iso3);
  const name = rows[0].country;

  detailTitle.text(`Exposure profile in ${name}, ${state.year}`);

  // take only rows for the current year, one per buffer
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
      enter => enter
        .append("rect")
        .attr("class", "bar")
        .attr("x", d => xDetail(d.buffer_km))
        .attr("width", xDetail.bandwidth())
        .attr("y", d => yDetail(d.pct_near))
        .attr("height", d => yDetail(0) - yDetail(d.pct_near))
        .attr("fill", d => colorBuffer(d.buffer_km)),
      update => update
        .transition()
        .duration(400)
        .attr("x", d => xDetail(d.buffer_km))
        .attr("width", xDetail.bandwidth())
        .attr("y", d => yDetail(d.pct_near))
        .attr("height", d => yDetail(0) - yDetail(d.pct_near))
    );

  // bars tooltip
  detailG.selectAll("rect.bar")
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

  // narrative summary: concentration + rank
  const current = data.find(d => d.buffer_km === state.buffer);
  const key = keyYearBuffer(state.year, state.buffer);
  const rankMap = rankByYearBuffer.get(key);
  const rank = rankMap ? rankMap.get(iso3) : null;
  const denom = rankMap ? rankMap.size : null;
  const pctRank =
    rank && denom ? ((rank / denom) * 100).toFixed(0) : null;

  if (current) {
    const far = data.find(d => d.buffer_km === 300);
    const concentration =
      far && far.pct_near
        ? (current.pct_near / far.pct_near)
        : null;

    const pieces = [
      `${name} — in ${state.year}, about ${current.pct_near.toFixed(1)}% of people live within ${state.buffer} km of a nuclear plant.`,
    ];

    if (pctRank && rank) {
      pieces.push(
        `This places ${name} around the top ${pctRank}% most exposed countries at ${state.buffer} km (rank ${rank} of ${denom}).`
      );
    }

    if (concentration != null) {
      const concText =
        concentration > 0.7
          ? "Exposure is highly concentrated close to plants."
          : concentration < 0.3
          ? "Most exposure comes from people further than 30 km away."
          : "Exposure is spread fairly evenly across distances.";
      pieces.push(concText);
    }

    detailSummary.text(pieces.join(" "));
  } else {
    detailSummary.text(
      `Exposure data for ${name} is incomplete at ${state.buffer} km.`
    );
  }
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