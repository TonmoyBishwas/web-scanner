'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle, Check, Search } from 'lucide-react';
import type { OCRIssue, InvoiceItem } from '@/types';
import { ImageModal } from '@/components/shared/ImageModal';
import { useT } from '@/lib/i18n';

interface IssueResolutionProps {
    issues: OCRIssue[];
    invoiceItems: InvoiceItem[];
    onResolve: (barcode: string, resolved: {
        item_name?: string;
        weight?: number;
        expiry?: string;
    }) => void;
    onAllResolved: () => void;
}

export function IssueResolution({
    issues,
    invoiceItems,
    onResolve,
    onAllResolved
}: IssueResolutionProps) {
    const tr = useT();
    const [resolvedCount, setResolvedCount] = useState(0);

    if (issues.length === 0) {
        return null;
    }

    const handleResolve = (barcode: string, data: {
        item_name?: string;
        weight?: number;
        expiry?: string;
    }) => {
        onResolve(barcode, data);
        const newCount = resolvedCount + 1;
        setResolvedCount(newCount);
        if (newCount >= issues.length) {
            onAllResolved();
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-warn" />
                <h3 className="text-lg font-extrabold text-warn-weak-ink">
                    {tr('components.issueResolution.foundTitle', { count: issues.length - resolvedCount })}
                </h3>
            </div>

            {issues.map((issue, idx) => (
                <IssueCard
                    key={issue.barcode}
                    issue={issue}
                    index={idx}
                    invoiceItems={invoiceItems}
                    onResolve={handleResolve}
                />
            ))}
        </div>
    );
}

interface IssueCardProps {
    issue: OCRIssue;
    index: number;
    invoiceItems: InvoiceItem[];
    onResolve: (barcode: string, data: {
        item_name?: string;
        weight?: number;
        expiry?: string;
    }) => void;
}

function IssueCard({ issue, index, invoiceItems, onResolve }: IssueCardProps) {
    const tr = useT();
    const [selectedItem, setSelectedItem] = useState('');
    const [weight, setWeight] = useState(
        issue.inferred_weight?.toString() || issue.ocr_data?.weight_kg?.toString() || ''
    );
    const [expiry, setExpiry] = useState(issue.ocr_data?.expiry_date || '');
    const [resolved, setResolved] = useState(false);
    const [showImageModal, setShowImageModal] = useState(false);

    if (resolved) {
        return (
            <div className="bg-ok-weak border border-ok/30 rounded-[14px] p-3 flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-ok" />
                <p className="text-ok-weak-ink text-sm">{tr('components.issueResolution.resolvedNote', { n: index + 1 })}</p>
            </div>
        );
    }

    const needsName = issue.type === 'missing_name' || issue.type === 'missing_both';
    const needsWeight = issue.type === 'missing_weight' || issue.type === 'missing_both';

    return (
        <div className="bg-raised border border-warn/40 rounded-[14px] p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-warn-weak-ink">
                <AlertTriangle className="w-4 h-4" />
                <span>{tr('components.issueResolution.issuePrefix', {
                    n: index + 1,
                    desc:
                        issue.type === 'missing_name' ? tr('components.issueResolution.descNameMissing') :
                        issue.type === 'missing_weight' ? tr('components.issueResolution.descWeightMissing') :
                            tr('components.issueResolution.descBothMissing'),
                })}</span>
            </div>

            {/* Show captured image */}
            {issue.image_url && (
                <>
                    <div
                        className="rounded-lg overflow-hidden border border-line cursor-pointer hover:border-warn transition-colors"
                        onClick={() => setShowImageModal(true)}
                    >
                        <img
                            src={issue.image_url}
                            alt="Box sticker"
                            className="w-full h-32 object-cover"
                        />
                        <div className="flex items-center justify-center gap-1 text-xs text-ink-muted py-1 bg-sunken">
                            <Search className="w-3 h-3" />
                            {tr('components.issueResolution.clickToEnlarge')}
                        </div>
                    </div>
                    {showImageModal && (
                        <ImageModal
                            imageUrl={issue.image_url}
                            onClose={() => setShowImageModal(false)}
                        />
                    )}
                </>
            )}

            {/* Item name selector (when name is missing) */}
            {needsName && (
                <div>
                    <label className="block text-xs text-ink-muted mb-1">{tr('components.issueResolution.selectItemLabel')}</label>
                    <select
                        value={selectedItem}
                        onChange={(e) => setSelectedItem(e.target.value)}
                        className="w-full p-2.5 bg-sunken border border-line-strong rounded-[10px] text-sm text-ink focus:border-brand outline-none"
                    >
                        <option value="">{tr('components.issueResolution.selectItemEmpty')}</option>
                        {invoiceItems.map((item) => (
                            <option key={item.item_index} value={item.item_name_hebrew}>
                                {item.item_name_english} ({item.item_name_hebrew})
                            </option>
                        ))}
                    </select>
                </div>
            )}

            {/* Weight input (when weight is missing or needs confirmation) */}
            {needsWeight && (
                <div>
                    <label className="block text-xs text-ink-muted mb-1">
                        {tr('components.issueResolution.weightLabel')}
                        {issue.inferred_weight && (
                            <span className="text-brand-weak-ink ms-1">
                                {tr('components.issueResolution.smartInference', { weight: issue.inferred_weight.toFixed(2) })}
                            </span>
                        )}
                    </label>
                    <input
                        type="number"
                        step="0.001"
                        inputMode="decimal"
                        dir="ltr"
                        value={weight}
                        onChange={(e) => setWeight(e.target.value)}
                        className="w-full p-2.5 bg-sunken border border-line-strong rounded-[10px] text-sm font-mono text-ink focus:border-brand outline-none"
                        placeholder={tr('components.issueResolution.weightPlaceholder')}
                    />
                </div>
            )}

            {/* Expiry (always optional) */}
            <div>
                <label className="block text-xs text-ink-muted mb-1">{tr('components.issueResolution.expiryLabel')}</label>
                <input
                    type="date"
                    dir="ltr"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    style={{ colorScheme: 'dark' }}
                    className="w-full p-2.5 bg-sunken border border-line-strong rounded-[10px] text-sm font-mono text-ink focus:border-brand outline-none"
                />
            </div>

            {/* Resolve button */}
            <button
                onClick={() => {
                    if (needsName && !selectedItem) return;
                    if (needsWeight && !weight) return;

                    setResolved(true);
                    onResolve(issue.barcode, {
                        item_name: needsName ? selectedItem : issue.ocr_data?.product_name || undefined,
                        weight: weight ? parseFloat(weight) : undefined,
                        expiry: expiry || undefined,
                    });
                }}
                disabled={(needsName && !selectedItem) || (needsWeight && !weight)}
                className="w-full h-12 bg-brand hover:bg-brand-hover active:bg-brand-active text-ink-inverse disabled:bg-line-strong disabled:text-ink-muted disabled:cursor-not-allowed rounded-xl text-sm font-extrabold transition-colors flex items-center justify-center gap-2"
            >
                <Check className="w-4 h-4" />
                {tr('components.issueResolution.resolveBtn')}
            </button>
        </div>
    );
}
