// ============================================================================
// LEAK — Automated analysis engine  (Supabase Edge Function)
// Place at: supabase/functions/analyze-report/index.ts
// Deploy:   supabase functions deploy analyze-report
// Secrets:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
// Pipeline:  read files → Claude extracts numbers → validate → compute leaks
//            → Claude writes report (operator voice, context-aware) → save.
// Confident weeks auto-publish; uncertain ones are flagged for a quick review.
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL = "claude-sonnet-4-6"; // change if you prefer opus for quality

const cors = {
  "Access-Control-Allow-Origin": "*",
  // supabase-js sends apikey + x-client-info too; the browser preflight blocks the
  // call unless they're allowed here (this was silently breaking the auto-trigger).
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---------- Anthropic helper ----------
async function claude(system: string, content: any[], maxTokens = 2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error("Claude API: " + (await res.text()));
  const j = await res.json();
  return j.content.map((c: any) => c.text || "").join("");
}

// pull the first JSON object out of a model reply
function parseJSON(s: string) {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("No JSON in model reply");
  return JSON.parse(m[0]);
}

function mediaType(name: string) {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return ["document", "application/pdf"];
  if (n.endsWith(".png")) return ["image", "image/png"];
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return ["image", "image/jpeg"];
  if (n.endsWith(".webp")) return ["image", "image/webp"];
  return ["text", "text/plain"]; // csv / txt
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---------- deterministic tabular parsing ----------
// LLMs are unreliable at summing thousands of rows, so we do the arithmetic in code
// and treat those totals as authoritative (the model still sees a sample for context).
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "");
  const split = (line: string) => {
    const out: string[] = []; let cur = ""; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur); return out.map((s) => s.trim());
  };
  if (!lines.length) return { headers: [], rows: [] };
  return { headers: split(lines[0]), rows: lines.slice(1).map(split) };
}

function num(s: string): number {
  const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

// find a column by header name: exact match first, then substring
function findCol(headers: string[], ...names: string[]): number {
  const h = headers.map((x) => x.toLowerCase().trim());
  for (const name of names) { const i = h.indexOf(name); if (i >= 0) return i; }
  for (const name of names) { const i = h.findIndex((x) => x.includes(name)); if (i >= 0) return i; }
  return -1;
}

// Pull reliable totals from a CSV: gross sales (+ by weekday) and/or gross wages.
function summarizeTabular(label: string, text: string) {
  const { headers, rows } = parseCSV(text);
  if (!headers.length) return null;
  const gsCol = findCol(headers, "gross sales", "gross amount", "sale total", "total sales");
  const dateCol = findCol(headers, "sale date", "business date", "date");
  const gwCol = findCol(headers, "gross wages", "gross wage", "gross pay");
  let grossSales = 0, grossWages = 0;
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    if (gsCol >= 0 && r[gsCol]) {
      const v = num(r[gsCol]); grossSales += v;
      if (dateCol >= 0 && r[dateCol]) {
        const d = new Date(r[dateCol]);
        if (!isNaN(d.getTime())) { const k = DOW[d.getUTCDay()]; byDay[k] = (byDay[k] || 0) + v; }
      }
    }
    if (gwCol >= 0 && r[gwCol]) grossWages += num(r[gwCol]);
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const k in byDay) byDay[k] = round2(byDay[k]);
  return {
    label, headerLine: headers.join(","), rowCount: rows.length,
    sample: rows.slice(0, 25).map((r) => r.join(",")).join("\n"),
    grossSales: gsCol >= 0 ? round2(grossSales) : null,
    salesByDay: Object.keys(byDay).length ? byDay : null,
    grossWages: gwCol >= 0 ? round2(grossWages) : null,
  };
}

// Aggregate a POS export into per-product sales volume (qty + revenue).
function posItems(text: string) {
  const { headers, rows } = parseCSV(text);
  const pCol = findCol(headers, "product", "item", "name", "description");
  const qCol = findCol(headers, "quantity", "qty");
  const gCol = findCol(headers, "gross sales", "gross", "amount", "sale total");
  if (pCol < 0) return [];
  const map: Record<string, { name: string; qty: number; revenue: number }> = {};
  for (const r of rows) {
    const name = (r[pCol] || "").trim(); if (!name) continue;
    const k = name.toLowerCase();
    if (!map[k]) map[k] = { name, qty: 0, revenue: 0 };
    if (qCol >= 0) map[k].qty += num(r[qCol]);
    if (gCol >= 0) map[k].revenue += num(r[gCol]);
  }
  return Object.values(map);
}

