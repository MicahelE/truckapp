import { type CSSProperties, type FormEvent, useEffect, useId, useState } from "react";
import RouteMap from "./RouteMap";
import {
  api, fmtDuration, fmtTime, LEVEL_COLORS, LEVELS, type Place, type Route, ROUTE_COLORS, ROUTE_NAMES, type Trip,
} from "./lib";

type PlaceValue = { text: string; place?: Place };

function nextHourLocal() {
  const d = new Date(Date.now() + 3600e3);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
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

function RouteCard({ trip, i, selected, onSelect }: { trip: Trip; i: number; selected: boolean; onSelect: (i: number) => void }) {
  const r = trip.routes[i];
  const [, , high, severe, noTravel] = r.miles_by_level;
  return (
    <div className={`card${selected ? " selected" : ""}`} style={{ "--route": ROUTE_COLORS[i] } as CSSProperties}>
      <button type="button" className="card-head" onClick={() => onSelect(i)} aria-pressed={selected}>
        <span className="card-title">
          <i className="swatch" /> Route {ROUTE_NAMES[i]}
          {i === trip.recommended && <span className="badge">Recommended</span>}
          {noTravel > 0 && <span className="badge danger">No Travel</span>}
        </span>
        <span>
          {Math.round(r.distance_mi).toLocaleString()} mi · {fmtDuration(r.duration_s)} · arrives {fmtTime(r.arrival)}
        </span>
        <RiskBar route={r} />
        <span className="muted">
          {noTravel > 0 && <b>No Travel {noTravel} mi · </b>}Severe {severe} mi · High {high} mi · Avg risk {r.avg_risk}
        </span>
      </button>
      {i === trip.recommended && <p className="reason">{trip.reason}</p>}
      {selected && (
        <details>
          <summary>{r.checkpoints.length} checkpoints</summary>
          <table>
            <thead>
              <tr><th>Mile</th><th>ETA</th><th>Wind</th><th>Rain</th><th>Snow</th><th>Risk</th></tr>
            </thead>
            <tbody>
              {r.checkpoints.map((c) => (
                <tr key={c.mile}>
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
  const [origin, setOrigin] = useState<PlaceValue>({ text: "Chicago, Illinois" });
  const [destination, setDestination] = useState<PlaceValue>({ text: "Denver, Colorado" });
  const [departure, setDeparture] = useState(nextHourLocal);
  const [load, setLoad] = useState(40000);
  const [sampleMiles, setSampleMiles] = useState(25);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const t = await api<Trip>("/api/routes", {
        origin: origin.place ?? origin.text,
        destination: destination.place ?? destination.text,
        departure: new Date(departure).toISOString(),
        load_lbs: load,
        interval_miles: sampleMiles,
      });
      setTrip(t);
      setSelected(t.recommended);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app">
      <aside>
        <h1>Weather-Aware Truck Routing</h1>
        <form onSubmit={submit}>
          <PlaceInput label="Origin" value={origin} onChange={setOrigin} />
          <PlaceInput label="Destination" value={destination} onChange={setDestination} />
          <label>
            Departure
            <input type="datetime-local" value={departure} onChange={(e) => setDeparture(e.target.value)} required />
          </label>
          <div className="row">
            <label>
              Load (lb)
              <input type="number" min={0} max={80000} step={500} value={load} onChange={(e) => setLoad(+e.target.value)} required />
            </label>
            <label>
              Sample every
              <select value={sampleMiles} onChange={(e) => setSampleMiles(+e.target.value)}>
                {[10, 25, 50].map((m) => <option key={m} value={m}>{m} miles</option>)}
              </select>
            </label>
          </div>
          <button type="submit" disabled={loading}>{loading ? "Planning…" : "Plan routes"}</button>
        </form>
        {error && <p className="error" role="alert">{error}</p>}
        {trip && (
          <section aria-live="polite">
            <p className="muted trip">
              {trip.origin.label} → {trip.destination.label}
              <br />
              Departs {fmtTime(trip.departure)} · {trip.load_lbs.toLocaleString()} lb load
              <br />
              Weather: {trip.weather_sources.join(" + ")}
            </p>
            {trip.routes.length < 3 && (
              <p className="muted">Only {trip.routes.length} distinct route(s) exist between these points.</p>
            )}
            {trip.routes.map((_, i) => (
              <RouteCard key={i} trip={trip} i={i} selected={i === selected} onSelect={setSelected} />
            ))}
          </section>
        )}
      </aside>
      <main>
        <RouteMap trip={trip} selected={selected} onSelect={setSelected} />
        {loading && <div className="loading">Fetching routes and forecasts…</div>}
      </main>
    </div>
  );
}
