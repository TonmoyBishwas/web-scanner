import { NextRequest, NextResponse } from 'next/server';
import { getRedisClient, sessionStorage } from '@/lib/redis';
import { t } from '@/lib/i18n/server';
import type { MultiPalletSession, MultiPalletBoxScan, Language } from '@/types';
import { groupKeyForBox, groupBoxesByName } from '@/lib/group-key';
import { matchInvoiceItem } from '@/lib/invoice-match';
import { nonMeatItemKey } from '@/lib/nonmeat-key';
import { markDone, isComplete } from '@/lib/pallet-slots';
import { isSplitSession, splitStateOf, applySplitState } from '@/lib/session-mode';

const SESSION_TTL = 7200;
// "Same weight" means the printed weights are EXACTLY equal — a fixed-weight
// product stamps the identical kg on every box. Catch-weight boxes that look
// close (e.g. 10.090 vs 10.080 — 10 g apart) are DIFFERENT and must each be
// scanned, so there is NO grace band (changed from 0.5 kg on 2026-05-31). This
// epsilon (0.1 g — below the 1 g label resolution) only absorbs floating-point
// noise. Mirrors UNIFORM_WEIGHT_TOLERANCE in pallet-verify/page.tsx.
const UNIFORM_WEIGHT_TOLERANCE_KG = 0.0001;

function sessionKey(token: string) {
  return `pallet:multi:${token}`;
}

async function getSession(token: string): Promise<MultiPalletSession | null> {
  const redis = getRedisClient();
  const raw = await redis.get(sessionKey(token));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : (raw as MultiPalletSession);
}

function generateLPN(documentNumber: string, palletNumber: number, category?: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const docShort = documentNumber.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'DOC';
  // Weight-based non-meat pallets get an NM- prefix so the bot's outbound
  // gateway routes them to the non-meat ledger.
  const prefix = category === 'non_meat' ? 'NM-' : '';
  return `${prefix}LPN-${date}-${docShort}-P${palletNumber}`;
}

/**
 * Classify the pallet into one of the four configurations the warehouse
 * domain recognises:
 *
 *   1. Single   — one item, all weights EXACTLY equal                 →  single
 *   2. Mix (a)  — one item, weights differ at all (even ~10 g)        →  mix
 *   3. Mix (b)  — 2+ items, varying weights per item                  →  mix
 *   4. Mix (c)  — 2+ items, each item uniform internally              →  mix
 *
 * Pre-2026-05-15 this was keyed on `box.sku` (= barcode digits), so
 * scenario (a) wrongly returned 'single' and scenario (1) sometimes
 * split into multiple SKUs when OCR misread a barcode digit. Now keyed
 * on the OCR'd Hebrew name via groupKeyForBox.
 */
function detectPalletType(
  boxes: MultiPalletBoxScan[],
  mergeMap?: Map<string, string>,
): { pallet_type: 'single' | 'mix'; uniform_weight: boolean } {
  if (boxes.length === 0) return { pallet_type: 'single', uniform_weight: true };

  const groups = groupBoxesByName(boxes, mergeMap);
  if (groups.size > 1) return { pallet_type: 'mix', uniform_weight: false };

  const [onlyGroup] = groups.values();
  const weights = onlyGroup.map((b) => b.weight).filter((w) => w > 0);
  if (weights.length < 2) return { pallet_type: 'single', uniform_weight: true };

  const range = Math.max(...weights) - Math.min(...weights);
  return range < UNIFORM_WEIGHT_TOLERANCE_KG
    ? { pallet_type: 'single', uniform_weight: true }
    : { pallet_type: 'mix', uniform_weight: false };
}

/**
 * Look up the invoice line item that matches a scanned-name group. Returns
 * the OCR'd short item_code from the invoice if found — otherwise empty
 * string. Bot's `_find_stock_batch_for_item` falls back to name-based
 * matching so an empty item_code is still safe for downstream writes.
 */
function findInvoiceItemCode(
  groupKey: string,
  sampleNameHebrew: string,
  sampleNameEnglish: string,
  invoiceItems: MultiPalletSession['ocr_data'] | undefined,
): string {
  void groupKey; // grouping is name-based; kept for call-site stability
  return matchInvoiceItem(sampleNameHebrew, sampleNameEnglish, invoiceItems)?.item_code || '';
}

