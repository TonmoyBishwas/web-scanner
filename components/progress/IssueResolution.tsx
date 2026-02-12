'use client';

import { useState } from 'react';
import type { OCRIssue, InvoiceItem } from '@/types';
import { ImageModal } from '@/components/shared/ImageModal';

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
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-yellow-400">
                    ⚠️ Issues Found ({issues.length - resolvedCount} remaining)
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
    const [selectedItem, setSelectedItem] = useState('');
    const [weight, setWeight] = useState(
        issue.inferred_weight?.toString() || issue.ocr_data?.weight_kg?.toString() || ''
    );
    const [expiry, setExpiry] = useState(issue.ocr_data?.expiry_date || '');
    const [resolved, setResolved] = useState(false);
    const [showImageModal, setShowImageModal] = useState(false);

    if (resolved) {
        return (
            <div className="bg-green-900/30 border border-green-600 rounded-lg p-3">
                <p className="text-green-400 text-sm">✅ Issue #{index + 1} resolved</p>
            </div>
        );
    }

    const needsName = issue.type === 'missing_name' || issue.type === 'missing_both';
    const needsWeight = issue.type === 'missing_weight' || issue.type === 'missing_both';

    return (
        <div className="bg-gray-800 border border-yellow-600/50 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2 text-sm text-yellow-400">
                <span>⚠️</span>
                <span>Issue #{index + 1}: {
                    issue.type === 'missing_name' ? 'Product name not readable' :
                        issue.type === 'missing_weight' ? 'Weight not readable' :
                            'Product name & weight not readable'
                }</span>
            </div>

            {/* Show captured image */}
            {issue.image_url && (
                <>
                    <div
                        className="rounded-lg overflow-hidden border border-gray-700 cursor-pointer hover:border-yellow-500 transition-colors"
                        onClick={() => setShowImageModal(true)}
                    >
                        <img
                            src={issue.image_url}
                            alt="Box sticker"
                            className="w-full h-32 object-cover"
                        />
                        <div className="text-center text-xs text-gray-400 py-1 bg-gray-900/50">
                            🔍 Click to enlarge
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
                    <label className="block text-xs text-gray-400 mb-1">Select Item Name *</label>
                    <select
                        value={selectedItem}
                        onChange={(e) => setSelectedItem(e.target.value)}
                        className="w-full p-2 bg-gray-900 border border-gray-700 rounded text-sm"
                    >
                        <option value="">-- Select item --</option>
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
                    <label className="block text-xs text-gray-400 mb-1">
                        Weight (kg) *
                        {issue.inferred_weight && (
                            <span className="text-blue-400 ml-1">
                                (Smart inference: {issue.inferred_weight.toFixed(2)} kg)
                            </span>
                        )}
                    </label>
                    <input
                        type="number"
                        step="0.001"
                        value={weight}
                        onChange={(e) => setWeight(e.target.value)}
                        className="w-full p-2 bg-gray-900 border border-gray-700 rounded text-sm"
                        placeholder="e.g., 10.150"
                    />
                </div>
            )}

            {/* Expiry (always optional) */}
            <div>
                <label className="block text-xs text-gray-400 mb-1">Expiry Date (optional)</label>
                <input
                    type="date"
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    className="w-full p-2 bg-gray-900 border border-gray-700 rounded text-sm"
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
                className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded text-sm font-medium transition-colors"
            >
                ✓ Resolve Issue
            </button>
        </div>
    );
}
