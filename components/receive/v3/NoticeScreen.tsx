'use client';

/**
 * Receive form v3, the full-screen notices (5.23): already saved, being
 * saved, failed, link invalid, cancelled, duplicate, replaced. Title + body,
 * the redirect block when it runs, and ONE button: "סגרו" (to the bot's chat),
 * "רענון" (reload) or "לטופס החדש" (the newer link, draft carried).
 */
import type { TranslationKey } from '@/lib/i18n/server';
import type { V3NoticeKind } from '@/lib/receive-v3';
import { BotCloseButton, RedirectBlock } from './StatusScreen';
import { P, font } from './tokens';
import type { Tr } from './texts';

const TEXT: Record<V3NoticeKind, { t: TranslationKey; b: TranslationKey; btn?: TranslationKey }> = {
  alreadySaved: { t: 'receive.v3.n.alreadySavedTitle', b: 'receive.v3.n.alreadySavedBody' },
  beingSaved: { t: 'receive.v3.n.beingSavedTitle', b: 'receive.v3.n.beingSavedBody', btn: 'receive.v3.n.refresh' },
  failed: { t: 'receive.v3.n.failedTitle', b: 'receive.v3.n.failedBody' },
  linkInvalid: { t: 'receive.v3.n.linkInvalidTitle', b: 'receive.v3.n.linkInvalidBody' },
  cancelled: { t: 'receive.v3.n.cancelledTitle', b: 'receive.v3.n.cancelledBody' },
  duplicate: { t: 'receive.v3.n.duplicateTitle', b: 'receive.v3.n.duplicateBody' },
  replaced: { t: 'receive.v3.n.replacedTitle', b: 'receive.v3.n.replacedBody', btn: 'receive.v3.n.openNewer' },
};

/** Notices that start the return to WhatsApp by themselves (8.4). */
export const AUTO_RETURN: ReadonlySet<V3NoticeKind> = new Set<V3NoticeKind>(['alreadySaved', 'cancelled', 'duplicate']);

export function NoticeScreen({
  kind,
  redirecting,
  redirectKey,
  rtl,
  tr,
  botHref = null,
  onClose,
  onRefresh,
  onOpenNewer,
}: {
  kind: V3NoticeKind;
  redirecting: boolean;
  redirectKey: number;
  rtl: boolean;
  tr: Tr;
  /** `https://wa.me/{n}` for "סגרו" (botChatHref), or null. */
  botHref?: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onOpenNewer: () => void;
}) {
  const x = TEXT[kind];
  const act = kind === 'beingSaved' ? onRefresh : kind === 'replaced' ? onOpenNewer : onClose;
  return (
    <div
      data-screen="notice"
      data-notice={kind}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        paddingTop: 28,
        paddingInline: 24,
        paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 12 }}>
        <h1 style={{ margin: 0, font: font(600, 24, 1.35), color: P.ink, textWrap: 'pretty' }}>{tr(x.t)}</h1>
        <p style={{ margin: 0, font: font(400, 17, 1.5), color: P.ink2, textWrap: 'pretty' }}>{tr(x.b)}</p>
        <div style={{ marginTop: 12 }}>{redirecting && <RedirectBlock redirectKey={redirectKey} rtl={rtl} tr={tr} />}</div>
      </div>
      {x.btn ? (
        <button
          type="button"
          onClick={act}
          style={{ height: 56, flex: 'none', border: 'none', borderRadius: 6, background: P.acc, color: P.accInk, font: font(600, 18) }}
        >
          {tr(x.btn)}
        </button>
      ) : (
        <BotCloseButton href={botHref} label={tr('receive.v3.closeLink')} onClose={onClose} />
      )}
    </div>
  );
}