/**
 * Resolve which supplier invoice a scanned box/item belongs to. On a normal
 * delivery every line shares `session.document_number`; on a multi-invoice
 * delivery (two same-supplier invoices merged onto one physical pallet) each
 * invoice line carries its own `document_number`, so a box that name-matches
 * that line gets stamped with the correct invoice. Falls back to the (single or
 * combined) session document number when nothing matches.
 */
function findInvoiceDoc(
  sampleNameHebrew: string,
  sampleNameEnglish: string,
  invoiceItems: MultiPalletSession['ocr_data'] | undefined,
  fallback: string,
): string {
  return matchInvoiceItem(sampleNameHebrew, sampleNameEnglish, invoiceItems)?.document_number || fallback;
}

/**
 * POST /api/multi-pallet-complete
 * Finalise one pallet within a multi-pallet session.
 *
 * Body:
 *   token          - session token
 *   scanned_boxes  - array of MultiPalletBoxScan
 *   box_count      - total box count declared by worker (used for uniform single)
 *   uniform_groups - optional per-NAME-KEY overrides where one or more items
 *                    are uniform-weight. Worker scans 2 sample boxes and
 *                    reports the real total_count; we trust that.
 *   merge_map      - optional Map of {originalKey → canonicalKey} representing
 *                    AI-suggested merges the worker accepted. Server applies
 *                    this when grouping so the webhook payload reflects the
 *                    worker's confirmed item set.
 */
