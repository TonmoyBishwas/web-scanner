/**
 * Image Quality Detection Utilities
 *
 * Provides functions to assess image sharpness and quality
 * to ensure OCR gets clear photos for accurate text extraction.
 */

/**
 * Calculate image sharpness using Laplacian variance
 * Higher values = sharper image
 *
 * Algorithm:
 * 1. Convert image to grayscale
 * 2. Apply Laplacian operator (edge detection)
 * 3. Calculate variance of the result
 * 4. Higher variance = more edges = sharper image
 *
 * @param canvas - Canvas element with the image
 * @returns Sharpness score (0-1000+, higher is better)
 */
export function calculateSharpness(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const width = canvas.width;
  const height = canvas.height;

  // Get image data
  const imageData = ctx.getImageData(0, 0, width, height);
  const pixels = imageData.data;

  // Convert to grayscale and apply Laplacian operator
  const gray: number[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    // Grayscale using luminosity method
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    gray.push(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // Apply Laplacian kernel (simplified for performance)
  // Kernel: [0, 1, 0]
  //         [1,-4, 1]
  //         [0, 1, 0]
  const laplacian: number[] = [];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      const value =
        -4 * gray[idx] +
        gray[idx - 1] +       // left
        gray[idx + 1] +       // right
        gray[idx - width] +   // top
        gray[idx + width];    // bottom
      laplacian.push(Math.abs(value));
    }
  }

  // Calculate variance
  const mean = laplacian.reduce((sum, val) => sum + val, 0) / laplacian.length;
  const variance = laplacian.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / laplacian.length;

  return variance;
}

/**
 * Calculate image brightness (average luminosity)
 * Returns value between 0 (black) and 255 (white)
 *
 * @param canvas - Canvas element with the image
 * @returns Average brightness (0-255)
 */
export function calculateBrightness(canvas: HTMLCanvasElement): number {
  const ctx = canvas.getContext('2d');
  if (!ctx) return 0;

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;

  let totalBrightness = 0;
  let pixelCount = 0;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    // Use luminosity formula
    const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
    totalBrightness += brightness;
    pixelCount++;
  }

  return totalBrightness / pixelCount;
}

/**
 * Quality thresholds for image assessment
 */
export const QUALITY_THRESHOLDS = {
  // Sharpness (Laplacian variance)
  SHARPNESS_EXCELLENT: 200,  // Very sharp, ideal for OCR
  SHARPNESS_GOOD: 100,       // Acceptable for OCR
  SHARPNESS_POOR: 50,        // Blurry, may cause OCR errors

  // Brightness (0-255)
  BRIGHTNESS_TOO_DARK: 50,   // Too dark, increase exposure
  BRIGHTNESS_OPTIMAL_MIN: 80, // Good lighting
  BRIGHTNESS_OPTIMAL_MAX: 200, // Good lighting
  BRIGHTNESS_TOO_BRIGHT: 220, // Overexposed
} as const;

/**
 * Assess overall image quality for OCR
 *
 * @param canvas - Canvas element with the image
 * @returns Quality assessment with score and feedback
 */
export interface QualityAssessment {
  sharpness: number;
  brightness: number;
  isSharp: boolean;
  isWellLit: boolean;
  overallQuality: 'excellent' | 'good' | 'poor' | 'very-poor';
  feedback: string;
}

export function assessImageQuality(canvas: HTMLCanvasElement): QualityAssessment {
  const sharpness = calculateSharpness(canvas);
  const brightness = calculateBrightness(canvas);

  const isSharp = sharpness >= QUALITY_THRESHOLDS.SHARPNESS_GOOD;
  const isWellLit =
    brightness >= QUALITY_THRESHOLDS.BRIGHTNESS_OPTIMAL_MIN &&
    brightness <= QUALITY_THRESHOLDS.BRIGHTNESS_OPTIMAL_MAX;

  let overallQuality: QualityAssessment['overallQuality'];
  let feedback: string;

  if (sharpness >= QUALITY_THRESHOLDS.SHARPNESS_EXCELLENT && isWellLit) {
    overallQuality = 'excellent';
    feedback = 'Image quality excellent';
  } else if (isSharp && isWellLit) {
    overallQuality = 'good';
    feedback = 'Image quality good';
  } else if (sharpness >= QUALITY_THRESHOLDS.SHARPNESS_POOR) {
    overallQuality = 'poor';
    if (!isSharp) feedback = 'Image blurry - hold steady';
    else if (brightness < QUALITY_THRESHOLDS.BRIGHTNESS_TOO_DARK) feedback = 'Too dark - improve lighting';
    else if (brightness > QUALITY_THRESHOLDS.BRIGHTNESS_TOO_BRIGHT) feedback = 'Too bright - reduce glare';
    else feedback = 'Image quality poor';
  } else {
    overallQuality = 'very-poor';
    feedback = 'Image very blurry - hold camera steady';
  }

  return {
    sharpness,
    brightness,
    isSharp,
    isWellLit,
    overallQuality,
    feedback,
  };
}
