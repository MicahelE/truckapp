import * as maplibregl from "maplibre-gl";
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef, useState } from "react";
import { fmtDuration, fmtTime, LEVEL_COLORS, LEVELS, ROUTE_COLORS, ROUTE_NAMES, type Trip } from "./lib";

maplibregl.setWorkerUrl(workerUrl); // MapLibre 6 looks for the worker next to its own module, which bundling moves

const STYLE = "https://tiles.openfreemap.org/styles/positron";
const HOURS = 48;
const expr = (e: unknown) => e as ExpressionSpecification;
const isSelected = (sel: number) => expr(["==", ["get", "i"], sel]);

type Props = { trip: Trip | null; selected: number; onSelect: (i: number) => void };

export default function RouteMap({ trip, selected, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map>(null);
  const latest = useRef({ trip, onSelect });
  latest.current = { trip, onSelect };
  const [ready, setReady] = useState(false);
  const [hour, setHour] = useState(0);
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
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "260px" });
    let pinned = false;
    popup.on("close", () => (pinned = false));

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
        paint: { "line-color": "#fff", "line-width": 6 },
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
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 1.5,
        },
      });
      setReady(true);
    });

    const hit = (point: maplibregl.PointLike) =>
      map.queryRenderedFeatures(point, { layers: ["checkpoints", "route-hit"] })[0];

    const show = (f: maplibregl.MapGeoJSONFeature, at: maplibregl.LngLat) => {
      const t = latest.current.trip!;
      const r = t.routes[f.properties.i];
      const name = `Route ${ROUTE_NAMES[f.properties.i]}`;
      if (f.layer.id === "checkpoints") {
        const c = r.checkpoints[f.properties.j];
        popup.setLngLat([c.lon, c.lat]).setHTML(
          `<b>${name} · mile ${c.mile}</b><br>ETA ${fmtTime(c.eta)}<br>` +
            `Wind ${c.wind_mph} mph · Rain ${c.rain_in_hr} in/hr · Snow ${c.snow_in_hr} in/hr<br>` +
            `<span class="pill" style="background:${LEVEL_COLORS[c.level]}">${LEVELS[c.level]}</span>`,
        );
      } else {
        const [, , high, severe, noTravel] = r.miles_by_level;
        popup.setLngLat(at).setHTML(
          `<b>${name}${f.properties.i === t.recommended ? " · Recommended" : ""}</b><br>` +
            `${Math.round(r.distance_mi).toLocaleString()} mi · ${fmtDuration(r.duration_s)} · arrives ${fmtTime(r.arrival)}<br>` +
            `Severe ${severe} mi · High ${high} mi${noTravel ? ` · <b>No Travel ${noTravel} mi</b>` : ""}<br>` +
            `Average risk ${r.avg_risk}`,
        );
      }
      popup.addTo(map);
    };

    map.on("mousemove", (e) => {
      if (!map.getLayer("checkpoints")) return;
      const f = hit(e.point);
      map.getCanvas().style.cursor = f ? "pointer" : "";
      if (pinned) return;
      if (f?.layer.id === "checkpoints") show(f, e.lngLat);
      else popup.remove();
    });
    map.on("click", (e) => {
      if (!map.getLayer("checkpoints")) return;
      const f = hit(e.point);
      if (!f) return popup.remove();
      if (f.layer.id === "route-hit") latest.current.onSelect(f.properties.i);
      show(f, e.lngLat);
      pinned = true;
    });
    return () => map.remove();
  }, []);

  // New trip: push data and frame it.
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

    const bounds = new maplibregl.LngLatBounds();
    trip.routes.forEach((r) => r.geometry.forEach((p) => bounds.extend(p)));
    map.fitBounds(bounds, { padding: 60, duration: 800 });
    setHour(0);
  }, [ready, trip]);

  // Highlight the selected route and its checkpoints.
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const sel = isSelected(selected);
    map.setLayoutProperty("route-casing", "line-sort-key", expr(["case", sel, 1, 0]));
    map.setLayoutProperty("route-line", "line-sort-key", expr(["case", sel, 1, 0]));
    map.setPaintProperty("route-casing", "line-width", expr(["case", sel, 9, 6]));
    map.setPaintProperty("route-line", "line-width", expr(["case", sel, 5.5, 3]));
    map.setPaintProperty("route-line", "line-opacity", expr(["case", sel, 1, 0.5]));
    map.setPaintProperty("checkpoints", "circle-radius", expr(["case", sel, 6, 3.5]));
    map.setLayoutProperty("checkpoints", "circle-sort-key", expr(["+", ["case", sel, 10, 0], ["get", "level"]]));
  }, [ready, selected]);

  // Forecast slider: swap which hour's score drives the heatmap (no refetch, no new data).
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setPaintProperty("heat", "heatmap-weight", expr(["/", ["get", `h${hour}`], 4]));
  }, [ready, hour]);

  useEffect(() => {
    if (ready) mapRef.current?.setLayoutProperty("heat", "visibility", showHeat ? "visible" : "none");
  }, [ready, showHeat]);

  const start = trip ? new Date(trip.heatmap.start).getTime() : 0;

  return (
    <div className="map-wrap">
      <div ref={container} className="map" />
      <div className="legend" aria-label="Risk legend">
        {LEVELS.map((l, i) => (
          <span key={l}>
            <i style={{ background: LEVEL_COLORS[i] }} /> {l}
          </span>
        ))}
      </div>
      {trip && (
        <div className="slider">
          <label className="slider-row">
            <input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} />
            Weather risk heatmap
          </label>
          <input
            type="range"
            min={0}
            max={HOURS}
            value={hour}
            onChange={(e) => setHour(+e.target.value)}
            disabled={!showHeat}
            aria-label="Forecast hour"
          />
          <div className="slider-row">
            <span>+{hour}h</span>
            <b>{fmtTime(start + hour * 3600e3)}</b>
          </div>
        </div>
      )}
    </div>
  );
}
