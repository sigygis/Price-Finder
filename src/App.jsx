import { useState, useCallback, useRef } from "react";

const STEAM_IMG = "https://community.akamai.steamstatic.com/economy/image/";
const API = "/api/csfloat";

const RARITY_COLORS = { 1:"#b0c3d9",2:"#5e98d9",3:"#4b69ff",4:"#8847ff",5:"#d32ce6",6:"#eb4b4b",7:"#ffd700" };
const RARITY_NAMES = { 1:"Consumer",2:"Industrial",3:"Mil-Spec",4:"Restricted",5:"Classified",6:"Covert",7:"Contraband" };
const WEAR_ABBR = { "Factory New":"FN","Minimal Wear":"MW","Field-Tested":"FT","Well-Worn":"WW","Battle-Scarred":"BS" };

const fmt = (c) => !c && c !== 0 ? "—" : "$" + (c/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export default function App() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, status: "" });
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [searchName, setSearchName] = useState("");
  const [filterText, setFilterText] = useState("");
  const [sortBy, setSortBy] = useState("spread_pct");
  const [category, setCategory] = useState(0); // 0=all, 1=normal, 2=stattrak, 3=souvenir
  const [minVolume, setMinVolume] = useState("5"); // minimum SCM volume for liquidity
  const abortRef = useRef(false);

  // Fetch buy orders for a listing
  const fetchBuyOrders = useCallback(async (listingId) => {
    try {
      const resp = await fetch(`${API}/listings/${listingId}/buy-orders?limit=5`, {
        headers: { Authorization: apiKey },
      });
      if (resp.status === 429) {
        // Rate limited - wait and retry once
        console.log("⏳ Rate limited, waiting 6s...");
        await sleep(6000);
        const retry = await fetch(`${API}/listings/${listingId}/buy-orders?limit=5`, {
          headers: { Authorization: apiKey },
        });
        if (!retry.ok) return null;
        const data = await retry.json();
        const orders = Array.isArray(data) ? data : [];
        if (orders.length > 0) {
          orders.sort((a, b) => b.price - a.price);
          return orders[0];
        }
        return null;
      }
      if (!resp.ok) return null;
      const data = await resp.json();
      const orders = Array.isArray(data) ? data : [];
      if (orders.length > 0) {
        orders.sort((a, b) => b.price - a.price);
        return orders[0];
      }
      return null;
    } catch { return null; }
  }, [apiKey]);

  // Main scan: get listings, then fetch buy orders for each
  const scan = useCallback(async () => {
    if (!apiKey) return;
    abortRef.current = false;
    setLoading(true);
    setError(null);
    setResults([]);

    try {
      // Step 1: Fetch listings
      setProgress({ done: 0, total: 0, status: "Fetching listings..." });
      const p = new URLSearchParams();
      p.set("limit", "50");
      p.set("sort_by", "best_deal");
      p.set("type", "buy_now");
      if (category > 0) p.set("category", String(category));
      if (minPrice) p.set("min_price", String(Math.round(parseFloat(minPrice) * 100)));
      if (maxPrice) p.set("max_price", String(Math.round(parseFloat(maxPrice) * 100)));
      if (searchName.trim()) p.set("market_hash_name", searchName.trim());

      const resp = await fetch(`${API}/listings?${p}`, {
        headers: { Authorization: apiKey },
      });
      if (!resp.ok) throw new Error(`API ${resp.status}: ${await resp.text().catch(() => resp.statusText)}`);

      const listings = await resp.json();
      const items = Array.isArray(listings) ? listings : (listings.data || []);

      if (items.length === 0) {
        setError("No listings found. Try different filters.");
        setLoading(false);
        return;
      }

      // Step 2: For each listing, fetch buy orders
      setProgress({ done: 0, total: items.length, status: "Fetching buy orders..." });
      const enriched = [];

      for (let i = 0; i < items.length; i++) {
        if (abortRef.current) break;
        const listing = items[i];
        const skinName = listing.item?.market_hash_name || listing.item?.item_name || "Unknown";
        setProgress({ done: i, total: items.length, status: `Buy orders: ${skinName.split("|")[0].trim()}...` });

        const topOrder = await fetchBuyOrders(listing.id);

        if (topOrder) {
          const buyNow = listing.price;
          const highestBid = topOrder.price;
          const spreadCents = buyNow - highestBid;
          const spreadPct = ((spreadCents / buyNow) * 100);

          enriched.push({
            ...listing,
            _highestBid: highestBid,
            _spread: spreadCents,
            _spreadPct: spreadPct,
            _bidQty: topOrder.qty || topOrder.quantity || 1,
          });
        } else {
          console.log(`❌ No buy orders for ${skinName} (listing ${listing.id})`);
        }

        setResults([...enriched]);
        // Delay to respect rate limit (20 req per period)
        if (i < items.length - 1) await sleep(350);
      }

      setProgress({ done: items.length, total: items.length, status: "Done!" });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiKey, minPrice, maxPrice, searchName, category, fetchBuyOrders]);

  const stop = () => { abortRef.current = true; };

  // Filtering + sorting
  const filtered = results.filter(r => {
    if (filterText && !(r.item?.market_hash_name || "").toLowerCase().includes(filterText.toLowerCase())) return false;
    // Liquidity filter: skip items with known low SCM volume (null = unknown, let it through)
    const vol = r.item?.scm?.volume;
    const minVol = parseInt(minVolume) || 0;
    if (minVol > 0 && vol != null && vol < minVol) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    switch (sortBy) {
      case "spread_pct": return a._spreadPct - b._spreadPct; // lowest spread % = tightest = best opportunity
      case "spread_pct_desc": return b._spreadPct - a._spreadPct;
      case "spread_usd": return a._spread - b._spread;
      case "spread_usd_desc": return b._spread - a._spread;
      case "price_asc": return a.price - b.price;
      case "price_desc": return b.price - a.price;
      case "bid_desc": return b._highestBid - a._highestBid;
      default: return a._spreadPct - b._spreadPct;
    }
  });

  const avgSpread = sorted.length ? (sorted.reduce((a, b) => a + b._spreadPct, 0) / sorted.length) : 0;
  const tightest = sorted.length ? Math.min(...sorted.map(r => r._spreadPct)) : 0;

  return (
    <div style={{ minHeight: "100vh", background: "#0b0b10", color: "#d4d4d8", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:5px} ::-webkit-scrollbar-thumb{background:#27272a;border-radius:3px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
        @keyframes shimmer{0%{background-position:-600px 0}100%{background-position:600px 0}}
        .row{animation:fadeIn .2s ease-out both;transition:background .1s;cursor:pointer}
        .row:hover{background:rgba(255,255,255,.025)!important}
        .chip{border:1px solid #27272a;background:#111116;color:#a1a1aa;border-radius:5px;padding:6px 11px;font-size:11px;cursor:pointer;transition:all .12s;font-family:inherit;font-weight:500}
        .chip:hover{border-color:#3f3f46;color:#e4e4e7}
        .chip.on{border-color:#f97316;color:#f97316;background:#1a1008}
        .inp{background:#111116;border:1px solid #27272a;border-radius:5px;padding:7px 11px;color:#e4e4e7;font-size:12px;font-family:inherit;outline:none;transition:border .15s}
        .inp:focus{border-color:#f97316} .inp::placeholder{color:#52525b}
        .go{background:#f97316;border:none;border-radius:5px;padding:7px 16px;color:#000;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
        .go:hover{background:#fb923c} .go:disabled{opacity:.4;cursor:not-allowed}
        .stop{background:#991b1b;border:none;border-radius:5px;padding:7px 14px;color:#fff;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
        .stop:hover{background:#dc2626}
        .skel{background:linear-gradient(90deg,#111116 25%,#19191f 50%,#111116 75%);background-size:600px;animation:shimmer 1.5s infinite;border-radius:5px;height:56px;margin-bottom:1px}
        .pill{display:inline-flex;padding:2px 7px;border-radius:3px;font-size:12px;font-weight:700}
        .dot{width:6px;height:6px;border-radius:50%;background:#22c55e;display:inline-block;animation:pulse 2s infinite}
        .fbar{height:3px;border-radius:2px;background:linear-gradient(90deg,#22c55e,#eab308,#f97316,#ef4444,#7f1d1d);position:relative}
        .fdot{position:absolute;top:50%;width:6px;height:6px;border-radius:50%;background:#fff;border:1.5px solid #0b0b10;transform:translate(-50%,-50%)}
      `}</style>

      {/* ── HEADER ── */}
      <header style={{ borderBottom: "1px solid #1a1a1f", padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 7, background: "linear-gradient(135deg,#f97316,#ea580c)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
            <div>
              <h1 style={{ fontSize: 15, fontWeight: 800, color: "#fafafa", letterSpacing: "-.02em" }}>CSFloat Spread Scanner</h1>
              <div style={{ fontSize: 9, color: "#52525b", letterSpacing: ".06em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 5 }}>
                <span className="dot" /> Highest Buy Order vs Lowest Buy Now
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button className="go" onClick={scan} disabled={loading || !apiKey}>
              {loading ? `Scanning ${progress.done}/${progress.total}...` : "⟳ Scan"}
            </button>
            {loading && <button className="stop" onClick={stop}>Stop</button>}
          </div>
        </div>

        {/* API Key */}
        <div style={{ marginTop: 12, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: apiKey ? "#22c55e" : "#f97316", fontWeight: 600 }}>
            {apiKey ? "🔑 Key set" : "⚠ API Key required"}
          </span>
          <input className="inp" type="password" placeholder="Paste CSFloat API key" value={apiKeyInput}
            onChange={e => setApiKeyInput(e.target.value)} style={{ flex: 1, maxWidth: 350 }} />
          <button className="chip" onClick={() => setApiKey(apiKeyInput.trim().replace(/[^\x20-\x7E]/g,""))}>Save Key</button>
          {apiKey && <button className="chip" onClick={() => { setApiKey(""); setApiKeyInput(""); }}>Clear</button>}
          <a href="https://csfloat.com/profile" target="_blank" rel="noreferrer" style={{ fontSize: 10, color: "#52525b", textDecoration: "underline" }}>
            Get key → csfloat.com/profile → Developer
          </a>
        </div>
      </header>

      {/* ── FILTERS ── */}
      <div style={{ borderBottom: "1px solid #1a1a1f", padding: "10px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Row 1: Category + Liquidity */}
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 9, color: "#52525b", textTransform: "uppercase", letterSpacing: ".08em" }}>Type</span>
          {[
            { v: 0, l: "All" },
            { v: 1, l: "Normal" },
            { v: 2, l: "StatTrak™" },
            { v: 3, l: "Souvenir" },
          ].map(c => (
            <button key={c.v} className={`chip ${category === c.v ? "on" : ""}`} onClick={() => setCategory(c.v)}>{c.l}</button>
          ))}

          <div style={{ width: 1, height: 20, background: "#27272a", margin: "0 4px" }} />

          <span style={{ fontSize: 9, color: "#52525b", textTransform: "uppercase", letterSpacing: ".08em" }}>Liquidity</span>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span style={{ fontSize: 10, color: "#71717a" }}>Min SCM vol:</span>
            <input className="inp" type="number" value={minVolume} onChange={e => setMinVolume(e.target.value)} style={{ width: 56 }} />
          </div>
          {[
            { v: "0", l: "All" },
            { v: "5", l: "5+" },
            { v: "20", l: "20+" },
            { v: "50", l: "50+" },
          ].map(q => (
            <button key={q.v} className={`chip ${minVolume === q.v ? "on" : ""}`} onClick={() => setMinVolume(q.v)}>{q.l}</button>
          ))}
        </div>

        {/* Row 2: Search + Sort */}
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
        <input className="inp" placeholder='Skin name (e.g. AK-47 | Redline (Field-Tested))' value={searchName}
          onChange={e => setSearchName(e.target.value)} onKeyDown={e => e.key === "Enter" && scan()} style={{ width: 340 }} />
        <input className="inp" placeholder="Min $" type="number" value={minPrice} onChange={e => setMinPrice(e.target.value)} style={{ width: 72 }} />
        <input className="inp" placeholder="Max $" type="number" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} style={{ width: 72 }} />
        <button className="go" onClick={scan} disabled={loading || !apiKey}>Search</button>

        <div style={{ width: 1, height: 20, background: "#27272a", margin: "0 4px" }} />
        <span style={{ fontSize: 9, color: "#52525b", textTransform: "uppercase", letterSpacing: ".08em" }}>Sort</span>
        {[
          { k: "spread_pct", l: "Tightest Spread %" },
          { k: "spread_pct_desc", l: "Widest Spread %" },
          { k: "spread_usd", l: "Tightest $" },
          { k: "price_asc", l: "Cheapest" },
        ].map(s => (
          <button key={s.k} className={`chip ${sortBy === s.k ? "on" : ""}`} onClick={() => setSortBy(s.k)}>{s.l}</button>
        ))}

        <div style={{ marginLeft: "auto" }}>
          <input className="inp" placeholder="Filter results..." value={filterText} onChange={e => setFilterText(e.target.value)} style={{ width: 170 }} />
        </div>
        </div>
      </div>

      {/* ── PROGRESS ── */}
      {loading && (
        <div style={{ padding: "8px 20px", borderBottom: "1px solid #1a1a1f" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: "#71717a" }}>{progress.status}</span>
            <span style={{ fontSize: 11, color: "#f97316" }}>{progress.total > 0 ? Math.round((progress.done/progress.total)*100) : 0}%</span>
          </div>
          <div style={{ height: 3, background: "#1a1a1f", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${progress.total > 0 ? (progress.done/progress.total)*100 : 0}%`, background: "linear-gradient(90deg,#f97316,#fb923c)", borderRadius: 2, transition: "width .3s" }} />
          </div>
        </div>
      )}

      {/* ── STATS ── */}
      {sorted.length > 0 && (
        <div style={{ display: "flex", borderBottom: "1px solid #1a1a1f" }}>
          {[
            ["Items w/ Orders", String(sorted.length), "#a1a1aa"],
            ["Avg Spread", avgSpread.toFixed(1) + "%", "#f97316"],
            ["Tightest", tightest.toFixed(1) + "%", "#22c55e"],
          ].map(([k, v, c], i) => (
            <div key={i} style={{ flex: 1, padding: "10px 20px", background: i % 2 ? "#0d0d12" : "transparent" }}>
              <div style={{ fontSize: 9, color: "#52525b", textTransform: "uppercase", letterSpacing: ".1em" }}>{k}</div>
              <div style={{ fontSize: 18, fontWeight: 800, color: c, marginTop: 1 }}>{v}</div>
            </div>
          ))}
        </div>
      )}

      {/* ── ERROR ── */}
      {error && (
        <div style={{ margin: "12px 20px", padding: "10px 14px", background: "#1c1012", border: "1px solid #7f1d1d", borderRadius: 6, fontSize: 11, color: "#fca5a5" }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* ── TABLE HEAD ── */}
      <div style={{
        display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr .9fr .9fr .6fr .5fr",
        gap: 8, padding: "7px 20px", fontSize: 9, color: "#52525b", textTransform: "uppercase",
        letterSpacing: ".1em", borderBottom: "1px solid #1a1a1f", position: "sticky", top: 0, background: "#0b0b10", zIndex: 10
      }}>
        <div>Item</div>
        <div style={{ textAlign: "right" }}>Buy Now (Ask)</div>
        <div style={{ textAlign: "right" }}>Top Buy Order (Bid)</div>
        <div style={{ textAlign: "right" }}>Spread</div>
        <div style={{ textAlign: "right" }}>Spread %</div>
        <div style={{ textAlign: "right" }}>Vol</div>
        <div style={{ textAlign: "right" }}>Float</div>
      </div>

      {/* ── ROWS ── */}
      {sorted.map((l, i) => {
        const it = l.item || {};
        const spreadPct = l._spreadPct;
        const sc = spreadPct < 3 ? "#22c55e" : spreadPct < 8 ? "#86efac" : spreadPct < 15 ? "#eab308" : "#ef4444";
        const rc = RARITY_COLORS[it.rarity] || "#a1a1aa";
        const wa = WEAR_ABBR[it.wear_name] || "";
        const ic = it.icon_url ? STEAM_IMG + it.icon_url : null;

        return (
          <div key={l.id || i} className="row" style={{
            display: "grid", gridTemplateColumns: "2.2fr 1fr 1fr .9fr .9fr .6fr .5fr",
            gap: 8, padding: "8px 20px", borderBottom: "1px solid #111116", alignItems: "center",
            animationDelay: `${(i%50)*.015}s`
          }} onClick={() => window.open(`https://csfloat.com/item/${l.id}`,"_blank")}>

            {/* Item */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {ic && <img src={ic} alt="" style={{ width: 52, height: 38, objectFit: "contain", flexShrink: 0, filter: "drop-shadow(0 1px 3px rgba(0,0,0,.5))" }} loading="lazy" />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#fafafa", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {it.item_name || it.market_hash_name || "?"}
                </div>
                <div style={{ display: "flex", gap: 5, marginTop: 2, alignItems: "center" }}>
                  <span style={{ fontSize: 9, color: rc, fontWeight: 600 }}>{RARITY_NAMES[it.rarity]||""}</span>
                  {wa && <span style={{ fontSize: 9, color: "#71717a", background: "#18181b", padding: "0 4px", borderRadius: 2 }}>{wa}</span>}
                  {it.is_stattrak && <span style={{ fontSize: 8, color: "#f97316", fontWeight: 700 }}>ST™</span>}
                </div>
              </div>
            </div>

            {/* Buy Now */}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fafafa" }}>{fmt(l.price)}</div>
            </div>

            {/* Top Bid */}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#60a5fa" }}>{fmt(l._highestBid)}</div>
              <div style={{ fontSize: 9, color: "#3f3f46" }}>qty {l._bidQty}</div>
            </div>

            {/* Spread $ */}
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: sc }}>{fmt(l._spread)}</div>
            </div>

            {/* Spread % */}
            <div style={{ textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6 }}>
              <div style={{ width: 36, height: 4, background: "#1a1a1f", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${Math.min(spreadPct, 50)*2}%`, background: sc, borderRadius: 2 }} />
              </div>
              <span className="pill" style={{ background: sc+"18", color: sc }}>{spreadPct.toFixed(1)}%</span>
            </div>

            {/* Volume */}
            <div style={{ textAlign: "right" }}>
              {it.scm?.volume != null ? (
                <div style={{ fontSize: 11, fontWeight: 600, color: it.scm.volume >= 50 ? "#22c55e" : it.scm.volume >= 10 ? "#eab308" : "#ef4444" }}>
                  {it.scm.volume}
                </div>
              ) : <span style={{ color: "#3f3f46" }}>—</span>}
            </div>

            {/* Float */}
            <div style={{ textAlign: "right" }}>
              {it.float_value != null ? (
                <>
                  <div style={{ fontSize: 10, color: "#a1a1aa", fontVariantNumeric: "tabular-nums" }}>{it.float_value.toFixed(4)}</div>
                  <div className="fbar" style={{ width: "100%", marginTop: 3 }}>
                    <div className="fdot" style={{ left: `${Math.min(it.float_value*100,100)}%` }} />
                  </div>
                </>
              ) : <span style={{ color: "#3f3f46" }}>—</span>}
            </div>
          </div>
        );
      })}

      {loading && [...Array(6)].map((_,i) => <div key={i} className="skel" style={{ margin: "0 20px 1px" }} />)}

      {!loading && sorted.length === 0 && !error && (
        <div style={{ textAlign: "center", padding: "60px 20px" }}>
          <div style={{ fontSize: 36, opacity: .15, marginBottom: 10 }}>📊</div>
          <p style={{ fontSize: 13, color: "#52525b" }}>
            {apiKey ? 'Hit "Scan" to find buy order vs buy now spreads' : 'Paste your CSFloat API key above to start'}
          </p>
          <p style={{ fontSize: 11, color: "#3f3f46", marginTop: 8, maxWidth: 400, margin: "8px auto 0", lineHeight: 1.6 }}>
            Scans the top 50 listings sorted by best deal, then fetches the highest buy order for each.
            Items with no buy orders are skipped. Tightest spread = smallest gap between bid and ask.
          </p>
        </div>
      )}

      <div style={{ padding: "14px 20px", borderTop: "1px solid #1a1a1f", marginTop: 20 }}>
        <p style={{ fontSize: 9, color: "#3f3f46", lineHeight: 1.7 }}>
          <strong style={{ color: "#52525b" }}>Spread</strong> = Buy Now price minus highest Buy Order.
          A tight spread (green, low %) means the bid is close to the ask — high demand.
          A wide spread means there's a big gap between what buyers want to pay and what sellers are asking. Click rows to open on CSFloat.
        </p>
      </div>
    </div>
  );
}
