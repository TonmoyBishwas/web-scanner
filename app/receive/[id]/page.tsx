import type { Metadata } from 'next';
import { verifyReceiptFormLink } from '@/lib/receipt-form-link';
import { closedView, type FormLanguage } from '@/lib/receipt-form';
import { formState, loadFormRow, logFormEvent, replacedFormIds, type FormRow } from '@/lib/receipt-form-server';
import { isFinalStatus, isInFlightStatus } from '@/lib/receipt-form-submit';
import { t, type TranslationKey } from '@/lib/i18n/server';
import { FormMoved, ReceiptForm } from './ReceiptForm';

/**
 * The non-meat "fill in what's missing" form.
 *
 * Opened from the bot's WhatsApp message: `/receive/{form_id}?exp=<unix s>&sig=<hex>`
 * (lib/receipt-form-link.ts, 3-day links). Everything is pre-filled from the
 * delivery note; the worker fixes only what is missing or red and approves
 * once (POST /api/receipt-form/{id}, which checks the link again).
 *
 * Server component: the link is verified BEFORE the row is read, so a bad
 * link learns nothing about the form.
 *
 * A closed form says why (bot 20/10, `result.closed_reason`): replaced → on
 * to the newer link (the draft goes with it), cancelled / reset → "this
 * receipt was cancelled", ops_duplicate → "closed as a duplicate", finished in
 * the chat (or no reason) → "already saved". Every open is one scanner_events
 * row (page 'receive', token = form id).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'קבלת סחורה',
  // The signed link is in the URL: keep it out of Referer headers and indexes.
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
}

/** A full-screen message: link invalid, already saved, being saved, failed. */
function Notice({
  language,
  title,
  body,
  tone,
  refreshHref,
  bilingual,
}: {
  language: FormLanguage;
  title: TranslationKey;
  body: TranslationKey;
  tone: 'ok' | 'warn' | 'danger' | 'info';
  refreshHref?: string;
  bilingual?: boolean;
}) {
  const icon = { ok: 'check', warn: 'hourglass_top', danger: 'link_off', info: 'info' }[tone];
  const ring = {
    ok: 'bg-ok text-[#04210f] shadow-[0_0_60px_rgba(34,197,94,0.55)]',
    warn: 'bg-warn text-[#1a1100] shadow-[0_0_60px_rgba(245,158,11,0.5)]',
    danger: 'bg-danger text-white shadow-[0_0_60px_rgba(239,68,68,0.5)]',
    info: 'bg-info text-[#160a33] shadow-[0_0_60px_rgba(167,139,250,0.5)]',
  }[tone];
  const glow = { ok: 'rgba(34,197,94,0.22)', warn: 'rgba(245,158,11,0.2)', danger: 'rgba(239,68,68,0.2)', info: 'rgba(167,139,250,0.2)' }[tone];
  const other: FormLanguage = language === 'Hebrew' ? 'English' : 'Hebrew';
  return (
    <main
      dir={language === 'Hebrew' ? 'rtl' : 'ltr'}
      lang={language === 'Hebrew' ? 'he' : 'en'}
      className="min-h-dvh text-ink flex items-center justify-center px-4"
      style={{ background: `radial-gradient(circle at 50% 30%, ${glow}, var(--surface-canvas) 65%)` }}
    >
      <div className="w-full max-w-md rounded-3xl border-2 border-line bg-raised/90 p-7 text-center space-y-4 shadow-2xl shadow-black/40">
        <span aria-hidden className={`mi mx-auto grid h-24 w-24 place-items-center rounded-full ${ring}`} style={{ fontSize: 60 }}>
          {icon}
        </span>
        <h1 className="text-xl font-extrabold">{t(language, title)}</h1>
        <p className="text-ink-body">{t(language, body)}</p>
        {bilingual && (
          <div dir={other === 'Hebrew' ? 'rtl' : 'ltr'} className="pt-3 border-t border-line text-sm text-ink-muted space-y-1">
            <p className="font-bold">{t(other, title)}</p>
            <p>{t(other, body)}</p>
          </div>
        )}
        {refreshHref && (
          <a
            href={refreshHref}
            className="inline-flex min-h-12 items-center justify-center rounded-2xl bg-brand px-6 font-extrabold text-white"
          >
            {t(language, 'receive.refresh')}
          </a>
        )}
      </div>
    </main>
  );
}

export default async function ReceivePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const exp = one(sp.exp);
  const sig = one(sp.sig);

  const invalid = (
    <Notice language="Hebrew" title="receive.linkInvalidTitle" body="receive.linkInvalidBody" tone="danger" bilingual />
  );
  if (!verifyReceiptFormLink(id, exp, sig)) return invalid;

  let row: FormRow | null = null;
  try {
    row = await loadFormRow(id);
  } catch (err) {
    console.error('[receive] load failed:', id, err);
    throw err; // Next's error page; a refresh retries
  }
  if (!row) return invalid;

  const language: FormLanguage = row.language === 'English' ? 'English' : 'Hebrew';
  const st = await formState(row);
  const status = st.status;
  const self = `/receive/${id}?${new URLSearchParams({ exp, sig }).toString()}`;
  await logFormEvent(row, 'receive_open', {
    status, rev: st.rev, line_count: st.line_count, closed_reason: st.closed_reason,
    newer: st.newer?.id ?? null, expired: st.expired,
  });

  if (isFinalStatus(status)) {
    const view = closedView(status, st.closed_reason);
    if (view === 'replaced') {
      if (st.newer) return <FormMoved formId={id} language={language} newer={st.newer} />;
      return <Notice language={language} title="receive.replacedTitle" body="receive.replacedBody" tone="info" />;
    }
    if (view === 'cancelled') {
      return <Notice language={language} title="receive.cancelledTitle" body="receive.cancelledBody" tone="info" />;
    }
    if (view === 'duplicate') {
      return <Notice language={language} title="receive.duplicateTitle" body="receive.duplicateBody" tone="info" />;
    }
    return <Notice language={language} title="receive.alreadySavedTitle" body="receive.alreadySavedBody" tone="ok" />;
  }
  if (isInFlightStatus(status)) {
    return (
      <Notice
        language={language}
        title="receive.beingSavedTitle"
        body="receive.beingSavedBody"
        tone="warn"
        refreshHref={self}
      />
    );
  }
  if (status !== 'open') {
    return <Notice language={language} title="receive.failedTitle" body="receive.failedBody" tone="info" />;
  }
  if (st.expired) {
    return <Notice language={language} title="receive.linkInvalidTitle" body="receive.linkInvalidBody" tone="danger" />;
  }

  // The draft typed on a form this one replaced, if the worker came straight to the new link.
  const previous = await replacedFormIds(row).catch(() => [] as string[]);
  return (
    <ReceiptForm
      formId={id}
      exp={exp}
      sig={sig}
      language={language}
      header={st.header}
      lines={st.lines}
      previousFormIds={previous}
    />
  );
}
