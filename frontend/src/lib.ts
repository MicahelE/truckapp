export type Place = { label: string; lat: number; lon: number };

export type Checkpoint = {
  mile: number;
  lat: number;
  lon: number;
  eta: string;
  wind_mph: number;
  rain_in_hr: number;
  snow_in_hr: number;
  level: number;
};

export type Route = {
  distance_mi: number;
  duration_s: number;
  arrival: string;
  geometry: [number, number][];
  checkpoints: Checkpoint[];
  miles_by_level: number[];
  avg_risk: number;
};

export type Trip = {
  origin: Place;
  destination: Place;
  departure: string;
  load_lbs: number;
  routes: Route[];
  recommended: number;
  reason: string;
  // points: [lon, lat, score at hour 0, ..., score at hour 48], score 0..4
  heatmap: { start: string; step_deg: number; points: number[][] };
  weather_sources: string[];
};

export const LEVELS = ["Low", "Moderate", "High", "Severe", "No Travel"];
export const LEVEL_COLORS = ["#16a34a", "#eab308", "#f97316", "#dc2626", "#581c87"];
export const ROUTE_COLORS = ["#2563eb", "#db2777", "#0d9488"];
export const ROUTE_NAMES = ["A", "B", "C"];

const timeFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
export const fmtTime = (iso: string | number | Date) => timeFmt.format(new Date(iso));

/** Date -> "YYYY-MM-DDTHH:00" in local time, the format <input type="datetime-local"> takes. */
export function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fmtDuration = (s: number) => {
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

export async function api<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `Server error (${res.status})` }));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
