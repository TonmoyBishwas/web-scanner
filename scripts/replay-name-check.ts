/**
 * Note name check replay, scanner side (bot items 2 + 8, 04/11). READ-ONLY,
 * no network: it only reads the JSON the bot's replay exported.
 *
 * Pallet cartons get their note line from THIS matcher (lib/invoice-match.ts
 * matchInvoiceItem on scan_sessions.data.ocr_data), not from the bot's
 * Python port, so the bot's rename of a misread line name is replayed here:
 * every sticker the session read (/api/multi-pallet-ocr responses) is
 * matched against the session's ocr_data as it was (BEFORE) and as the bot
 * would now build it (AFTER, NOTE_NAME_CHECK_ENABLED). Each sticker whose
 * line changes is listed. Names only (step 0, the carton's own code, is not
 * in the export), as the live snap ran for these cartons.
 *
 *   python3 scripts/note_name_check_replay.py … --export /tmp/nc.json   (bot repo)
 *   npx vite-node scripts/replay-name-check.ts --input /tmp/nc.json [--out report.md]
 *
 * Exit 1 when a sticker that matched a line BEFORE matches a different line
 * or none AFTER (the rename took a carton away from a line it had).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { replaySession, type SessionExport } from './replay-name-check-core';

function main(): number {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const input = arg('--input');
  if (!input) { console.error('--input <bot export JSON> is required'); return 2; }
  const sessions: SessionExport[] = JSON.parse(readFileSync(input, 'utf8'));
  const out: string[] = ['# Name check — scanner matcher replay (read only)', ''];
  let lost = 0;
  for (const s of sessions) {
    const rows = replaySession(s);
    const changed = rows.filter((r) => r.before !== r.after);
    const kept = rows.length - changed.length;
    out.push(`## ${s.doc ?? ''} session ${s.token}: ${rows.length} stickers, ${changed.length} change line, ${kept} unchanged`);
    for (const r of changed) {
      const bad = r.before !== null;
      if (bad) lost++;
      out.push(`- ${bad ? 'LOST ' : ''}${r.sticker.ts ?? ''} ${JSON.stringify(r.sticker.he)} ${r.sticker.weight ?? ''} kg: `
        + `${r.before ?? 'no line'} → ${r.after ?? 'no line'}`);
    }
    const tally = (k: 'before' | 'after') => {
      const m = new Map<string, number>();
      for (const r of rows) m.set(r[k] ?? 'no line', (m.get(r[k] ?? 'no line') ?? 0) + 1);
      return [...m].map(([c, n]) => `${c}×${n}`).join(', ');
    };
    out.push(`- before: ${tally('before')}`, `- after:  ${tally('after')}`, '');
  }
  out.push(lost ? `${lost} sticker(s) lost the line they had — FAIL` : 'No sticker lost the line it had.');
  const text = out.join('\n');
  console.log(text);
  const o = arg('--out');
  if (o) writeFileSync(o, text + '\n');
  return lost ? 1 : 0;
}

process.exit(main());