// Parse an (optional) menu-costing sheet: item -> sell price + plate cost.
function menuCosting(text: string) {
  const { headers, rows } = parseCSV(text);
  const nCol = findCol(headers, "menu item", "item", "product", "name", "dish");
  const pCol = findCol(headers, "sell price", "menu price", "retail price", "price");
  const cCol = findCol(headers, "plate cost", "recipe cost", "food cost", "cost", "cogs");
  if (nCol < 0 || (pCol < 0 && cCol < 0)) return null;
  const out: any[] = [];
  for (const r of rows) {
    const name = (r[nCol] || "").trim(); if (!name) continue;
    const price = pCol >= 0 ? num(r[pCol]) : 0;
    const cost = cCol >= 0 ? num(r[cCol]) : 0;
    if (!price && !cost) continue;
    out.push({ name, price, cost });
  }
  return out.length ? out : null;
}

// Join menu costs to POS volume -> per-item margin, weekly profit, biggest drains.
function menuMargins(menu: any[], items: any[]) {
  const byName: Record<string, any> = {};
  for (const it of items) byName[it.name.toLowerCase()] = it;
  const rows: any[] = [];
  for (const mi of menu) {
    if (!mi.price) continue;
    const sold = byName[mi.name.toLowerCase()];
    const qty = sold ? Math.round(sold.qty) : null;
    const marginPct = +(((mi.price - mi.cost) / mi.price) * 100).toFixed(1);
    const costPct = +((mi.cost / mi.price) * 100).toFixed(1);
    const weeklyProfit = qty != null ? Math.round((mi.price - mi.cost) * qty) : null;
    rows.push({ name: mi.name, price: mi.price, cost: mi.cost, margin_pct: marginPct, cost_pct: costPct, qty, weekly_profit: weeklyProfit });
  }
  // "quietly losing money" = high volume on a thin margin (cost is a big % of price)
  const drains = rows.filter((r) => r.qty && r.cost_pct >= 40)
    .sort((a, b) => (b.qty * b.cost_pct) - (a.qty * a.cost_pct)).slice(0, 5);
  const matched = rows.filter((r) => r.qty != null).length;
  return { items: rows, drains, matched, count: rows.length };
}

// ============================================================================
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { weekly_input_id } = await req.json();
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);

    // ---- load the week + café profile ----
    const { data: wi, error: e1 } = await sb
      .from("weekly_inputs").select("*").eq("id", weekly_input_id).single();
    if (e1 || !wi) throw new Error("weekly_input not found");
    const { data: cafe } = await sb.from("cafes").select("*").eq("id", wi.cafe_id).single();

    // previous weeks (for supplier price history & trend)
    const { data: history } = await sb
      .from("reports").select("week_starting, data, estimated_leak")
      .eq("cafe_id", wi.cafe_id).order("week_starting", { ascending: false }).limit(6);

    // ====================================================================
    // 1. EXTRACT — Claude reads the uploaded files into structured numbers
    // ====================================================================
    const fileBlocks: any[] = [];
    let detSales: number | null = null;                 // gross sales summed in code (authoritative)
    let detSalesByDay: Record<string, number> | null = null;
    let detWages: number | null = null;                 // gross wages summed in code (authoritative)
    let posText = "";                                   // raw POS export (for per-item volume)
    let menuText = "";                                  // raw menu-costing sheet (optional)
    for (const f of (wi.files || [])) {
      const { data: blob } = await sb.storage.from("cafe-files").download(f.path);
      if (!blob) continue;
      const [kind, mt] = mediaType(f.path);
      const buf = await blob.arrayBuffer();
      if (kind === "text") {
        const text = new TextDecoder().decode(buf);
        if (f.label === "menu") menuText = text;
        else if (f.label === "pos") posText = text;
        const sum = summarizeTabular(f.label || f.path, text);
        if (sum && (sum.grossSales != null || sum.grossWages != null)) {
          // tabular file we can total in code — send a compact summary, not 1000s of rows
          if (sum.grossSales != null) detSales = (detSales || 0) + sum.grossSales;
          if (sum.salesByDay) detSalesByDay = { ...(detSalesByDay || {}), ...sum.salesByDay };
          if (sum.grossWages != null) detWages = (detWages || 0) + sum.grossWages;
          fileBlocks.push({ type: "text", text:
            `FILE (${f.label}) ${f.path} — ${sum.rowCount} rows. Totals computed in code (AUTHORITATIVE — use these, do not recompute):` +
            (sum.grossSales != null ? `\n  gross_sales = ${sum.grossSales}` : "") +
            (sum.salesByDay ? `\n  sales_by_day = ${JSON.stringify(sum.salesByDay)}` : "") +
            (sum.grossWages != null ? `\n  gross_wages = ${sum.grossWages}` : "") +
            `\nColumns: ${sum.headerLine}\nSample (first 25 of ${sum.rowCount} rows):\n${sum.sample}` });
        } else {
          // small/non-tabular text — pass it whole
          fileBlocks.push({ type: "text", text: `FILE (${f.label}) ${f.path}:\n` + text });
        }
      } else if (kind === "image") {
        fileBlocks.push({ type: "image", source: { type: "base64", media_type: mt, data: toBase64(buf) } });
      } else {
        fileBlocks.push({ type: "document", source: { type: "base64", media_type: mt, data: toBase64(buf) } });
      }
    }

    const extractSystem =
