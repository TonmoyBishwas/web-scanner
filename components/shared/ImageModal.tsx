'use client';

interface ImageModalProps {
    imageUrl: string;
    altText?: string;
    onClose: () => void;
}

export function ImageModal({ imageUrl, altText = 'Full size image', onClose }: ImageModalProps) {
    if (!imageUrl) return null;

    return (
        <div
            className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div className="relative max-w-full max-h-full flex items-center justify-center">
                {/* Close button */}
                <button
                    onClick={onClose}
                    className="absolute -top-12 right-0 md:-right-12 text-white/80 hover:text-white p-2 rounded-full hover:bg-white/10 transition-colors"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>

                <img
                    src={imageUrl}
                    alt={altText}
                    className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
                    onClick={(e) => e.stopPropagation()} // Prevent close on image click
                />
            </div>
        </div>
    );
}
