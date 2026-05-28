"use client";

/**
 * /preview — visual gallery of the redesign primitives.
 *
 * This route exists ONLY on the `ui-redesign` branch as a review gate before
 * the real pages get restyled. Open on a phone (Vercel preview URL) and
 * scroll. No real data, no API calls — all literals.
 *
 * Delete this file before merging `ui-redesign` → `pallet-flow`.
 */

import { useState } from "react";
import {
  Camera,
  Settings,
  Bug,
  Languages,
  Package,
  RotateCcw,
  Factory,
  GitMerge,
  Trash2,
  Pencil,
} from "lucide-react";

import {
  Button,
  Card,
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetWarning, setSheetWarning] = useState(false);
  const [flash, setFlash] = useState<"success" | "danger" | undefined>();

  function triggerFlash(kind: "success" | "danger") {
    setFlash(kind);
    setTimeout(() => setFlash(undefined), 250);
  }

  return (
    <main className="min-h-dvh bg-[var(--surface-0)] text-[var(--text-primary)] pb-24">
      {/* Header — anchors the page; reads like equipment branding */}
      <header
        className="sticky top-0 z-10 border-b border-[var(--border-default)] bg-[var(--surface-0)]/95 backdrop-blur-sm"
        style={{ paddingTop: "calc(0.75rem + env(safe-area-inset-top, 0px))" }}
      >
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex flex-col">
            <span className="micro-label">Web Scanner · ui-redesign</span>
            <h1 className="text-[20px] leading-[26px] font-semibold">
              Design system preview
            </h1>
          </div>
          <IconButton size="sm" tone="neutral" aria-label="Settings">
            <Settings size={18} />
          </IconButton>
        </div>
      </header>

      <div className="px-4 pt-5 space-y-8">
        {/* COLOR PALETTE */}
        <section>
          <SectionLabel>Color tokens</SectionLabel>
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

        {/* TYPOGRAPHY */}
        <section>
          <SectionLabel>Typography</SectionLabel>
          <Card className="space-y-3">
            <div>
              <span className="micro-label">Display · Geist Mono</span>
              <div className="counter-display text-[32px] leading-[38px]">
                17 <span className="text-[var(--text-tertiary)]">/</span>{" "}
                <span className="text-[var(--text-secondary)]">42</span>
              </div>
            </div>
            <div>
              <span className="micro-label">H1 · Geist Sans 700</span>
              <div className="text-[28px] leading-[32px] font-bold">
                Pallet 2 of 4
              </div>
            </div>
            <div>
              <span className="micro-label">H2 · Geist Sans 600</span>
              <div className="text-[20px] leading-[26px] font-semibold">
                Scanning loose boxes
              </div>
            </div>
            <div>
              <span className="micro-label">Body</span>
              <div className="text-[16px] leading-[22px]">
                The quick brown fox jumps over the lazy dog · אנטריקוט בקר
              </div>
            </div>
            <div>
              <span className="micro-label">Micro</span>
              <div className="micro-label">PRODUCTS</div>
            </div>
          </Card>
        </section>

        {/* COUNTER */}
        <section>
          <SectionLabel>Counter</SectionLabel>
          <Card className="flex items-end gap-6">
            <Counter current={17} target={42} label="Boxes" />
            <Counter current="8.4" target="12" label="Mix kg" accent="warning" />
            <Counter current={4} target={4} label="Done" accent="success" />
          </Card>
        </section>

        {/* PROGRESS BAR */}
        <section>
          <SectionLabel>Progress</SectionLabel>
          <Card className="space-y-4">
            <div>
              <p className="micro-label mb-2">Segmented · target=12</p>
              <ProgressBar current={5} target={12} />
            </div>
            <div>
              <p className="micro-label mb-2">Smooth · target=65 · warning</p>
              <ProgressBar current={48} target={65} tone="warning" />
            </div>
            <div>
              <p className="micro-label mb-2">Done · success</p>
              <ProgressBar current={42} target={42} tone="success" />
            </div>
          </Card>
        </section>

        {/* BUTTONS */}
        <section>
          <SectionLabel>Buttons</SectionLabel>
          <div className="space-y-3">
            <Button fullWidth>Confirm pallet</Button>
            <Button fullWidth variant="secondary">
              Rescan
            </Button>
            <Button fullWidth variant="danger" leadingIcon={<Trash2 size={18} />}>
              Delete this scan
            </Button>
            <div className="flex gap-3">
              <Button variant="primary" size="md" leadingIcon={<Camera size={18} />}>
                Capture anyway
              </Button>
              <Button variant="ghost" size="md" leadingIcon={<Pencil size={16} />}>
                Edit
              </Button>
            </div>
            <Button fullWidth loading>
              Submitting…
            </Button>
            <Button fullWidth disabled>
              Disabled
            </Button>
          </div>
        </section>

        {/* STATUS BADGES */}
        <section>
          <SectionLabel>Status</SectionLabel>
          <Card className="flex flex-wrap gap-2">
            <StatusBadge tone="success">Scanned</StatusBadge>
            <StatusBadge tone="pending">Reading…</StatusBadge>
            <StatusBadge tone="warning">Needs review</StatusBadge>
            <StatusBadge tone="danger">Duplicate</StatusBadge>
            <StatusBadge tone="neutral" icon={null}>
              MIX
            </StatusBadge>
            <StatusBadge tone="neutral" icon={null}>
              LOOSE
            </StatusBadge>
          </Card>
        </section>

        {/* ICON BUTTONS */}
        <section>
          <SectionLabel>Icon buttons</SectionLabel>
          <Card className="flex flex-wrap gap-3">
            <IconButton aria-label="Camera"><Camera size={20} /></IconButton>
            <IconButton aria-label="Switch language"><Languages size={20} /></IconButton>
            <IconButton aria-label="Debug"><Bug size={20} /></IconButton>
            <IconButton aria-label="Settings"><Settings size={20} /></IconButton>
            <IconButton aria-label="Merge" tone="accent"><GitMerge size={20} /></IconButton>
            <IconButton aria-label="Cancel" tone="danger"><Trash2 size={20} /></IconButton>
            <IconButton aria-label="Back" size="lg"><RotateCcw size={22} /></IconButton>
          </Card>
        </section>

        {/* LIST */}
        <section>
          <SectionLabel trailing="3">Scanned boxes · ListRow</SectionLabel>
          <Card flush>
            <ListRow
              leading={
                <div className="size-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center">
                  <Package size={20} className="text-[var(--text-secondary)]" />
                </div>
              }
              label="פילה בקר נקייה"
              sublabel="SKU 7290015234567 · 8.42 kg"
              trailing={<StatusBadge tone="success">OK</StatusBadge>}
              onClick={() => {}}
            />
            <ListRow
              leading={
                <div className="size-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center">
                  <Package size={20} className="text-[var(--text-secondary)]" />
                </div>
              }
              label="אנטריקוט"
              sublabel="SKU 7290019876543 · 7.18 kg"
              trailing={<StatusBadge tone="pending">…</StatusBadge>}
              onClick={() => {}}
            />
            <ListRow
              tone="warning"
              leading={
                <div className="size-10 rounded-md bg-[var(--surface-3)] flex items-center justify-center">
                  <Package size={20} className="text-[var(--warning)]" />
                </div>
              }
              label="(unreadable label)"
              sublabel="MANUAL-1748341... · weight missing"
              trailing={
                <StatusBadge tone="warning">Review</StatusBadge>
              }
              onClick={() => {}}
            />
          </Card>
        </section>

        {/* SCANNER OVERLAY DEMO */}
        <section>
          <SectionLabel>Scanner overlay</SectionLabel>
          <Card flush className="overflow-hidden">
            <div className="relative aspect-[3/4] bg-gradient-to-b from-[#080808] to-[#1a1a1c]">
              {/* Fake camera "feed" — diagonal stripes so the chrome is visible */}
              <div
                className="absolute inset-0 opacity-20"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(45deg, #333 0 6px, transparent 6px 12px)",
                }}
              />
              <ScannerOverlay
                armed
                tone="accent"
                flash={flash}
                hint="Aim at the barcode label"
                topActions={
                  <>
                    <IconButton size="sm" aria-label="Switch camera">
                      <RotateCcw size={18} />
                    </IconButton>
                    <IconButton size="sm" aria-label="Settings">
                      <Settings size={18} />
                    </IconButton>
                  </>
                }
                bottomActions={
                  <Button
                    variant="primary"
                    size="md"
                    leadingIcon={<Camera size={18} />}
                    onClick={() => triggerFlash("success")}
                  >
                    Capture anyway
                  </Button>
                }
              />
            </div>
            <div className="flex gap-2 p-3">
              <Button variant="secondary" size="sm" onClick={() => triggerFlash("danger")}>
                Trigger danger flash
              </Button>
              <Button variant="ghost" size="sm" onClick={() => triggerFlash("success")}>
                Success flash
              </Button>
            </div>
          </Card>
        </section>

        {/* BOTTOM SHEET TRIGGERS */}
        <section>
          <SectionLabel>Bottom sheet</SectionLabel>
          <div className="space-y-3">
            <Button fullWidth variant="primary" onClick={() => setSheetOpen(true)}>
              Open detail sheet
            </Button>
            <Button
              fullWidth
              variant="secondary"
              onClick={() => setSheetWarning(true)}
              leadingIcon={<Factory size={18} />}
            >
              Open warning-mode sheet (loose phase)
            </Button>
          </div>
        </section>
      </div>

      {/* Demo sheet — accent */}
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Issue this box?"
        accent="accent"
        footer={
          <div className="flex gap-3">
            <Button
              variant="secondary"
              fullWidth
              onClick={() => setSheetOpen(false)}
            >
              Cancel
            </Button>
            <Button fullWidth onClick={() => setSheetOpen(false)}>
              Confirm
            </Button>
          </div>
        }
      >
        <dl className="space-y-3">
          <DetailRow label="Item" value="פילה בקר נקייה" />
          <DetailRow label="SKU" value="7290015234567" mono />
          <DetailRow label="Weight" value="8.42 kg" />
          <DetailRow label="Expiry" value="2026-08-14" mono />
          <DetailRow label="Pallet" value="LPN-20260520-DOC1234-P2" mono />
        </dl>
      </BottomSheet>

      {/* Demo sheet — warning mode */}
      <BottomSheet
        open={sheetWarning}
        onClose={() => setSheetWarning(false)}
        title="Loose boxes phase"
        accent="warning"
        footer={
          <Button
            fullWidth
            onClick={() => setSheetWarning(false)}
            leadingIcon={<Camera size={18} />}
          >
            Start scanning loose
          </Button>
        }
      >
        <p className="text-[var(--text-secondary)] leading-relaxed">
          You have <span className="text-[var(--warning)] font-semibold">8 loose boxes</span>{" "}
          declared. Each one will be scanned individually — different items and
          weights are expected.
        </p>
      </BottomSheet>
    </main>
  );
}

function Swatch({ name, value }: { name: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--border-default)] overflow-hidden">
      <div className="h-12" style={{ background: value }} />
      <div className="px-2 py-1.5 bg-[var(--surface-1)]">
        <p className="text-[11px] font-mono text-[var(--text-secondary)]">{name}</p>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[var(--border-default)] pb-2 last:border-b-0 last:pb-0">
      <dt className="micro-label">{label}</dt>
      <dd
        className={[
          "text-[16px] text-[var(--text-primary)] truncate",
          mono ? "font-mono text-[14px]" : "",
        ].join(" ")}
        dir="ltr"
      >
        {value}
      </dd>
    </div>
  );
}