type UniformGroupOverride = {
  // Post-2026-05-15: keyed on the normalized name (`he:...`/`en:...`).
  // Older clients may still send `sku` — accept either for graceful rollout.
  name_key?: string;
  sku?: string;
  total_count: number;
  avg_weight?: number;
};

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, scanned_boxes, box_count, uniform_groups, merge_map, nonmeat_items,
      manual_declared, manual_items, worker_chat_id } = body as {
      token: string;
      scanned_boxes: MultiPalletBoxScan[];
      box_count: number;
      uniform_groups?: UniformGroupOverride[];
      merge_map?: Record<string, string>;
      // Weight-based non-meat (Type A): one entry per invoice item scanned on
      // this pallet. Totals are computed server-side from session.ocr_data.
      nonmeat_items?: Array<{ item_key: string; box_count: number; sample_barcode?: string }>;
      // Meat damaged-sticker mode: worker declared per-item box counts instead
      // of scanning every box. Totals use the invoice per-box weight.
      manual_declared?: boolean;
      manual_items?: Array<{ item_key: string; box_count: number; sample_barcode?: string }>;
      // Split jobs: which worker is finishing this pallet. Ignored on single
      // sessions (the cursor's owner is always session.chat_id there).
      worker_chat_id?: string;
    };

    if (!token) {
      return NextResponse.json({ success: false, error: t(undefined, 'errors.missingToken') }, { status: 400 });
    }

    let errorResult: { status: number; body: Record<string, unknown> } | null = null;
    let okResult: Record<string, unknown> | null = null;

    // Lock the session for the full read-modify-write so concurrent
    // pallet-completes can't clobber `current_pallet` / `completed_pallets`.
    await sessionStorage.withLock(token, async () => {
    const session = await getSession(token);
    if (!session) {
      errorResult = { status: 404, body: { success: false, error: t(undefined, 'errors.sessionNotFound') } };
      return;
    }
    const lang = session.language as Language | undefined;
    if (session.status === 'completed') {
      errorResult = { status: 400, body: { success: false, error: t(lang, 'errors.sessionAlreadyCompleted') } };
      return;
    }

    // Split jobs: the worker is finishing the slot they claimed, which is not
    // a global cursor — two workers hold two different slots at once. Single
    // jobs keep the cursor exactly as before.
    const split = isSplitSession(session);
    const workerChatId = split ? String(worker_chat_id ?? '') : session.chat_id;
    const claimedSlot = split
      ? (session.pallets ?? []).find(
          (p) => p.owner === workerChatId && p.status === 'claimed',
        )
      : undefined;
    if (split && !claimedSlot) {
      errorResult = { status: 409, body: { success: false, error: 'no_claimed_pallet' } };
      return;
    }
    const palletNumber = split ? claimedSlot!.n : session.current_pallet;

    // ── Weight-based non-meat (Type A): invoice-authoritative math ──────────
    // The worker scanned one box per item on this pallet; the total for each
    // item is invoice unit-weight × the per-pallet carton count. We never trust
    // scanned weights here — everything comes from session.ocr_data.
    if (session.category === 'non_meat') {
      const nmLpn = generateLPN(session.document_number, palletNumber, 'non_meat');
      const byKey = new Map<string, MultiPalletSession['ocr_data'][number]>();
      for (const line of session.ocr_data || []) byKey.set(nonMeatItemKey(line), line);

      const items = (nonmeat_items || [])
        .map((ni) => {
          const line = byKey.get(ni.item_key);
          const cartons = Math.max(0, Math.floor(Number(ni.box_count) || 0));
          if (!line || cartons <= 0) return null;
          const unit =
            line.unit_weight_kg && line.unit_weight_kg > 0
              ? line.unit_weight_kg
              : line.box_count && line.quantity_kg
                ? line.quantity_kg / line.box_count
                : 0;
          const unitRounded = Math.round(unit * 1000) / 1000;
          return {
            item_code: line.item_code || '',
            item_name: line.item_name_english || '',
            item_name_english: line.item_name_english || '',
            item_name_hebrew: line.item_name_hebrew || '',
            name_key: ni.item_key,
            box_count: cartons,
            calculated_total_weight: Math.round(unit * cartons * 1000) / 1000,
            ocr_box_weight: unitRounded,
            uniform_weight: true,
            sample_barcode: ni.sample_barcode || '',
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (items.length === 0) {
        errorResult = { status: 400, body: { success: false, error: t(lang, 'errors.serverError') } };
        return;
      }

      const nmScannedBoxes = items.map((it) => ({
        barcode: it.sample_barcode,
        sku: '',
        weight: it.ocr_box_weight,
        expiry: '',
        item_name: it.item_name,
        item_name_hebrew: it.item_name_hebrew,
      }));

      const nmPayload: Record<string, unknown> = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn: nmLpn,
        category: 'non_meat',
        nonmeat_meta: session.nonmeat_meta ?? null,
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: items.length,
        scanned_boxes: nmScannedBoxes,
      };
      if (items.length > 1) {
        nmPayload.pallet_type = 'mix';
        nmPayload.items = items;
      } else {
        const only = items[0];
        nmPayload.pallet_type = 'single';
        nmPayload.item_code = only.item_code;
        nmPayload.item_name = only.item_name;
        nmPayload.item_name_hebrew = only.item_name_hebrew;
        nmPayload.box_count = only.box_count;
        nmPayload.ocr_box_weight = only.ocr_box_weight;
        nmPayload.calculated_total_weight = only.calculated_total_weight;
      }

      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      if (botUrl) {
        fetch(`${botUrl}/webhook/pallet-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(nmPayload),
        }).catch((err) => console.error('[multi-pallet-complete] Bot webhook (non_meat) failed:', err));
      }

      // Accumulate committed cartons per item so a later pallet pre-fills the
      // correct remaining and never double-counts a split item.
      const committed: Record<string, number> = { ...(session.nonmeat_committed || {}) };
      for (const it of items) committed[it.name_key] = (committed[it.name_key] || 0) + it.box_count;

      const totalCartons = items.reduce((s, it) => s + it.box_count, 0);
      const nmNextPallet = palletNumber + 1;
      const nmAllDone = nmNextPallet > session.pallet_count; // loose is 0 for Type A

      const nmUpdated: MultiPalletSession = {
        ...session,
        current_pallet: nmNextPallet,
        status: nmAllDone ? 'completed' : 'active',
        nonmeat_committed: committed,
        completed_pallets: [
          ...session.completed_pallets,
          {
            pallet_number: palletNumber,
            lpn: nmLpn,
            pallet_type: items.length > 1 ? 'mix' : 'single',
            box_count: totalCartons,
          },
        ],
      };
      const redisNm = getRedisClient();
      await redisNm.set(sessionKey(token), JSON.stringify(nmUpdated), { ex: SESSION_TTL });

      const nmAppUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
      okResult = {
        success: true,
        lpn: nmLpn,
        lpn_url: `${nmAppUrl}/pallet/${nmLpn}`,
        pallet_number: palletNumber,
        next_pallet: nmAllDone ? null : nmNextPallet,
        all_done: nmAllDone,
      };
      return;
    }

    // ── Meat damaged-sticker mode: worker DECLARED per-item box counts ──────
    // Stickers were unreadable, so instead of scanning every box the worker
    // entered how many boxes of each invoice item are on this pallet. Totals
    // use the invoice per-box weight (quantity_kg / box_count) — no per-box
    // scan is required, so the pallet can always complete. The bot writes the
    // meat ledger but marks the lines unverified (sticker_damaged=true).
    if (manual_declared) {
      const mLpn = generateLPN(session.document_number, palletNumber); // meat prefix
      const byKey = new Map<string, MultiPalletSession['ocr_data'][number]>();
      for (const line of session.ocr_data || []) byKey.set(nonMeatItemKey(line), line);

      const items = (manual_items || [])
        .map((mi) => {
          const line = byKey.get(mi.item_key);
          const cartons = Math.max(0, Math.floor(Number(mi.box_count) || 0));
          if (!line || cartons <= 0) return null;
          const unit = line.box_count && line.quantity_kg ? line.quantity_kg / line.box_count : 0;
          const unitRounded = Math.round(unit * 1000) / 1000;
          return {
            item_code: line.item_code || '',
            item_name: line.item_name_english || '',
            item_name_english: line.item_name_english || '',
            item_name_hebrew: line.item_name_hebrew || '',
            name_key: mi.item_key,
            box_count: cartons,
            calculated_total_weight: Math.round(unit * cartons * 1000) / 1000,
            ocr_box_weight: unitRounded,
            uniform_weight: true,
            sticker_damaged: true,
            sample_barcode: mi.sample_barcode || '',
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      if (items.length === 0) {
        errorResult = { status: 400, body: { success: false, error: t(lang, 'errors.serverError') } };
        return;
      }

      // Only items with a scanned sample box become traceable box_inventory rows.
      const mScannedBoxes = items
        .filter((it) => it.sample_barcode)
        .map((it) => ({
          barcode: it.sample_barcode,
          sku: '',
          name_key: it.name_key,
          weight: it.ocr_box_weight,
          expiry: '',
          item_name: it.item_name,
          item_name_hebrew: it.item_name_hebrew,
        }));

      const mPayload: Record<string, unknown> = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn: mLpn,
        category: 'meat',
        manual_declared: true,
        pallet_type: items.length > 1 ? 'mix' : 'single',
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: mScannedBoxes.length,
        items,
        scanned_boxes: mScannedBoxes,
      };

      // Accumulate declared boxes per item so a later pallet pre-fills the
      // correct remaining and never double-counts a split item.
      const committed: Record<string, number> = { ...(session.meat_committed || {}) };
      for (const it of items) committed[it.name_key] = (committed[it.name_key] || 0) + it.box_count;

      const totalBoxes = items.reduce((s, it) => s + it.box_count, 0);

      // Advance session: split jobs mark the claimed slot done instead of
      // touching current_pallet — a split session can reach this branch too
      // (unreadable stickers, declared counts). Single jobs keep advancing
      // the cursor exactly as before.
      const mNextPallet = palletNumber + 1;
      const mAllPalletsDone = mNextPallet > session.pallet_count;

      const mCompletedEntry = {
        pallet_number: palletNumber,
        lpn: mLpn,
        pallet_type: items.length > 1 ? 'mix' : 'single',
        box_count: totalBoxes,
        // Who declared this pallet's counts. Drives the per-worker close-out
        // the bot sends at finalization.
        worker_chat_id: workerChatId,
      };

      let mUpdated: MultiPalletSession;
      let mIsFinal: boolean;

      if (split) {
        const marked = markDone(splitStateOf(session), palletNumber, mLpn, totalBoxes);
        if (!marked.ok) {
          errorResult = { status: 409, body: { success: false, error: marked.reason } };
          return;
        }
        mUpdated = {
          ...applySplitState(session, marked.state),
          meat_committed: committed,
          completed_pallets: [...session.completed_pallets, mCompletedEntry],
        };
        mIsFinal = isComplete(marked.state);
        if (mIsFinal) mUpdated.status = 'completed';
      } else {
        // Same completion rule this branch has always had: every pallet
        // declared AND no loose boxes declared on this delivery. The original
        // code wrote `status: mFullyDone ? 'completed' : 'active'` here;
        // dropping it would silently stop this branch from ever completing a
        // single-scanner delivery — the same omission Step 2 had to guard
        // against in the plain meat branch.
        mIsFinal = mAllPalletsDone && session.loose_box_count === 0;
        mUpdated = {
          ...session,
          current_pallet: mNextPallet,
          meat_committed: committed,
          completed_pallets: [...session.completed_pallets, mCompletedEntry],
          status: mIsFinal ? 'completed' : 'active',
        };
      }

      mPayload.worker_chat_id = workerChatId;
      mPayload.owner_chat_id = session.owner_chat_id ?? session.chat_id;
      mPayload.is_final = mIsFinal;
      mPayload.all_completed_pallets = mIsFinal ? mUpdated.completed_pallets : undefined;
      // Everyone on the job, so the bot can send each of them their own
      // close-out at finalization without a second lookup.
      mPayload.roster_chat_ids = mIsFinal ? (session.roster ?? []).map((r) => r.chat_id) : undefined;

      const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
      if (botUrl) {
        fetch(`${botUrl}/webhook/pallet-complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mPayload),
        }).catch((err) => console.error('[multi-pallet-complete] Bot webhook (manual) failed:', err));
      }

      const redisM = getRedisClient();
      await redisM.set(sessionKey(token), JSON.stringify(mUpdated), { ex: SESSION_TTL });

      const mAppUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
      okResult = {
        success: true,
        lpn: mLpn,
        lpn_url: `${mAppUrl}/pallet/${mLpn}`,
        pallet_number: palletNumber,
        next_pallet: mAllPalletsDone ? null : mNextPallet,
        all_done: mAllPalletsDone,
      };
      return;
    }

    const lpn = generateLPN(session.document_number, palletNumber, session.category);

    // Worker-accepted AI merges (originalKey → canonicalKey).
    const mergeMap = new Map<string, string>(Object.entries(merge_map ?? {}));

    const { pallet_type, uniform_weight } = detectPalletType(scanned_boxes, mergeMap);

    // Build webhook payload — same contract as existing /webhook/pallet-complete
    let webhookPayload: Record<string, unknown>;

    if (pallet_type === 'mix') {
      // Group boxes by the OCR'd Hebrew name (with the worker's accepted merges
      // applied). The barcode digits play no role in grouping — they only exist
      // to prevent duplicate scans of the same physical box.
      const grouped = groupBoxesByName(scanned_boxes, mergeMap);

      const items = Array.from(grouped.entries()).map(([nameKey, itemBoxes]) => {
        const override =
          uniform_groups?.find((g) => g.name_key === nameKey) ??
          // Backward-compat: older clients sent `sku` (which used to be the
          // grouping key). If the override's sku matches any scanned box's
          // sku in this group, accept it.
          uniform_groups?.find((g) => g.sku && itemBoxes.some((b) => b.sku === g.sku));
        const weights = itemBoxes.map((b) => b.weight).filter((w) => w > 0);
        const weightRange = weights.length > 1 ? Math.max(...weights) - Math.min(...weights) : 0;
        const isUniform = override !== undefined || weightRange < UNIFORM_WEIGHT_TOLERANCE_KG;
        const scannedAvg = weights.length > 0 ? weights.reduce((a, b) => a + b, 0) / weights.length : 0;
        const avgWeight = override?.avg_weight ?? scannedAvg;
        // For uniform sub-groups the worker only physically scans 2 sample
        // boxes; total_count is the true count reported via the prompt.
        const totalBoxCount = override?.total_count ?? itemBoxes.length;
        const calcWeight = isUniform
          ? Math.round(avgWeight * totalBoxCount * 1000) / 1000
          : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;

        // Sample box → invoice cross-ref. The first box in the group is
        // representative since they all share a normalized name.
        const sample = itemBoxes[0];
        const itemNameEnglish = itemBoxes.find((b) => b.item_name)?.item_name || '';
        const itemNameHebrew = itemBoxes.find((b) => b.item_name_hebrew)?.item_name_hebrew || '';
        const invoiceItemCode = findInvoiceItemCode(
          nameKey,
          itemNameHebrew,
          itemNameEnglish,
          session.ocr_data,
        );

        return {
          // item_code is the OCR'd short product code from the invoice
          // (e.g. "10004"), NOT the barcode digits. Empty when no invoice
          // line matches this name — bot falls back to name-based Stock
          // Batches matching.
          item_code: invoiceItemCode,
          item_name: itemNameEnglish,
          item_name_hebrew: itemNameHebrew,
          name_key: nameKey,
          box_count: totalBoxCount,
          calculated_total_weight: calcWeight,
          uniform_weight: isUniform,
          sample_barcode: sample?.barcode || '',
          // Multi-invoice delivery: which invoice this item came from (for
          // display/audit); per-box provenance is carried on scanned_boxes below.
          document_number: findInvoiceDoc(itemNameHebrew, itemNameEnglish, session.ocr_data, session.document_number),
        };
      });

      webhookPayload = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn,
        pallet_type: 'mix',
        category: session.category ?? 'meat',
        nonmeat_meta: session.nonmeat_meta ?? null,
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: scanned_boxes.length,
        items,
        // scanned_boxes intentionally drops the `item_code` field — barcode
        // digits aren't a product identifier. The box's Hebrew name carries
        // its identity; bot looks up the parent Pallet Item via name match.
        scanned_boxes: scanned_boxes.map((b) => ({
          barcode: b.barcode,
          sku: b.sku, // legacy field; stored as Box SKU column for dedup queries
          name_key: mergeMap.get(groupKeyForBox(b)) ?? groupKeyForBox(b),
          weight: b.weight,
          expiry: b.expiry,
          item_name: b.item_name,
          item_name_hebrew: b.item_name_hebrew,
          // Multi-invoice delivery: stamp each box with ITS invoice number so
          // the bot writes the right box_inventory.invoice_number per box.
          document_number: findInvoiceDoc(b.item_name_hebrew || '', b.item_name || '', session.ocr_data, session.document_number),
        })),
      };
    } else {
      // Single-item pallet — exactly one name-group.
      const grouped = groupBoxesByName(scanned_boxes, mergeMap);
      const [onlyGroupBoxes] = grouped.values() ?? [scanned_boxes];
      const itemBoxes = onlyGroupBoxes ?? scanned_boxes;
      const itemNameEnglish = itemBoxes.find((b) => b.item_name)?.item_name || '';
      const itemNameHebrew = itemBoxes.find((b) => b.item_name_hebrew)?.item_name_hebrew || '';
      const weights = itemBoxes.map((b) => b.weight).filter((w) => w > 0);
      const avgWeight =
        weights.length > 0 ? Math.round((weights.reduce((a, b) => a + b, 0) / weights.length) * 1000) / 1000 : 0;
      const totalBoxes = uniform_weight ? (box_count || itemBoxes.length) : itemBoxes.length;
      const calcWeight = uniform_weight
        ? Math.round(avgWeight * totalBoxes * 1000) / 1000
        : Math.round(weights.reduce((a, b) => a + b, 0) * 1000) / 1000;
      const invoiceItemCode = findInvoiceItemCode(
        '',
        itemNameHebrew,
        itemNameEnglish,
        session.ocr_data,
      );

      webhookPayload = {
        chat_id: session.chat_id,
        pallet_number: palletNumber,
        lpn,
        pallet_type: 'single',
        category: session.category ?? 'meat',
        nonmeat_meta: session.nonmeat_meta ?? null,
        scale_weight: 0,
        document_number: session.document_number,
        verified_scan_count: itemBoxes.length,
        item_code: invoiceItemCode,
        item_name: itemNameEnglish,
        item_name_hebrew: itemNameHebrew,
        box_count: totalBoxes,
        ocr_box_weight: avgWeight,
        calculated_total_weight: calcWeight,
        scanned_boxes: scanned_boxes.map((b) => ({
          barcode: b.barcode,
          sku: b.sku, // legacy field — Box SKU column for dedup
          name_key: mergeMap.get(groupKeyForBox(b)) ?? groupKeyForBox(b),
          weight: b.weight,
          expiry: b.expiry,
          item_name: b.item_name,
          item_name_hebrew: b.item_name_hebrew,
          // Multi-invoice delivery: the box's own invoice number (a single-item
          // pallet in a merged delivery still belongs to one specific invoice).
          document_number: findInvoiceDoc(b.item_name_hebrew || '', b.item_name || '', session.ocr_data, session.document_number),
        })),
      };
    }

    // Advance session: split jobs mark the claimed slot done; single jobs
    // keep advancing the current_pallet cursor exactly as before.
    const newCurrentPallet = palletNumber + 1;
    const allPalletsDone = newCurrentPallet > session.pallet_count;

    const completedEntry = {
      pallet_number: palletNumber,
      lpn,
      pallet_type,
      box_count: scanned_boxes.length,
      // Every box barcode registered on this pallet. Feeds the cross-worker
      // duplicate guard; meat only, where catch-weight barcodes are unique.
      barcodes: scanned_boxes.map((b) => b.barcode).filter(Boolean),
      // Who physically scanned this pallet. Drives the per-worker close-out
      // ("you finished N pallets") the bot sends at finalization.
      worker_chat_id: workerChatId,
    };

    let updatedSession: MultiPalletSession;
    let isFinal: boolean;

    if (split) {
      const marked = markDone(splitStateOf(session), palletNumber, lpn, scanned_boxes.length);
      if (!marked.ok) {
        errorResult = { status: 409, body: { success: false, error: marked.reason } };
        return;
      }
      updatedSession = {
        ...applySplitState(session, marked.state),
        completed_pallets: [...session.completed_pallets, completedEntry],
      };
      isFinal = isComplete(marked.state);
      if (isFinal) updatedSession.status = 'completed';
    } else {
      // Same completion rule as before the split feature existed: every
      // pallet scanned AND no loose boxes declared on this delivery.
      isFinal = allPalletsDone && session.loose_box_count === 0;
      updatedSession = {
        ...session,
        current_pallet: newCurrentPallet,
        status: isFinal ? 'completed' : 'active',
        completed_pallets: [...session.completed_pallets, completedEntry],
      };
    }

    // Fire webhook to bot (fire-and-forget)
    webhookPayload.worker_chat_id = workerChatId;
    webhookPayload.owner_chat_id = session.owner_chat_id ?? session.chat_id;
    webhookPayload.is_final = isFinal;
    webhookPayload.all_completed_pallets = isFinal ? updatedSession.completed_pallets : undefined;
    // Everyone on the job, so the bot can send each of them their own
    // close-out at finalization without a second lookup.
    webhookPayload.roster_chat_ids = isFinal ? (session.roster ?? []).map((r) => r.chat_id) : undefined;

    const botUrl = process.env.TELEGRAM_BOT_WEBHOOK_URL;
    if (botUrl) {
      fetch(`${botUrl}/webhook/pallet-complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(webhookPayload),
      }).catch((err) => console.error('[multi-pallet-complete] Bot webhook failed:', err));
    }

    const redis = getRedisClient();
    await redis.set(sessionKey(token), JSON.stringify(updatedSession), { ex: SESSION_TTL });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;

    okResult = {
      success: true,
      lpn,
      lpn_url: `${appUrl}/pallet/${lpn}`,
      pallet_number: palletNumber,
      next_pallet: allPalletsDone ? null : newCurrentPallet,
      all_done: allPalletsDone,
    };
    });

    if (errorResult) {
      const e = errorResult as { status: number; body: Record<string, unknown> };
      return NextResponse.json(e.body, { status: e.status });
    }
    return NextResponse.json(okResult);
  } catch (error) {
    console.error('[multi-pallet-complete] POST error:', error);
    return NextResponse.json({ success: false, error: t(undefined, 'errors.serverError') }, { status: 500 });
  }
}
