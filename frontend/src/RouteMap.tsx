import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { fmtDuration, fmtTime, LEVEL_COLORS, LEVELS, type Place, type Route, ROUTE_COLORS, ROUTE_NAMES, type Trip } from "./lib";

maplibregl.setWorkerUrl(workerUrl); // MapLibre 6 looks for the worker next to its own module, which bundling moves

// ponytail: theme and motion are read once at load; switching the OS theme takes effect on reload
const DARK = matchMedia("(prefers-color-scheme: dark)").matches;
const MOTION = !matchMedia("(prefers-reduced-motion: reduce)").matches;
const STYLE = `https://tiles.openfreemap.org/styles/${DARK ? "dark" : "positron"}`;
const HALO = DARK ? "#0b1220" : "#fff"; // casing that lifts lines and dots off the basemap
const HOURS = 48;
const HOURS_PER_SECOND = 4; // playback speed: 48 h in 12 s
const expr = (e: unknown) => e as ExpressionSpecification;
const isSelected = (sel: number) => expr(["==", ["get", "i"], sel]);

export type Focus = { i: number; j: number };
type Props = { trip: Trip | null; selected: number; onSelect: (i: number) => void; focus: Focus | null };

function checkpointHtml(trip: Trip, i: number, j: number) {
  const c = trip.routes[i].checkpoints[j];
  return (
    `<b>Route ${ROUTE_NAMES[i]} · mile ${c.mile}</b><br>ETA ${fmtTime(c.eta)}<br>` +
    `Wind ${c.wind_mph} mph · Rain ${c.rain_in_hr} in/hr · Snow ${c.snow_in_hr} in/hr<br>` +
    `<span class="pill" style="background:${LEVEL_COLORS[c.level]}">${LEVELS[c.level]}</span>`
  );
}

function routeHtml(trip: Trip, i: number) {
  const r = trip.routes[i];
  const [, , high, severe, noTravel] = r.miles_by_level;
  return (
    `<b>Route ${ROUTE_NAMES[i]}${i === trip.recommended ? " · Recommended" : ""}</b><br>` +
    `${Math.round(r.distance_mi).toLocaleString()} mi · ${fmtDuration(r.duration_s)} · arrives ${fmtTime(r.arrival)}<br>` +
    `Severe ${severe} mi · High ${high} mi${noTravel ? ` · <b>No Travel ${noTravel} mi</b>` : ""}<br>` +
    `Average risk ${r.avg_risk}`
  );
}

/** Piecewise-linear y(x) over ascending xs, clamped at both ends. */
function interp(xs: number[], ys: number[], x: number) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  return ys[lo] + ((x - xs[lo]) / (xs[hi] - xs[lo] || 1)) * (ys[hi] - ys[lo]);
}

/** Lookup tables to place a route's truck at any clock time: time -> mile (checkpoint ETAs) -> position. */
function track(r: Route) {
  const rad = Math.PI / 180;
  const miles = [0];
  for (let k = 1; k < r.geometry.length; k++) {
    const [lon1, lat1] = r.geometry[k - 1];
    const [lon2, lat2] = r.geometry[k];
    const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
    miles.push(miles[k - 1] + 7917.6 * Math.asin(Math.sqrt(h)));
  }
  const scale = r.distance_mi / (miles[miles.length - 1] || 1); // display geometry is thinned; stretch to true length
  return {
    miles: miles.map((m) => m * scale),
    lons: r.geometry.map((p) => p[0]),
    lats: r.geometry.map((p) => p[1]),
    etas: r.checkpoints.map((c) => Date.parse(c.eta)),
    cpMiles: r.checkpoints.map((c) => c.mile),
    cpIndex: r.checkpoints.map((_, j) => j),
  };
}

type Truck = { marker: maplibregl.Marker; chip: HTMLElement; route: Route; track: ReturnType<typeof track> };

