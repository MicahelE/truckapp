import { type CSSProperties, type FormEvent, useEffect, useId, useState } from "react";
import RouteMap, { type Focus } from "./RouteMap";
import {
  api, fmtDuration, fmtTime, LEVEL_COLORS, LEVELS, localInput, type Place, type Route, ROUTE_COLORS, ROUTE_NAMES, type Trip,
} from "./lib";

type PlaceValue = { text: string; place?: Place };
type Form = { origin: PlaceValue; destination: PlaceValue; departure: string; load: number; sampleMiles: number };

/** Form defaults, overridden by a shared link (?from=&to=&depart=&load=&every=). */
function initialForm(q: URLSearchParams): Form {
  const nextHour = new Date(Date.now() + 3600e3);
  nextHour.setMinutes(0, 0, 0);
  const depart = new Date(q.get("depart") ?? "");
  return {
    origin: { text: q.get("from") ?? "Chicago, Illinois" },
    destination: { text: q.get("to") ?? "Denver, Colorado" },
    departure: localInput(depart > new Date() ? depart : nextHour), // a stale link's departure falls back to next hour
    load: Number(q.get("load") ?? 40000),
    sampleMiles: Number(q.get("every") ?? 25),
  };
}

function PlaceInput({ label, value, onChange }: { label: string; value: PlaceValue; onChange: (v: PlaceValue) => void }) {
  const [options, setOptions] = useState<Place[]>([]);
  const listId = useId();
  const text = value.text.trim();

  useEffect(() => {
    if (text.length < 3 || value.place) return;
    const timer = setTimeout(() => {
      api<{ results: Place[] }>(`/api/geocode?q=${encodeURIComponent(text)}`).then((r) => setOptions(r.results), () => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [text, value.place]);

  return (
    <label>
      {label}
      <input
        list={listId}
        value={value.text}
        required
        autoComplete="off"
        onChange={(e) => onChange({ text: e.target.value, place: options.find((o) => o.label === e.target.value) })}
      />
      <datalist id={listId}>
        {options.map((o) => (
          <option key={`${o.lat},${o.lon}`} value={o.label} />
        ))}
      </datalist>
    </label>
  );
}

function RiskBar({ route }: { route: Route }) {
  return (
    <span className="riskbar" aria-hidden>
      {route.miles_by_level.map((m, l) =>
        m > 0 ? <i key={l} style={{ flexGrow: m, background: LEVEL_COLORS[l] }} title={`${LEVELS[l]}: ${m} mi`} /> : null,
      )}
    </span>
  );
}

type CardProps = { trip: Trip; i: number; selected: boolean; onSelect: (i: number) => void; onFocus: (f: Focus) => void };

function RouteCard({ trip, i, selected, onSelect, onFocus }: CardProps) {
  const r = trip.routes[i];
  const [, , high, severe, noTravel] = r.miles_by_level;
  return (
    <div className={`card${selected ? " selected" : ""}`} style={{ "--route": ROUTE_COLORS[i], "--n": i } as CSSProperties}>
      <button type="button" className="card-head" onClick={() => onSelect(i)} aria-pressed={selected}>
        <span className="card-title">
          <i className="swatch" /> Route {ROUTE_NAMES[i]}
          {i === trip.recommended && <span className="badge">★ Recommended</span>}
          {noTravel > 0 && <span className="badge danger">No Travel</span>}
        </span>
        <span className="stats">
          <span><b>{Math.round(r.distance_mi).toLocaleString()}</b> mi</span>
          <span><b>{fmtDuration(r.duration_s)}</b></span>
          <span>arrives <b>{fmtTime(r.arrival)}</b></span>
        </span>
        <RiskBar route={r} />
        <span className="muted">
          {noTravel > 0 && <b>No Travel {noTravel} mi · </b>}Severe {severe} mi · High {high} mi · Avg risk {r.avg_risk}
        </span>
      </button>
      {i === trip.recommended && <p className="reason">{trip.reason}</p>}
      {selected && (
        <details>
          <summary>{r.checkpoints.length} checkpoints · click one to see it on the map</summary>
          <table>
            <thead>
              <tr><th>Mile</th><th>ETA</th><th>Wind</th><th>Rain</th><th>Snow</th><th>Risk</th></tr>
            </thead>
            <tbody>
              {r.checkpoints.map((c, j) => (
                <tr
                  key={c.mile}
                  tabIndex={0}
                  onClick={() => onFocus({ i, j })}
                  onKeyDown={(e) => e.key === "Enter" && onFocus({ i, j })}
                >
                  <td>{c.mile}</td>
                  <td>{fmtTime(c.eta)}</td>
                  <td>{c.wind_mph}</td>
                  <td>{c.rain_in_hr}</td>
                  <td>{c.snow_in_hr}</td>
                  <td><span className="pill" style={{ background: LEVEL_COLORS[c.level] }}>{LEVELS[c.level]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Wind mph · rain and snow in/hr, forecast at the truck's ETA.</p>
        </details>
      )}
    </div>
  );
}

export default function App() {
  const [form, setForm] = useState(() => initialForm(new URLSearchParams(location.search)));
  const [trip, setTrip] = useState<Trip | null>(null);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function plan(f: Form) {
    setLoading(true);
    setError("");
    try {
      const departure = new Date(f.departure).toISOString();
      const t = await api<Trip>("/api/routes", {
        origin: f.origin.place ?? f.origin.text,
        destination: f.destination.place ?? f.destination.text,
        departure,
        load_lbs: f.load,
        interval_miles: f.sampleMiles,
      });
      setTrip(t);
      setSelected(t.recommended);
      const q = { from: f.origin.text, to: f.destination.text, depart: departure, load: String(f.load), every: String(f.sampleMiles) };
      history.replaceState(null, "", `?${new URLSearchParams(q)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Opened from a shared link: plan it straight away.
  useEffect(() => {
    if (new URLSearchParams(location.search).has("from")) plan(form);
  }, []);

  useEffect(() => {
    if (!loading) return;
    const t0 = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [loading]);

  function copyLink() {
    navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="app">
      <aside>
        <header className="brand">
          <span className="logo" aria-hidden>🚚</span>
          <div>
            <h1>Weather-Aware Truck Routing</h1>
            <p className="muted">The safest route, judged by the forecast at each checkpoint's ETA.</p>
          </div>
        </header>
        <form onSubmit={(e: FormEvent) => (e.preventDefault(), plan(form))}>
          <div className="places">
            <PlaceInput label="Origin" value={form.origin} onChange={(v) => set("origin", v)} />
            <PlaceInput label="Destination" value={form.destination} onChange={(v) => set("destination", v)} />
            <button
              type="button"
              className="swap"
              onClick={() => setForm((f) => ({ ...f, origin: f.destination, destination: f.origin }))}
              aria-label="Swap origin and destination"
              title="Swap origin and destination"
            >
              ⇅
            </button>
          </div>
          <label>
            Departure
            <input type="datetime-local" value={form.departure} onChange={(e) => set("departure", e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Load (lb)
              <input type="number" min={0} max={80000} step={500} value={form.load} onChange={(e) => set("load", +e.target.value)} required />
            </label>
            <label>
              Sample every
              <select value={form.sampleMiles} onChange={(e) => set("sampleMiles", +e.target.value)}>
                {[10, 25, 50].map((m) => <option key={m} value={m}>{m} miles</option>)}
              </select>
            </label>
          </div>
          <button type="submit" className="primary" disabled={loading}>{loading ? "Planning…" : "Plan routes"}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {trip && (
          <section aria-live="polite" className={loading ? "stale" : undefined}>
            <div className="trip">
              <p className="muted">
                {trip.origin.label} → {trip.destination.label}
                <br />
                Departs {fmtTime(trip.departure)} · {trip.load_lbs.toLocaleString()} lb load
                <br />
                Weather: {trip.weather_sources.join(" + ")}
              </p>
              <button type="button" className="ghost" onClick={copyLink}>{copied ? "Copied ✓" : "Copy link"}</button>
            </div>
            {trip.routes.length < 3 && (
              <p className="muted">Only {trip.routes.length} distinct route(s) exist between these points.</p>
            )}
            {trip.routes.map((_, i) => (
              <RouteCard key={`${trip.departure}-${i}`} trip={trip} i={i} selected={i === selected} onSelect={setSelected} onFocus={setFocus} />
            ))}
          </section>
        )}
      </aside>
      <main>
        <RouteMap trip={trip} selected={selected} onSelect={setSelected} focus={focus} />
        {loading && (
          <div className="loading glass" role="status">
            <b>Planning truck routes and checking the forecast along each one…</b>
            <span className="progress" />
            <span className="muted">{elapsed} s · usually 15–40 s</span>
          </div>
        )}
      </main>
    </div>
  );
}