`You extract structured numbers from a café's weekly files for a profit review.
Return ONLY a JSON object, no prose. Use null where a value is genuinely not present — never guess.

BASIS RULES (critical — get these right):
- SALES: use GROSS sales (GST-INCLUSIVE). From a POS export, sum the "Gross Sales" column,
  NOT "Net Sales". gross_sales is the denominator for all ratios.
- WAGES: extract gross_wages = total ORDINARY+penalty wages BEFORE super (sum "Gross Wages").
  Also report super_rate if the file clearly states one; otherwise null. Do NOT use a
  "Total Cost" or "Super" column if it implies a super rate above ~13% — those are unreliable;
  we recompute super at the statutory rate.
- COGS: supplier invoices, ex-GST amounts, FOOD & BEVERAGE only. EXCLUDE non-food lines
  (cleaning, packaging, equipment). Sum to cogs_total and list the lines.

Schema:
{
  "gross_sales": n,
  "sales_by_day": {"mon":n,"tue":n,"wed":n,"thu":n,"fri":n,"sat":n,"sun":n},   // gross
  "transaction_count": n,                 // rows/receipts seen (to detect truncated exports)
  "gross_wages": n,                       // before super
  "super_rate": n | null,                 // e.g. 0.12 if stated
  "items": [{"name":s,"qty":n,"price":n}],
  "cogs_total": n,                        // ex-GST, food & beverage only
  "cogs_excluded": [{"item":s,"amount":n,"reason":s}],   // non-food lines you left out
  "supplier_prices": [{"item":s,"unit_price":n,"supplier":s}],
  "extraction_notes": s,
  "confidence": "high" | "medium" | "low"
}
Set confidence "low" if files are unreadable, sales or wages are missing, or the export looks partial.`;

    const extracted = parseJSON(await claude(extractSystem, [
      { type: "text", text: `Café: ${cafe?.name}. Week starting ${wi.week_starting}. Owner notes: ${(wi.context?.notes) || "none"}.` },
      ...fileBlocks,
    ], 2500));

    // deterministic totals win over the model's reading of large tables
    if (detSales != null) extracted.gross_sales = detSales;
    if (detSalesByDay) extracted.sales_by_day = detSalesByDay;
    if (detWages != null) extracted.gross_wages = detWages;

    // ====================================================================
    // 2. VALIDATE + 3. COMPUTE  — deterministic, on the correct basis
    //    (validated to the dollar against a real 4-week dataset)
    //    Ratios use GROSS sales; wages = gross wages + statutory super.
    // ====================================================================
    const issues: string[] = [];
    const sbd = extracted.sales_by_day || {};
    const sumDays = Object.values(sbd).reduce((a: number, b: any) => a + (Number(b) || 0), 0);
    const grossSales = Number(extracted.gross_sales) || sumDays;

    // wages = gross wages + statutory super. Ignore unreliable file super/total-cost columns.
    const STATUTORY_SUPER = 0.12;
    let superRate = (extracted.super_rate != null) ? Number(extracted.super_rate) : STATUTORY_SUPER;
    if (superRate > 1) superRate = superRate / 100;                       // accept "12" or "0.12"
    if (superRate < 0.09 || superRate > 0.13) superRate = STATUTORY_SUPER; // sanity bound
    const grossWages = Number(extracted.gross_wages) || 0;
    const wagesTotal = Math.round(grossWages * (1 + superRate));

    const cogs = Number(extracted.cogs_total) || 0;                       // ex-GST, food only

    if (!grossSales) issues.push("no sales figure");
    if (sumDays && grossSales && Math.abs(sumDays - grossSales) / grossSales > 0.15) issues.push("daily sales don't reconcile to total");
    if (!grossWages) issues.push("no wages figure");

    const labourTarget = Number(cafe?.labour_target_pct) || 30;
    const foodTarget   = Number(cafe?.food_target_pct)   || 30;
    const labourPct = grossSales ? +(wagesTotal / grossSales * 100).toFixed(1) : null;
    const foodPct   = grossSales ? +(cogs / grossSales * 100).toFixed(1) : null;

    // plausibility bounds — flag for review instead of publishing a scary, likely-wrong number
    if (labourPct && labourPct > 55) issues.push("labour % implausibly high — sales export may be partial");
    if (foodPct && foodPct > 50) issues.push("food cost % implausibly high — invoices or sales may be incomplete");
    // a suspiciously LOW food cost almost always means missing invoices — the classic draft cause
    if (foodPct != null && foodTarget && grossSales && foodPct < foodTarget * 0.5) issues.push("food cost suspiciously low — likely missing supplier invoices");

    const labourLeakWeekly = (labourPct && labourPct > labourTarget && grossSales)
      ? Math.round(((labourPct - labourTarget) / 100) * grossSales) : 0;
    const foodLeakWeekly = (foodPct && foodPct > foodTarget && grossSales)
      ? Math.round(((foodPct - foodTarget) / 100) * grossSales) : 0;

    let confidence = extracted.confidence || "medium";
    if (issues.length >= 2) confidence = "low";

    // ---- specific, owner-friendly reasons a week gets held for review (what + how to fix) ----
    const dollars = (n: number) => "$" + Math.round(n).toLocaleString();
    const reviewReasons: { what: string; fix: string }[] = [];
    if (!grossSales) reviewReasons.push({ what: "We couldn't find a sales total in your files.", fix: "Add your POS sales export for the week." });
    if (!grossWages) reviewReasons.push({ what: "No wages figure came through.", fix: "Add your roster or wages report." });
    if (labourPct && labourPct > 55) reviewReasons.push({ what: `Labour came out at ${labourPct}% — unusually high, which usually means the sales export is only part of the week.`, fix: "Check the POS export covers all 7 days, then re-upload it." });
    if (foodPct != null && foodPct > 50) reviewReasons.push({ what: `Food cost came out at ${foodPct}% — very high, so some sales or invoices look missing.`, fix: "Double-check the sales export and invoices, then re-upload." });
    if (foodPct != null && foodTarget && grossSales && foodPct < foodTarget * 0.5) reviewReasons.push({ what: `Food cost came out at ${foodPct}%, which is very low for ${dollars(grossSales)} of sales.`, fix: "You're probably missing some supplier invoices for the week — add the rest on the Upload page and we'll re-run it." });
    if (sumDays && grossSales && Math.abs(sumDays - grossSales) / grossSales > 0.15) reviewReasons.push({ what: "Your daily sales don't add up to the weekly total.", fix: "The POS export may be truncated — re-export the full week and re-upload." });
    if (extracted.confidence === "low" && !reviewReasons.length) reviewReasons.push({ what: "Some figures were hard to read from the files you sent.", fix: "Re-upload clearer copies — a PDF or CSV reads better than a photo." });

    // softest trading day (the "staffing Tuesday like a Friday" signal)
    let softestDay: string | null = null, softestVal = Infinity;
    for (const d of ["mon","tue","wed","thu","fri","sat","sun"]) {
      const v = Number(sbd[d]); if (v && v < softestVal) { softestVal = v; softestDay = d; }
    }

    // COGS trend across weeks + supplier price creep vs history
    const cogsHistory = (history || []).map((h: any) => h.data?.metrics?.food_pct).filter((x: any) => x != null);
    const prevPrices: Record<string, number> = {};
    for (const h of (history || [])) for (const sp of (h.data?.supplier_prices || [])) prevPrices[sp.item?.toLowerCase?.()] = sp.unit_price;
    const creeps: any[] = [];
    for (const sp of (extracted.supplier_prices || [])) {
      const prev = prevPrices[sp.item?.toLowerCase?.()];
      if (prev && sp.unit_price > prev) creeps.push({ item: sp.item, from: prev, to: sp.unit_price, pct: +(((sp.unit_price - prev) / prev) * 100).toFixed(1) });
    }

    // menu costing (optional) — real per-item margins when a costing sheet is uploaded
    let menu: any = null;
    if (menuText) {
      const costed = menuCosting(menuText);
      if (costed) menu = menuMargins(costed, posText ? posItems(posText) : []);
    }

    const metrics = {
      gross_sales: grossSales, sales_by_day: sbd,
      gross_wages: grossWages, super_rate: superRate, wages_total: wagesTotal,
      labour_pct: labourPct, labour_target: labourTarget, labour_leak_weekly: labourLeakWeekly,
      cogs, food_pct: foodPct, food_target: foodTarget, food_leak_weekly: foodLeakWeekly,
      cogs_history: cogsHistory, softest_day: softestDay, supplier_creep: creeps,
      cogs_excluded: extracted.cogs_excluded || [],
      fixed_costs_monthly: cafe?.fixed_costs?.monthly || null,
      items: extracted.items || [],
      menu,   // { items, drains, matched, count } when a menu-costing sheet was provided
    };

    // ====================================================================
    // 4. NARRATE — Claude writes the report in operator voice, context-aware
    // ====================================================================
    const narrateSystem =