function moveTruck({ marker, chip, route, track: tk }: Truck, ms: number) {
  const mile = interp(tk.etas, tk.cpMiles, ms);
  marker.setLngLat([interp(tk.miles, tk.lons, mile), interp(tk.miles, tk.lats, mile)]);
  // The nearest checkpoint was forecast for the moment the truck passes it, so its level is the risk "now".
  const level = route.checkpoints[Math.round(interp(tk.cpMiles, tk.cpIndex, mile))].level;
  const text = ms < tk.etas[0] ? "not departed" : ms >= tk.etas[tk.etas.length - 1] ? "arrived" : `mile ${Math.round(mile)} · ${LEVELS[level]}`;
  if (chip.dataset.text !== text) {
    chip.dataset.text = text;
    chip.innerHTML = `<i style="background:${LEVEL_COLORS[level]}"></i>${text}`;
  }
}

function pin(text: string, p: Place) {
  const el = document.createElement("div");
  el.className = "pin";
  el.textContent = text;
  return new maplibregl.Marker({ element: el, anchor: "bottom", offset: [0, -5] }).setLngLat([p.lon, p.lat]); // clear the arrow
}

export default function RouteMap({ trip, selected, onSelect, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>(null);
  const popupRef = useRef<maplibregl.Popup>(null);
  const pinned = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const trucks = useRef<Truck[]>([]);
  const latest = useRef({ trip, onSelect });
  latest.current = { trip, onSelect };
  const [ready, setReady] = useState(false);
  const [t, setT] = useState(0); // hours since the departure hour
  const [playing, setPlaying] = useState(false);
  const [showHeat, setShowHeat] = useState(true);

  // Create the map, its layers and click/hover handling once.
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: [-96, 38.5],
      zoom: 3.6,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    // The dark basemap names a few POI icons its sprite lacks; a blank pixel keeps the console clean.
    map.setMissingStyleImageResolver((id) => {
      map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
    });
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" });
    popupRef.current = popup;
    popup.on("close", () => (pinned.current = false));

    map.on("load", () => {
      for (const id of ["heat", "routes", "checkpoints"]) {
        map.addSource(id, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      }
      map.addLayer({
        id: "heat",
        type: "heatmap",
        source: "heat",
        paint: {
          "heatmap-weight": expr(["/", ["get", "h0"], 4]),
          // Neighbouring kernels overlap ~2.5x at radius = 3 grid steps, so a uniform score s reads as density s/4.
          "heatmap-intensity": 0.4,
          "heatmap-color": expr([
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(22,163,74,0)",
            0.1, "rgba(22,163,74,0.22)",
            0.25, "rgba(234,179,8,0.45)",
            0.5, "rgba(249,115,22,0.55)",
            0.75, "rgba(220,38,38,0.6)",
            1, "rgba(88,28,135,0.7)",
          ]),
          "heatmap-opacity": expr(["interpolate", ["linear"], ["zoom"], 8, 1, 11, 0]),
        },
      });
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": HALO, "line-width": 6 },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "routes",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": expr(["match", ["get", "i"], ...ROUTE_COLORS.flatMap((c, i) => [i, c]), "#555"]) },
      });
      map.addLayer({
        id: "route-hit",
        type: "line",
        source: "routes",
        paint: { "line-width": 16, "line-opacity": 0 },
      });
      map.addLayer({
        id: "checkpoints",
        type: "circle",
        source: "checkpoints",
        paint: {
          "circle-color": expr(["match", ["get", "level"], ...LEVEL_COLORS.flatMap((c, i) => [i, c]), "#888"]),
          "circle-stroke-color": HALO,
          "circle-stroke-width": 1.5,
        },
      });
      setReady(true);
    });

    const hit = (point: maplibregl.PointLike) =>
      map.queryRenderedFeatures(point, { layers: ["checkpoints", "route-hit"] })[0];

    const show = (f: maplibregl.MapGeoJSONFeature, at: maplibregl.LngLat) => {
      const trip = latest.current.trip!;
      const { i, j } = f.properties;
      if (f.layer.id === "checkpoints") {
        const c = trip.routes[i].checkpoints[j];
        popup.setLngLat([c.lon, c.lat]).setHTML(checkpointHtml(trip, i, j));
      } else {
        popup.setLngLat(at).setHTML(routeHtml(trip, i));
      }
      popup.addTo(map);
    };

    map.on("mousemove", (e) => {
      if (!map.getLayer("checkpoints")) return;
      const f = hit(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      if (pinned.current) return;
      if (f?.layer.id === "checkpoints") show(f, e.lngLat);
      else popup.remove();
    });
    map.on("click", (e) => {
      if (!map.getLayer("checkpoints")) return;
      const f = hit(e.point);
      if (!f) return popup.remove();
      if (f.layer.id === "route-hit") latest.current.onSelect(f.properties.i);
      show(f, e.lngLat);
      pinned.current = true;
    });
    return () => map.remove();
  }, []);

  // New trip: push data, drop pins and trucks, frame it.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !trip) return;
    (map.getSource("routes") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: trip.routes.map((r, i) => ({
        type: "Feature",
        properties: { i },
        geometry: { type: "LineString", coordinates: r.geometry },
      })),
    });
    (map.getSource("checkpoints") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: trip.routes.flatMap((r, i) =>
        r.checkpoints.map((c, j) => ({
          type: "Feature" as const,
          properties: { i, j, level: c.level },
          geometry: { type: "Point" as const, coordinates: [c.lon, c.lat] },
        })),
      ),
    });
    const pts = trip.heatmap.points;
    (map.getSource("heat") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: pts.map(([lon, lat, ...scores]) => ({
        type: "Feature",
        properties: Object.fromEntries(scores.map((s, h) => [`h${h}`, s])),
        geometry: { type: "Point", coordinates: [lon, lat] },
      })),
    });
    // Radius = 3 lattice steps in screen pixels (doubling per zoom), held from z9 where the layer fades out.
    const meanLat = pts.reduce((sum, p) => sum + p[1], 0) / (pts.length || 1);
    const stepPx = ((trip.heatmap.step_deg * 512) / 360 / Math.cos((meanLat * Math.PI) / 180)) * 3;
    map.setPaintProperty("heat", "heatmap-radius", expr(["interpolate", ["exponential", 2], ["zoom"], 0, stepPx, 9, stepPx * 512]));

    markers.current.forEach((m) => m.remove());
    trucks.current = trip.routes.map((route, i) => {
      const el = document.createElement("div");
      el.className = "truck";
      el.style.setProperty("--route", ROUTE_COLORS[i]);
      el.innerHTML = `<span class="truck-dot">${ROUTE_NAMES[i]}</span><span class="truck-chip"></span>`;
      const marker = new maplibregl.Marker({ element: el }).setLngLat(route.geometry[0]);
      return { marker, chip: el.querySelector<HTMLElement>(".truck-chip")!, route, track: track(route) };
    });
    markers.current = [pin("Start", trip.origin), pin("End", trip.destination), ...trucks.current.map((x) => x.marker)];
    markers.current.forEach((m) => m.addTo(map));

    popupRef.current?.remove();
    const bounds = new maplibregl.LngLatBounds();
    trip.routes.forEach((r) => r.geometry.forEach((p) => bounds.extend(p)));
    // Extra bottom padding keeps the route clear of the timeline panel.
    map.fitBounds(bounds, { padding: { top: 60, right: 60, bottom: 190, left: 60 }, duration: MOTION ? 900 : 0 });
    setPlaying(false);
    setT(0);
  }, [ready, trip]);

  // Highlight the selected route, its checkpoints and its truck.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sel = isSelected(selected);
    map.setLayoutProperty("route-casing", "line-sort-key", expr(["case", sel, 1, 0]));
    map.setLayoutProperty("route-line", "line-sort-key", expr(["case", sel, 1, 0]));
    map.setPaintProperty("route-casing", "line-width", expr(["case", sel, 9, 6]));
    map.setPaintProperty("route-line", "line-width", expr(["case", sel, 5.5, 3]));
    map.setPaintProperty("route-line", "line-opacity", expr(["case", sel, 1, DARK ? 0.75 : 0.5]));
    map.setPaintProperty("checkpoints", "circle-radius", expr(["case", sel, 6, 3.5]));
    map.setLayoutProperty("checkpoints", "circle-sort-key", expr(["+", ["case", sel, 10, 0], ["get", "level"]]));
    trucks.current.forEach((x, i) => x.marker.getElement().classList.toggle("selected", i === selected));
  }, [ready, trip, selected]);

  // Timeline: blend the two nearest forecast hours into the heatmap and move each truck to where it is then.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !trip) return;
    const k = Math.min(Math.floor(t), HOURS - 1);
    const f = Math.round((t - k) * 5) / 5; // fifths of an hour: smooth playback without restyling every frame
    map.setPaintProperty("heat", "heatmap-weight", expr(["/", ["+", ["*", ["get", `h${k}`], 1 - f], ["*", ["get", `h${k + 1}`], f]], 4]));
    const ms = Date.parse(trip.heatmap.start) + t * 3600e3;
    trucks.current.forEach((x) => moveTruck(x, ms));
  }, [ready, trip, t]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      setT((prev) => Math.min(HOURS, prev + ((now - last) / 1000) * HOURS_PER_SECOND));
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  useEffect(() => {
    if (t >= HOURS) setPlaying(false);
  }, [t]);

  // A checkpoint row was clicked in the sidebar: fly there and pin its popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !trip || !focus) return;
    const c = trip.routes[focus.i].checkpoints[focus.j];
    map.flyTo({ center: [c.lon, c.lat], zoom: Math.max(map.getZoom(), 8), duration: MOTION ? 1200 : 0 });
    popupRef.current!.setLngLat([c.lon, c.lat]).setHTML(checkpointHtml(trip, focus.i, focus.j)).addTo(map);
    pinned.current = true;
  }, [ready, focus]);

  useEffect(() => {
    if (ready) mapRef.current?.setLayoutProperty("heat", "visibility", showHeat ? "visible" : "none");
  }, [ready, showHeat]);

  const start = trip ? Date.parse(trip.heatmap.start) : 0;
  // Arrival ticks on the timeline; ticks closer than 4 h stack on separate rows so their labels don't overlap.
  const ticks: { i: number; h: number; row: number }[] = [];
  for (const [i, r] of (trip?.routes ?? []).entries()) {
    const h = (Date.parse(r.arrival) - start) / 3600e3;
    if (h <= HOURS) ticks.push({ i, h, row: ticks.filter((x) => Math.abs(x.h - h) < 4).length });
  }

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      <div className="legend glass" aria-label="Risk legend">
        {LEVELS.map((l, i) => (
          <span key={l}>
            <i style={{ background: LEVEL_COLORS[i] }} /> {l}
          </span>
        ))}
      </div>
      {trip && (
        <div className="timeline glass">
          <div className="timeline-head">
            <button
              type="button"
              className="play"
              onClick={() => {
                if (t >= HOURS) setT(0);
                setPlaying((p) => !p);
              }}
              aria-label={playing ? "Pause forecast" : "Play forecast"}
            >
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="when">
              <b>{fmtTime(start + t * 3600e3)}</b>
              <span className="muted">+{Math.floor(t)} h from departure</span>
            </div>
            <label className="heat-toggle">
              <input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} />
              Heatmap
            </label>
          </div>
          <div className="track" style={{ "--rows": Math.max(0, ...ticks.map((x) => x.row)) } as CSSProperties}>
            <input
              type="range"
              min={0}
              max={HOURS}
              step={0.1}
              value={t}
              onChange={(e) => {
                setPlaying(false);
                setT(+e.target.value);
              }}
              aria-label="Forecast time"
            />
            {ticks.map(({ i, h, row }) => (
              <i
                key={i}
                className="tick"
                style={{
                  left: `calc(8px + (100% - 16px) * ${h / HOURS})`,
                  top: row * 15,
                  "--route": ROUTE_COLORS[i],
                  "--row": Math.max(0, ...ticks.map((x) => x.row)) - row,
                } as CSSProperties}
                title={`Route ${ROUTE_NAMES[i]} arrives ${fmtTime(trip.routes[i].arrival)}`}
              >
                {ROUTE_NAMES[i]}
              </i>
            ))}
          </div>
          <div className="heat-scale" aria-hidden>
            <span>Low</span>
            <i />
            <span>No Travel</span>
          </div>
        </div>
      )}
    </div>
  );
}
