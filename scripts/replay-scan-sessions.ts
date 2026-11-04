/**
 * Release check (client, 01/11): "before every release rerun it on the last
 * week's real receipts and show that the results haven't changed."
 *
 * Pulls the last N days (default 7) of pallet-verify read traces from
 * scanner_events — READ-ONLY — and replays each session through the rules
 * before 01/11 (OLD: two reads for every value, no Glatt mid check, dedupe by
 * the exact string) and the current ones (NEW: lib/scan-replay.ts newRules).
 * Per session it reports the cartons each would book, the new confirms and
 * whether each is valid, any carton lost and any misread booked.
 *
 *   npx vite-node scripts/replay-scan-sessions.ts [--days 7] [--out report.md]
 *       needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (selects only)
 *   npx vite-node scripts/replay-scan-sessions.ts --input export.json [--out report.md]
 *       export.json = { events: [{token, ts (ms), event, data}], lines: {token: [{item_code}]}, booked: [barcode] }
 *
 * "valid" for a new confirm: it is a well-formed code, and its exact code
 * was booked in box_inventory (another path got it in the end) or a booked
 * code ends in the same 13 digits (weight + serial: the same carton, booked
 * under a damaged code). Anything else is listed as UNEXPLAINED.
 *
 * "would-book": a value NEW confirms on one read that the 3 s cooldown then
 * threw away, and OLD never confirmed. The cooldown saved the replay there,
 * not the rule — on another day it books — so it is checked like a new
 * confirm. A would-book that is not valid is a phantom the rule lets through.
 *
 * Limits: the trace keeps the reads the confirmer counted, not every frame,
 * and `read_dropped` is throttled to one event per value per 5 s
 * (SmartScanner traceDropped), so repeated single sightings are collapsed:
 * the replay sees fewer one-read chances than the floor does. OLD = live
 * is a consistency check of the rebuild, not proof of the new rule.
 *
 * --short-serial (item 1, 04/11): for sessions whose receipt's supplier VAT
 * is in SHORT_SERIAL_SUPPLIER_VATS (Wall Dan), a third replay SERIAL =
 * serialRules (the camera_short_serial flag on). Each serial SERIAL books is
 * 'exact' when box_inventory holds that barcode on the session's document
 * (a photo booking), else 'unbooked' (the receipt's minted / NOBC rows are
 * where such a carton went). A session is flagged when its unbooked serials
 * outnumber those rows. The export then also needs `vat`, `docs` and
 * `bookedRows`. Without the switch the output is unchanged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { barcodeFormatOk, isGlattMisread, sameGlattCarton, SHORT_SERIAL_SUPPLIER_VATS, type NoteLine } from '../lib/carton-barcode';
import { isMintedLabelBarcode } from '../lib/label-batches';
import { isNoBarcodeId } from '../lib/no-barcode';
import { framesFromTrace, newRules, oldRules, replayFrames, serialRules, type TraceRow } from '../lib/scan-replay';

interface Export {
  events: Array<{ token: string; ts: number; event: string; data: Record<string, unknown> | null }>;
  lines: Record<string, NoteLine[]>;
  booked: string[];
  /** --short-serial only: the session's receipt supplier VAT (deliveries.supplier_vat). */
  vat?: Record<string, string | null>;
  /** --short-serial only: the session's document number (box_inventory.invoice_number). */
  docs?: Record<string, string | null>;
  /** --short-serial only: box_inventory rows of those documents. */
  bookedRows?: Array<{ barcode: string; invoice_number: string | null; barcode_source: string | null }>;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function pull(days: number, shortSerial: boolean): Promise<Export> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, or pass --input export.json');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(url, key, { auth: { persistSession: false } });
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const events: Export['events'] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from('scanner_events')
      .select('token, ts, event, data')
      .eq('page', 'pallet-verify')
      .in('event', ['scan_confirmed', 'read_dropped', 'cooldown_drop', 'scan_detected', 'loose_scan_detected', 'manual_capture'])
      .gte('ts', since)
      .order('ts', { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`scanner_events: ${error.message}`);
    for (const r of data ?? []) events.push({ token: r.token, ts: Date.parse(r.ts), event: r.event, data: r.data });
    if (!data || data.length < 1000) break;
  }
  const tokens = [...new Set(events.map((e) => e.token))];
  const lines: Export['lines'] = {};
  const receipts: Record<string, string> = {};
  const docs: Record<string, string | null> = {};
  if (tokens.length) {
    const { data, error } = await db.from('scan_sessions').select('token, data').in('token', tokens);
    if (error) throw new Error(`scan_sessions: ${error.message}`);
    for (const s of data ?? []) {
      const ocr = (s.data as { ocr_data?: NoteLine[] } | null)?.ocr_data ?? [];
      lines[s.token] = ocr.map((l) => ({
        item_code: l.item_code ?? null,
        quantity_kg: l.quantity_kg ?? null,
        expected_boxes: l.expected_boxes ?? null,
      }));
      const sd = s.data as { receipt_id?: string; document_number?: string } | null;
      if (sd?.receipt_id) receipts[s.token] = sd.receipt_id;
      docs[s.token] = sd?.document_number ?? null;
    }
  }
  const booked: string[] = [];
  const bookedSince = new Date(Date.now() - (days + 7) * 86400_000).toISOString();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from('box_inventory').select('barcode').gte('created_at', bookedSince).range(from, from + 999);
    if (error) throw new Error(`box_inventory: ${error.message}`);
    for (const r of data ?? []) if (r.barcode) booked.push(r.barcode);
    if (!data || data.length < 1000) break;
  }
  if (!shortSerial) return { events, lines, booked };
  const vat: Record<string, string | null> = {};
  const ids = [...new Set(Object.values(receipts))];
  if (ids.length) {
    const { data, error } = await db.from('deliveries').select('id, supplier_vat').in('id', ids);
    if (error) throw new Error(`deliveries: ${error.message}`);
    const byId = new Map((data ?? []).map((d) => [String(d.id), d.supplier_vat == null ? null : String(d.supplier_vat)]));
    for (const [token, id] of Object.entries(receipts)) vat[token] = byId.get(id) ?? null;
  }
  const serialDocs = Object.entries(docs)
    .filter(([token, d]) => d && SHORT_SERIAL_SUPPLIER_VATS.includes(vat[token] ?? ''))
    .map(([, d]) => d as string);
  const bookedRows: NonNullable<Export['bookedRows']> = [];
  if (serialDocs.length) {
    const { data, error } = await db.from('box_inventory').select('barcode, invoice_number, barcode_source').in('invoice_number', [...new Set(serialDocs)]);
    if (error) throw new Error(`box_inventory: ${error.message}`);
    for (const r of data ?? []) if (r.barcode) bookedRows.push({ barcode: r.barcode, invoice_number: r.invoice_number, barcode_source: r.barcode_source });
  }
  return { events, lines, booked, vat, docs, bookedRows };
}

