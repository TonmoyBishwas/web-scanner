"use client";

/**
 * /preview — visual gallery of the redesign for the ui-redesign branch only.
 *
 * Direction (v2 after user pivot 2026-05-28):
 *  - Light theme. Worker reads Hebrew, not English.
 *  - Minimal: scanner screen = camera + counter + ONE confirm button.
 *  - The scanned-list lives behind a floating chip; tap to open a BottomSheet.
 *  - Icons reinforce; text is small, Hebrew, optional.
 *
 * Delete this file before merging `ui-redesign` → `pallet-flow`.
 */

import { useState } from "react";
import {
  Camera,
  Package,
  Settings,
  X,
  Check,
  AlertTriangle,
  ChevronLeft,
  List,
} from "lucide-react";

import {
  Button,
  Card,
  Chip,
  Counter,
  ProgressBar,
  StatusBadge,
  SectionLabel,
  ListRow,
  IconButton,
  BottomSheet,
  ScannerOverlay,
} from "@/components/ui";

export default function PreviewPage() {
  const [listOpen, setListOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [flash, setFlash] = useState<"success" | "danger" | undefined>();

  function triggerFlash(kind: "success" | "danger") {
    setFlash(kind);
    setTimeout(() => setFlash(undefined), 250);
  }

  return (
    // Force RTL on the preview so the user sees the real Hebrew layout.
    <main
      dir="rtl"
      lang="he"
      className="min-h-dvh bg-[var(--surface-0)] text-[var(--text-primary)] pb-24"
    >
      {/* ----- Hero scanner screen (the main one) ----- */}
      <section className="px-4 pt-6 space-y-5">
        <header className="flex items-center justify-between">
          <IconButton size="sm" aria-label="חזרה">
            <ChevronLeft size={20} />
          </IconButton>
          <IconButton size="sm" aria-label="הגדרות">
            <Settings size={20} />
          </IconButton>
        </header>

        {/* The single focus: pallet 2/4, boxes 17/42 */}
        <div className="flex flex-col items-center pt-2 gap-3">
          <Counter
            size="display"
            current={2}
            target={4}
            label="משטח"
            icon={<Package size={16} />}
          />
          <Counter size="hero" current={17} target={42} />
          <div className="w-full max-w-[260px]">
            <ProgressBar current={17} target={42} />
          </div>
        </div>

        {/* Camera card */}
        <Card flush className="overflow-hidden">
          <div className="relative aspect-[4/5] bg-gradient-to-b from-[#1a1a1c] to-[#0a0a0a]">
            {/* Fake camera "feed" */}
            <div
              className="absolute inset-0 opacity-25"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(45deg, #444 0 6px, transparent 6px 12px)",
              }}
            />
            <ScannerOverlay
              armed
              tone="success"
              flash={flash}
              topActions={
                <>
                  <span />
                  <Chip
                    variant="floating"
                    leadingIcon={<List size={14} />}
                    onClick={() => setListOpen(true)}
                  >
                    17
                  </Chip>
                </>
              }
              bottomActions={
                <IconButton
                  tone="neutral"
                  size="lg"
                  aria-label="צילום ידני"
                  onClick={() => triggerFlash("success")}
                  className="!bg-white/95 backdrop-blur-sm"
                >
                  <Camera size={22} />
                </IconButton>
              }
            />
          </div>
        </Card>

        {/* The single primary action */}
        <Button
          fullWidth
          leadingIcon={<Check size={20} strokeWidth={2.5} />}
          onClick={() => setConfirmOpen(true)}
        >
          סיים משטח
        </Button>

        <p className="text-center text-[12px] text-[var(--text-tertiary)] pt-1">
          /preview · ui-redesign v2
        </p>
      </section>

      {/* ----- The reference gallery (scrolls below the hero) ----- */}
      <div className="px-4 pt-10 space-y-7">
        {/* Color tokens */}
        <section>
          <SectionLabel>צבעים</SectionLabel>
          <div className="grid grid-cols-4 gap-2">
            <Swatch name="surface-0" value="var(--surface-0)" />
            <Swatch name="surface-1" value="var(--surface-1)" />
            <Swatch name="surface-2" value="var(--surface-2)" />
            <Swatch name="surface-3" value="var(--surface-3)" />
            <Swatch name="accent" value="var(--accent)" />
            <Swatch name="success" value="var(--success)" />
            <Swatch name="warning" value="var(--warning)" />
            <Swatch name="danger" value="var(--danger)" />
          </div>
        </section>

        {/* Counters */}
        <section>
          <SectionLabel>מונה</SectionLabel>
          <Card className="flex justify-around items-end gap-4">
            <Counter
              current={17}
              target={42}
              size="hero"
              label="ארגזים"
              icon={<Package size={14} />}
            />
          </Card>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Card className="flex items-center justify-center">
              <Counter current={2} target={4} size="display" label="משטח" />
            </Card>
            <Card className="flex items-center justify-center">
              <Counter
                current={42}
                target={42}
                size="display"
                tone="success"
                label="סיים"
              />
            </Card>
            <Card className="flex items-center justify-center">
              <Counter current={8} target={12} size="display" label="ארגזים שונים" />
            </Card>
          </div>
        </section>

        {/* Buttons */}
        <section>
          <SectionLabel>כפתורים</SectionLabel>
          <div className="space-y-3">
            <Button fullWidth leadingIcon={<Check size={18} strokeWidth={2.5} />}>
              סיים משטח
            </Button>
            <Button fullWidth variant="secondary">
              ביטול
            </Button>
            <Button
              fullWidth
              variant="success"
              leadingIcon={<Check size={18} strokeWidth={2.5} />}
            >
              אישור
            </Button>
            <Button
              fullWidth
              variant="danger"
              leadingIcon={<X size={18} strokeWidth={2.5} />}
            >
              מחק סריקה
            </Button>
          </div>
        </section>

        {/* Progress */}
        <section>
          <SectionLabel>התקדמות</SectionLabel>
          <Card className="space-y-4">
            <div>
              <ProgressBar current={5} target={12} />
              <p className="hebrew-label mt-1.5">5 / 12 — segmented</p>
            </div>
            <div>
              <ProgressBar current={48} target={65} />
              <p className="hebrew-label mt-1.5">48 / 65 — smooth (target &gt; 30)</p>
            </div>
            <div>
              <ProgressBar current={42} target={42} />
              <p className="hebrew-label mt-1.5">42 / 42 — done auto-greens</p>
            </div>
          </Card>
        </section>

        {/* Status pills */}
        <section>
          <SectionLabel>מצבים</SectionLabel>
          <Card className="flex flex-wrap gap-2">
            <StatusBadge tone="success">תקין</StatusBadge>
            <StatusBadge tone="pending">בעיבוד</StatusBadge>
            <StatusBadge tone="warning">בדוק</StatusBadge>
            <StatusBadge tone="danger">כפול</StatusBadge>
            <StatusBadge tone="neutral" icon={null}>
              מיקס
            </StatusBadge>
            <StatusBadge tone="neutral" icon={null}>
              ארגזים פזורים
            </StatusBadge>
          </Card>
        </section>

        {/* Chips */}
        <section>
          <SectionLabel>צ&apos;יפים</SectionLabel>
          <Card className="flex flex-wrap gap-2">
            <Chip leadingIcon={<List size={14} />}>17 סריקות</Chip>
            <Chip variant="subtle">8 / 12</Chip>
            <Chip variant="floating" tone="success">
              42 תקין
            </Chip>
            <Chip variant="default" tone="warning">
              1 לבדיקה
            </Chip>
          </Card>
        </section>

        {/* List */}
        <section>
          <SectionLabel trailing="3">סריקות אחרונות</SectionLabel>
          <Card flush>
            <ListRow
              leading={
                <div className="size-10 rounded-xl bg-[var(--surface-2)] flex items-center justify-center">
                  <Package size={18} className="text-[var(--text-secondary)]" />
                </div>
              }
              label="פילה בקר נקייה"
              sublabel="8.42 ק״ג"
              trailing={<StatusBadge tone="success" icon={<Check size={14} />} />}
              onClick={() => {}}
            />
            <ListRow
              leading={
                <div className="size-10 rounded-xl bg-[var(--surface-2)] flex items-center justify-center">
                  <Package size={18} className="text-[var(--text-secondary)]" />
                </div>
              }
              label="אנטריקוט"
              sublabel="7.18 ק״ג"
              trailing={<StatusBadge tone="pending" />}
              onClick={() => {}}
            />
            <ListRow
              tone="warning"
              leading={
                <div className="size-10 rounded-xl bg-[var(--warning-soft)] flex items-center justify-center">
                  <AlertTriangle size={18} className="text-[var(--warning)]" />
                </div>
              }
              label="—"
              sublabel="ברקוד לא נקרא"
              trailing={<StatusBadge tone="warning" />}
              onClick={() => {}}
            />
          </Card>
        </section>

        {/* Bottom-sheet triggers */}
        <section>
          <SectionLabel>חלון מידע</SectionLabel>
          <div className="space-y-3">
            <Button fullWidth variant="secondary" onClick={() => setListOpen(true)}>
              פתח רשימת סריקות
            </Button>
            <Button fullWidth variant="secondary" onClick={() => setConfirmOpen(true)}>
              פתח אישור משטח
            </Button>
          </div>
        </section>

        <p className="text-center text-[12px] text-[var(--text-tertiary)] py-4">
          web-scanner · ui-redesign · v2 light minimal
        </p>
      </div>

      {/* ----- Bottom sheets ----- */}
      <BottomSheet
        open={listOpen}
        onClose={() => setListOpen(false)}
        title="17 סריקות"
        footer={
          <Button fullWidth variant="secondary" onClick={() => setListOpen(false)}>
            סגור
          </Button>
        }
      >
        <div className="-mx-5">
          <ListRow
            leading={<Counter current={1} size="inline" />}
            label="פילה בקר נקייה"
            sublabel="8.42 ק״ג"
            trailing={<StatusBadge tone="success" icon={<Check size={14} />} />}
          />
          <ListRow
            leading={<Counter current={2} size="inline" />}
            label="פילה בקר נקייה"
            sublabel="8.31 ק״ג"
            trailing={<StatusBadge tone="success" icon={<Check size={14} />} />}
          />
          <ListRow
            leading={<Counter current={3} size="inline" />}
            label="אנטריקוט"
            sublabel="7.20 ק״ג"
            trailing={<StatusBadge tone="pending" />}
          />
          <ListRow
            tone="warning"
            leading={<Counter current={4} size="inline" />}
            label="—"
            sublabel="ברקוד לא נקרא"
            trailing={<StatusBadge tone="warning" />}
          />
        </div>
      </BottomSheet>

      <BottomSheet
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="לסיים משטח 2?"
        footer={
          <div className="flex gap-3">
            <Button
              variant="secondary"
              fullWidth
              onClick={() => setConfirmOpen(false)}
            >
              לא
            </Button>
            <Button
              fullWidth
              leadingIcon={<Check size={18} strokeWidth={2.5} />}
              onClick={() => setConfirmOpen(false)}
            >
              כן
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center gap-3 py-3">
          <Counter
            current={17}
            target={42}
            size="hero"
            label="ארגזים"
            icon={<Package size={14} />}
          />
          <ProgressBar current={17} target={42} className="max-w-[240px]" />
          <p className="text-[var(--text-secondary)] text-center text-[14px] pt-2">
            יישלח אישור, סטיקר LPN יודפס.
          </p>
        </div>
      </BottomSheet>
    </main>
  );
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border-default)] overflow-hidden bg-[var(--surface-1)]">
      <div className="h-12" style={{ background: value }} />
      <div className="px-2 py-1.5">
        <p className="text-[11px] font-mono text-[var(--text-secondary)] truncate" dir="ltr">
          {name}
        </p>
      </div>
    </div>
  );
}
