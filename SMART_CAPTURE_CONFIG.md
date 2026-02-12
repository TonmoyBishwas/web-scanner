# Smart Image Capture Configuration

**Feature Branch**: `feature/smart-image-capture`
**Implementation**: Option 5 - Hybrid Smart Delay + Quality Check

## 🎯 What This Does

Automatically captures high-quality photos for OCR by:
1. Waiting 800ms for camera to stabilize/focus after barcode detection
2. Capturing frame and checking sharpness (Laplacian variance)
3. Retrying up to 3 times if image is blurry
4. Using the sharpest image for OCR

## 📊 Configuration

Edit `components/scanner/SmartScanner.tsx`:

```typescript
const SMART_CAPTURE_CONFIG = {
  INITIAL_DELAY_MS: 800,           // Camera stabilization delay
  MAX_CAPTURE_ATTEMPTS: 3,         // Retry attempts if blurry
  RETRY_DELAY_MS: 500,             // Delay between retries
  MIN_SHARPNESS: 100,              // Minimum sharpness threshold
  ENABLE_QUALITY_CHECK: true,      // Toggle ON/OFF
} as const;
```

## 🔧 Adjusting Parameters

### Increase Delay (for slower cameras)
```typescript
INITIAL_DELAY_MS: 1200,  // Increase to 1200ms
```

### Decrease Attempts (for faster scanning)
```typescript
MAX_CAPTURE_ATTEMPTS: 2,  // Only try twice
```

### Lower Sharpness Threshold (more lenient)
```typescript
MIN_SHARPNESS: 75,  // Accept lower quality images
```

### Higher Sharpness Threshold (stricter)
```typescript
MIN_SHARPNESS: 150,  // Only accept very sharp images
```

## ⚡ Quick Disable

To disable smart capture and revert to instant capture:

```typescript
ENABLE_QUALITY_CHECK: false,  // Disables quality checking
INITIAL_DELAY_MS: 0,          // Removes delay
```

## 🔄 Rollback Options

### Option 1: Disable via Configuration (Fastest)
Set `ENABLE_QUALITY_CHECK: false` in the config.
Commit and push. **Takes effect immediately**.

### Option 2: Merge Back to Main (If Satisfied)
```bash
git checkout main
git merge feature/smart-image-capture
git push origin main
```

### Option 3: Full Rollback (Emergency)
```bash
# Go back to stable main branch
git checkout main

# Deploy stable version
git push origin main --force-with-lease
```

### Option 4: Cherry-pick Specific Commits
```bash
# If you want some changes but not all
git checkout main
git cherry-pick <commit-hash>  # Pick specific commits
```

## 🐛 Troubleshooting

### Images still blurry?
- Increase `INITIAL_DELAY_MS` to 1000-1500ms
- Increase `MIN_SHARPNESS` to 150+
- Check console logs for sharpness scores

### Scanning too slow?
- Decrease `INITIAL_DELAY_MS` to 500ms
- Decrease `MAX_CAPTURE_ATTEMPTS` to 2
- Lower `MIN_SHARPNESS` to 75

### Quality check too strict?
- Lower `MIN_SHARPNESS` to 75-80
- Reduce `MAX_CAPTURE_ATTEMPTS` to 2

### Want instant capture back?
```typescript
ENABLE_QUALITY_CHECK: false,
INITIAL_DELAY_MS: 0,
```

## 📈 Monitoring

Check browser console for quality metrics:
```
[SmartCapture] Attempt 1/3: Sharpness=127.45, Brightness=142.33, Quality=good
[SmartCapture] ✓ Quality acceptable (sharpness=127.45)
```

Low sharpness (<100) = blurry image → OCR errors likely
High sharpness (>150) = sharp image → OCR accurate

## 🎛️ Quality Thresholds

Defined in `lib/image-quality.ts`:

```typescript
export const QUALITY_THRESHOLDS = {
  SHARPNESS_EXCELLENT: 200,  // Very sharp
  SHARPNESS_GOOD: 100,       // Acceptable for OCR
  SHARPNESS_POOR: 50,        // Blurry

  BRIGHTNESS_TOO_DARK: 50,
  BRIGHTNESS_OPTIMAL_MIN: 80,
  BRIGHTNESS_OPTIMAL_MAX: 200,
  BRIGHTNESS_TOO_BRIGHT: 220,
} as const;
```

Adjust these if needed for your lighting conditions.

## 🔐 Safety Features

1. **Fallback**: If smart capture fails, immediately captures anyway
2. **Concurrent Protection**: Prevents multiple simultaneous captures
3. **Timeout Protection**: Max 3 attempts with delays = ~2.4 seconds max
4. **Configuration Toggle**: Can disable without code changes

## 📝 Git Branches

- **main**: Stable version (no smart capture)
- **feature/smart-image-capture**: New smart capture feature

To test:
```bash
git checkout feature/smart-image-capture
npm run dev
```

To rollback:
```bash
git checkout main
npm run dev
```

## ✅ Success Criteria

Smart capture is working well if:
- ✅ Console shows sharpness scores >100 consistently
- ✅ OCR weight extraction accuracy improves
- ✅ Fewer [Unmatched] items in final results
- ✅ User feedback shows "Image captured!" not "Hold steady..." repeatedly

If still seeing OCR errors after smart capture, weights might actually be different (real discrepancy, not OCR error).