async function main() {
  const days = Number(arg('days') ?? 7);
  const input = arg('input');
  const shortSerial = process.argv.includes('--short-serial');
  const ex: Export = input ? JSON.parse(readFileSync(input, 'utf8')) : await pull(days, shortSerial);
  const booked = new Set(ex.booked);
  const bookedList = [...booked];

  const byToken = new Map<string, TraceRow[]>();
  for (const e of ex.events) {
    const list = byToken.get(e.token) ?? [];
    list.push({ ts: e.ts, event: e.event, data: e.data });
    byToken.set(e.token, list);
  }

  const out: string[] = [];
  const totals = { sessions: 0, oldBooked: 0, newBooked: 0, newConfirms: 0, newValid: 0, wouldBook: 0, wouldBookValid: 0, lost: 0, oldMisreads: 0, newMisreads: 0, traceBooked: 0, oldMatchesTrace: 0 };
  // The same carton: the exact code, or the same last 13 digits (weight + serial).
  const isBooked = (v: string) => booked.has(v) || (v.length >= 13 && bookedList.some((c) => c.length >= 13 && c.slice(-13) === v.slice(-13)));
  // The carton was booked under a misread-mid string with the same 9-digit
  // serial (01/11: `…111510 1001 067936150` for the printed
  // `…110010 1011 067936150` — the decoder's misread hit the weight digits
  // too, so the 13-digit check cannot match it).
  const misreadBooked = (v: string) => v.length === 25 && bookedList.some((c) => isGlattMisread(c) && c.slice(-9) === v.slice(-9));
  const rowsMd: string[] = [];
  const details: string[] = [];
  const serialMd: string[] = [];
  const serialDetails: string[] = [];
  const serialTotals = { sessions: 0, old: 0, serial: 0, exact: 0, unbooked: 0, lost: 0, flagged: 0 };

  for (const [token, rows] of byToken) {
    rows.sort((a, b) => a.ts - b.ts);
    const frames = framesFromTrace(rows);
    if (frames.length === 0) continue;
    totals.sessions += 1;
    const lines = ex.lines[token] ?? [];
    const old = replayFrames(frames, oldRules());
    const neu = replayFrames(frames, newRules(lines));
    const oldSet = new Set(old.booked.map((b) => b.value));
    const newSet = new Set(neu.booked.map((b) => b.value));
    // What the live page actually added from the camera (scan_detected ok, not a duplicate).
    const traceSet = new Set(
      rows.filter((r) => (r.event === 'scan_detected' || r.event === 'loose_scan_detected') && r.data?.ok === true && r.data?.duplicate === false)
        .map((r) => String(r.data?.barcode ?? '').trim()).filter(Boolean),
    );
    const oldMatches = [...traceSet].filter((v) => oldSet.has(v)).length;

    const added = neu.booked.filter((b) => !oldSet.has(b.value));
    const check = (b: { value: string; t: number; reads: number }) => {
      const exact = booked.has(b.value);
      const sameCarton = !exact && isBooked(b.value);
      const viaMisread = !exact && !sameCarton && misreadBooked(b.value);
      const formatOk = barcodeFormatOk(b.value) === true;
      const valid = formatOk && (exact || sameCarton || viaMisread);
      return { ...b, exact, sameCarton, viaMisread, formatOk, valid };
    };
    const verdicts = added.map(check);
    const oldSeen = new Set([...old.booked, ...old.cooldownDropped, ...old.duplicates, ...old.refused].map((b) => b.value));
    const wouldBook = neu.cooldownDropped
      .filter((b) => b.reads === 1 && !oldSeen.has(b.value) && !newSet.has(b.value))
      .filter((b, i, a) => a.findIndex((x) => x.value === b.value) === i)
      .map(check);
    // Lost: booked by OLD, not by NEW, and no NEW booking is the same carton.
    // A misread-mid string OLD booked is not lost when NEW booked the valid code with its serial.
    const lost = old.booked.filter((b) => !newSet.has(b.value) && ![...newSet].some((v) => sameGlattCarton(v, b.value)
      || (isGlattMisread(b.value) && v.length === 25 && v.slice(-9) === b.value.slice(-9))));
    const misread = (v: string) => isGlattMisread(v) || barcodeFormatOk(v) === false;
    const oldMis = old.booked.filter((b) => misread(b.value));
    const newMis = neu.booked.filter((b) => misread(b.value));

    totals.oldBooked += old.booked.length;
    totals.newBooked += neu.booked.length;
    totals.newConfirms += added.length;
    totals.newValid += verdicts.filter((v) => v.valid).length;
    totals.wouldBook += wouldBook.length;
    totals.wouldBookValid += wouldBook.filter((v) => v.valid).length;
    totals.lost += lost.length;
    totals.oldMisreads += oldMis.length;
    totals.newMisreads += newMis.length;
    totals.traceBooked += traceSet.size;
    totals.oldMatchesTrace += oldMatches;

    const lineCodes = lines.map((l) => l.item_code).filter(Boolean).join(', ') || '(none)';
    rowsMd.push(`| \`${token}\` | ${lineCodes} | ${traceSet.size} | ${oldMatches} | ${old.booked.length} | ${neu.booked.length} | ${added.length} (${verdicts.filter((v) => v.valid).length} valid) | ${wouldBook.length} (${wouldBook.filter((v) => v.valid).length} valid) | ${lost.length} | ${oldMis.length} → ${newMis.length} |`);
    if (added.length || wouldBook.length || lost.length || oldMis.length || newMis.length) {
      details.push(`### \`${token}\``);
      for (const v of verdicts) {
        const why = v.exact ? 'booked in box_inventory under this exact code' : v.sameCarton ? 'same carton (weight + serial) is booked under a damaged code' : v.viaMisread ? 'same carton (serial) is booked under the refused misread-mid string' : 'NOT in box_inventory, no carton with its weight + serial';
        details.push(`- new confirm \`${v.value}\` (${v.reads} read${v.reads === 1 ? '' : 's'}): ${v.valid ? 'valid' : 'UNEXPLAINED'} — ${why}`);
      }
      for (const v of wouldBook) {
        const why = v.exact ? 'booked in box_inventory under this exact code' : v.sameCarton ? 'same carton (weight + serial) is booked under a damaged code' : v.viaMisread ? 'same carton (serial) is booked under the refused misread-mid string' : 'NOT in box_inventory, no carton with its weight + serial';
        details.push(`- would-book \`${v.value}\` (1 read, saved only by the 3 s cooldown): ${v.valid ? 'valid' : 'PHANTOM'} — ${why}`);
      }
      for (const b of lost) details.push(`- LOST \`${b.value}\` (booked before, not now)`);
      for (const b of oldMis) details.push(`- misread booked before: \`${b.value}\`${newSet.has(b.value) ? ' — STILL booked now' : ' — refused now'}`);
      for (const b of newMis) if (!oldSet.has(b.value)) details.push(`- misread booked NOW (new): \`${b.value}\``);
      details.push('');
    }

    // --short-serial: Wall Dan's 6-digit carton serials with camera_short_serial on.
    if (shortSerial && SHORT_SERIAL_SUPPLIER_VATS.includes(ex.vat?.[token] ?? '')) {
      const doc = ex.docs?.[token] ?? null;
      const docRows = (ex.bookedRows ?? []).filter((r) => doc && r.invoice_number === doc);
      const docCodes = new Set(docRows.map((r) => r.barcode));
      const stand = docRows.filter((r) => r.barcode_source === 'minted' || isMintedLabelBarcode(r.barcode) || isNoBarcodeId(r.barcode)).length;
      const serial = replayFrames(frames, serialRules(lines));
      const serialCodes = serial.booked.map((b) => b.value);
      const exact = serialCodes.filter((v) => docCodes.has(v));
      const unbooked = serialCodes.filter((v) => !docCodes.has(v));
      // Lost to the cooldown: dropped and never booked later in the replay.
      const lostSerial = [...new Set(serial.cooldownDropped.map((d) => d.value))].filter((v) => !serialCodes.includes(v));
      const flagged = unbooked.length > stand;
      serialTotals.sessions += 1;
      serialTotals.old += old.booked.length;
      serialTotals.serial += serialCodes.length;
      serialTotals.exact += exact.length;
      serialTotals.unbooked += unbooked.length;
      serialTotals.lost += lostSerial.length;
      if (flagged) serialTotals.flagged += 1;
      serialMd.push(`| \`${token}\` | ${doc ?? '?'} | ${old.booked.length} | ${serialCodes.length} | ${exact.length} | ${unbooked.length} | ${stand} | ${lostSerial.length} | ${flagged ? 'FLAG' : 'ok'} |`);
      serialDetails.push(`### \`${token}\` (document ${doc ?? '?'})`);
      for (const v of exact) serialDetails.push(`- \`${v}\`: exact — booked on this receipt under the serial`);
      for (const v of unbooked) serialDetails.push(`- \`${v}\`: unbooked — receipt has ${stand} minted/NOBC`);
      for (const v of lostSerial) serialDetails.push(`- \`${v}\`: lost to the 3 s cooldown in the replay (re-aimed on the floor)`);
      serialDetails.push('');
    }
  }

  out.push(`# Scanner read replay — ${new Date().toISOString()}`);
  out.push('');
  out.push(`Source: ${input ? `export \`${input}\`` : `scanner_events, last ${days} days (read-only)`}. ${totals.sessions} pallet-verify sessions with read traces.`);
  out.push('');
  out.push('OLD = before 01/11 (two identical reads within 3 s for every value; no Glatt mid check; duplicates by exact code). NEW = a valid Glatt code of one of the note\'s lines confirms on one read when a counted carton of its item is within 2000 serials (or another waiting read shares its serial) and its weight is within 15 % of the item\'s typical carton; a Glatt misread mid never confirms or books; duplicates also by Glatt serial (two valid codes) or weight + serial (valid vs damaged). Manual captures and edits are not replayed.');
  out.push('');
  out.push('Limits: the trace keeps the reads the confirmer counted, not every frame, and `read_dropped` is throttled to one event per value per 5 s, so repeated single sightings are collapsed — the replay sees fewer one-read chances than the floor. "OLD = live" checks the rebuild, it does not prove the new rule.');
  out.push('');
  out.push('## Totals');
  out.push('');
  out.push(`- Replay fidelity: the live page added ${totals.traceBooked} cartons from the camera; the OLD replay books ${totals.oldMatchesTrace} of those exact codes (${totals.oldBooked} in all).`);
  out.push(`- Cartons booked from the camera: OLD ${totals.oldBooked} → NEW ${totals.newBooked}.`);
  out.push(`- New confirms: ${totals.newConfirms}, of which valid: ${totals.newValid}.`);
  out.push(`- Would-book (one-read confirms the 3 s cooldown threw away, never confirmed by OLD): ${totals.wouldBook}, of which valid: ${totals.wouldBookValid} — the rest are phantoms the rule would book on another day.`);
  out.push(`- Cartons lost (booked OLD, not NEW, no same-carton NEW booking): ${totals.lost}.`);
  out.push(`- Misreads booked: OLD ${totals.oldMisreads} → NEW ${totals.newMisreads}.`);
  out.push('');
  out.push('## Per session');
  out.push('');
  out.push('| session | note lines | live adds | OLD = live | OLD booked | NEW booked | new confirms | would-book | lost | misreads booked OLD → NEW |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  out.push(...rowsMd);
  out.push('');
  if (details.length) {
    out.push('## Differences');
    out.push('');
    out.push(...details);
  }
  if (shortSerial) {
    out.push('## Short serials (camera_short_serial, item 1)');
    out.push('');
    out.push(`Sessions on a short-serial supplier's receipt (VAT ${SHORT_SERIAL_SUPPLIER_VATS.join(', ')}): ${serialTotals.sessions}. SERIAL = NEW with a 6-digit carton serial (no leading zero, not a line code or a piece of one) booked from the camera. An approximation: a refused value's confirms are traced at most once per 3 s.`);
    out.push('');
    out.push(`- Wall Dan serial cartons booked by camera OLD ${serialTotals.old} → SERIAL ${serialTotals.serial} (exact ${serialTotals.exact}, unbooked ${serialTotals.unbooked}; lost to the cooldown ${serialTotals.lost}; sessions flagged ${serialTotals.flagged}).`);
    out.push('');
    out.push('| session | document | OLD booked | SERIAL booked | exact | unbooked | minted/NOBC on receipt | lost to cooldown | check |');
    out.push('|---|---|---|---|---|---|---|---|---|');
    out.push(...serialMd);
    out.push('');
    out.push(...serialDetails);
  }
  const md = out.join('\n') + '\n';
  const target = arg('out');
  if (target) writeFileSync(target, md);
  process.stdout.write(md);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
