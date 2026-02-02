import { create } from 'zustand';
import type { ParsedBarcode, ScanStoreState, ScannedItem } from '@/types';

export const useScanStore = create<ScanStoreState>((set, get) => ({
  scannedBarcodes: new Map<string, ParsedBarcode>(),
  scannedItems: [],
  isScanning: false,
  error: null,

  addScan: (barcode: string, data: ParsedBarcode, matchedItem: ScannedItem) => {
    set((state) => {
      const newScannedBarcodes = new Map(state.scannedBarcodes);
      newScannedBarcodes.set(barcode, data);

      // Update or add the scanned item
      const existingIndex = state.scannedItems.findIndex(
        (item) => item.item_index === matchedItem.item_index
      );

      let newScannedItems: ScannedItem[];
      if (existingIndex >= 0) {
        newScannedItems = [...state.scannedItems];
        newScannedItems[existingIndex] = matchedItem;
      } else {
        newScannedItems = [...state.scannedItems, matchedItem];
      }

      return {
        scannedBarcodes: newScannedBarcodes,
        scannedItems: newScannedItems,
        error: null
      };
    });
  },

  isDuplicate: (barcode: string) => {
    return get().scannedBarcodes.has(barcode);
  },

  setScanning: (scanning: boolean) => {
    set({ isScanning: scanning });
  },

  setError: (error: string | null) => {
    set({ error });
  },

  clear: () => {
    set({
      scannedBarcodes: new Map(),
      scannedItems: [],
      isScanning: false,
      error: null
    });
  }
}));