`You are an experienced café operator of 20 years writing a café owner's weekly profit review.
Voice: direct, warm, plain English, like one operator to another. Never corporate, never "AI",
never "leverage/optimise/actionable". Say things like "you're staffing Tuesday like it's a Friday".
You are given COMPUTED metrics — trust them, don't invent numbers.
MENU PRICING: if metrics.menu is present, a menu-costing sheet was uploaded — base the Menu pricing
leak on REAL per-item margins. Name specific items from metrics.menu.drains (high-volume items where
cost is a big share of the price), cite their margin %, plate cost and weekly quantity, and give an
exact "raise it $X" action. If metrics.menu is null, you may still flag a pricing concern but call it
an ESTIMATE and suggest uploading a menu-costing sheet for exact figures.
IMPORTANT context handling: if owner notes mention rain, a public holiday, school holidays or a
one-off event, do NOT treat a quiet day as a staffing problem — call it out as context.
Return ONLY JSON:
{
  "estimated_leak": integer (sum of the leak impacts, whole dollars),
  "confidence": "Low" | "Medium" | "High",
  "health_score": integer 0-100,
  "summary": "2-3 sentences, the week in one read, operator voice",
  "leaks": [{"type":"Labour leak"|"Menu pricing leak"|"Supplier leak"|"Waste leak",
             "title":"operator-voice headline","impact":integer_per_week_or_month_dollars,
             "what":"what's going on","why":"why it matters","action":"what I'd do","saving":"$x/week or $x-$y/month"}],
  "actions": ["short fix 1","short fix 2","short fix 3"]
}
Order leaks biggest first. 2-4 leaks. Be specific and useful, not generic.`;

    const narrated = parseJSON(await claude(narrateSystem, [{
      type: "text", text: JSON.stringify({
        cafe: { name: cafe?.name, location: cafe?.location, avg_weekly_revenue: cafe?.avg_weekly_revenue },
        week_starting: wi.week_starting,
        owner_notes: wi.context?.notes || "",
        context: wi.context || {},
        metrics,
        extraction_confidence: confidence,
      }, null, 2),
    }], 2500));

    // ====================================================================
    // 5. SAVE — auto-publish when confident, else flag for review
    // ====================================================================
    // hold (draft) only when there's a concrete, explainable reason
    const publish = reviewReasons.length === 0;
    const weekLabel = "Week starting " + new Date(wi.week_starting)
      .toLocaleDateString("en-AU", { day: "numeric", month: "long" });

    const { data: report, error: e2 } = await sb.from("reports").insert({
      cafe_id: wi.cafe_id,
      weekly_input_id: wi.id,
      week_label: weekLabel,
      week_starting: wi.week_starting,
      estimated_leak: narrated.estimated_leak,
      confidence: narrated.confidence,
      health_score: narrated.health_score,
      summary: narrated.summary,
      data: {
        annual: narrated.estimated_leak ? `$${Math.round(narrated.estimated_leak * 52).toLocaleString()} a year if nothing changes` : null,
        generated: "Generated " + new Date().toLocaleString("en-AU"),
        leaks: narrated.leaks,
        actions: narrated.actions,
        supplier_prices: extracted.supplier_prices, // kept for next week's creep comparison
        metrics,
        validation_issues: issues,
        review_reasons: reviewReasons,                         // why it was held + how to fix (owner-facing)
        review_reason: reviewReasons[0]?.what || null,
      },
      published: publish,
    }).select().single();
    if (e2) throw e2;

    // mark the input processed
    await sb.from("weekly_inputs").update({ status: "processed" }).eq("id", wi.id);

    return new Response(JSON.stringify({
      ok: true, report_id: report.id, published: publish,
      needs_review: !publish, confidence, issues,
    }), { headers: { ...cors, "content-type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 500, headers: { ...cors, "content-type": "application/json" } });
  }
});
