'use client';

import { useEffect, useRef, useState } from 'react';

interface NativeBarcodeScanner {
    onBarcodeDetected: (barcode: string) => void;
    onError?: (error: string) => void;
}

// Declare BarcodeDetector types (Chrome Android native API)
declare global {
    interface Window {
        BarcodeDetector: any;
    }
}

export function NativeBarcodeScanner({ onBarcodeDetected, onError }: NativeBarcodeScanner) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const animationFrameRef = useRef<number>(0);
    const lastScannedRef = useRef<string>('');
    const lastScanTimeRef = useRef<number>(0);

    const [isSupported, setIsSupported] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [error, setError] = useState<string>('');

    useEffect(() => {
        // Check if BarcodeDetector is supported
        if ('BarcodeDetector' in window) {
            setIsSupported(true);
            startScanning();
        } else {
            setIsSupported(false);
            setError('Native barcode scanner not supported on this browser');
            onError?.('BarcodeDetector API not supported');
        }

        return () => {
            stopScanning();
        };
    }, []);

    const startScanning = async () => {
        try {
            // Request camera access with optimal settings for barcode scanning
            const stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { exact: 'environment' },
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            });

            streamRef.current = stream;

            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                await videoRef.current.play();
                setIsScanning(true);
                scanContinuously();
            }
        } catch (err) {
            console.error('[NativeScanner] Camera access error:', err);
            const errMsg = err instanceof Error ? err.message : String(err);
            setError(`Camera error: ${errMsg}`);
            onError?.(errMsg);
        }
    };

    const scanContinuously = async () => {
        if (!videoRef.current || !canvasRef.current) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        if (!ctx) return;

        // Create BarcodeDetector instance
        const barcodeDetector = new window.BarcodeDetector({
            formats: [
                'code_128',
                'code_39',
                'ean_13',
                'ean_8',
                'upc_a',
                'upc_e',
                'qr_code',
                'data_matrix',
            ],
        });

        const detect = async () => {
            if (!video.readyState || video.readyState < 2) {
                animationFrameRef.current = requestAnimationFrame(detect);
                return;
            }

            // Set canvas size to match video
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;

            // Draw current video frame to canvas
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            try {
                // Use native barcode detection (hardware accelerated!)
                const barcodes = await barcodeDetector.detect(canvas);

                if (barcodes.length > 0) {
                    const barcode = barcodes[0].rawValue;
                    const now = Date.now();

                    // Debounce: same barcode within 2 seconds
                    if (barcode !== lastScannedRef.current || now - lastScanTimeRef.current > 2000) {
                        lastScannedRef.current = barcode;
                        lastScanTimeRef.current = now;

                        // Vibrate on detection
                        if ('vibrate' in navigator) {
                            navigator.vibrate(100);
                        }

                        onBarcodeDetected(barcode);
                    }
                }
            } catch (err) {
                console.error('[NativeScanner] Detection error:', err);
            }

            // Continue scanning at 60 FPS (native speed!)
            animationFrameRef.current = requestAnimationFrame(detect);
        };

        detect();
    };

    const stopScanning = () => {
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
        }

        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
            streamRef.current = null;
        }

        setIsScanning(false);
    };

    if (!isSupported) {
        return (
            <div className="flex items-center justify-center p-8 bg-red-900/20 border border-red-500 rounded-lg">
                <p className="text-red-300 text-sm">
                    Native barcode scanner not supported. Please use Chrome browser on Android.
                </p>
            </div>
        );
    }

    return (
        <div className="relative w-full aspect-square bg-black rounded-lg overflow-hidden">
            {/* Video feed */}
            <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-cover"
                playsInline
                muted
            />

            {/* Hidden canvas for barcode detection */}
            <canvas ref={canvasRef} className="hidden" />

            {/* Scanning indicator overlay */}
            <div className="absolute inset-0 pointer-events-none">
                {/* Target box */}
                <div className="absolute inset-0 flex items-center justify-center">
                    <div className="w-64 h-64 border-4 border-green-400 rounded-lg animate-pulse" />
                </div>

                {/* Status text */}
                <div className="absolute bottom-4 left-0 right-0 text-center">
                    <div className="inline-block bg-black/70 px-4 py-2 rounded-full">
                        <p className="text-white text-sm font-medium">
                            {isScanning ? '🎯 Scanning with hardware accelerator...' : 'Starting camera...'}
                        </p>
                    </div>
                </div>
            </div>

            {error && (
                <div className="absolute top-4 left-4 right-4 bg-red-600/90 text-white p-3 rounded-lg text-sm">
                    {error}
                </div>
            )}
        </div>
    );
}
