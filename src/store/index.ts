import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ScanHistoryItem } from '../types'; // Import ScanHistoryItem
import { ConvertedItem } from '../types/api'; // Import ConvertedItem

// Product type definition
/*
export interface Product {
  id: string;
  name: string;
  description?: string;
  price: number;
  sku?: string;
  barcode?: string;
  stockQuantity?: number;
  isActive: boolean;
  category?: string;
  images: string[];
  lastScanned?: Date;
  createdAt: string;
  updatedAt: string;
}
*/

// Category type definition
export interface Category {
  id: string;
  name: string;
  description?: string;
  color: string;
  icon?: string;
  isActive: boolean;
  parentCategory?: string;
  createdAt: string;
  updatedAt: string;
}

// Main application state
interface AppState {
  // Products state
  products: ConvertedItem[];
  selectedProduct: ConvertedItem | null;
  isProductsLoading: boolean;
  productError: string | null;
  
  // Categories state
  categories: Category[];
  selectedCategory: Category | null;
  isCategoriesLoading: boolean;
  categoryError: string | null;
  
  // Search state
  searchQuery: string;
  sortBy: 'name' | 'price' | 'date' | 'category';
  sortOrder: 'asc' | 'desc';
  
  // Scan History state
  scanHistory: ScanHistoryItem[];
  
  // Auto-search settings
  autoSearchOnEnter: boolean;
  autoSearchOnTab: boolean;
  itemSaveTriggeredAt: number | null;
  
  // Square Connection State
  isSquareConnected: boolean;
  
  // Actions
  setProducts: (products: ConvertedItem[]) => void;
  setSelectedProduct: (product: ConvertedItem | null) => void;
  setProductsLoading: (isLoading: boolean) => void;
  setProductError: (error: string | null) => void;
  
  setCategories: (categories: Category[]) => void;
  setSelectedCategory: (category: Category | null) => void;
  setCategoriesLoading: (isLoading: boolean) => void;
  setCategoryError: (error: string | null) => void;
  
  setSearchQuery: (query: string) => void;
  setSortBy: (sortBy: 'name' | 'price' | 'date' | 'category') => void;
  setSortOrder: (sortOrder: 'asc' | 'desc') => void;
  
  // Scan History actions
  addScanHistoryItem: (item: ScanHistoryItem) => void;
  clearScanHistory: () => void;
  
  // Auto-search toggles
  toggleAutoSearchOnEnter: () => void;
  toggleAutoSearchOnTab: () => void;
  triggerItemSave: () => void;
  
  // Square Connection Action
  setSquareConnected: (isConnected: boolean) => void;
  
  refreshProducts: () => Promise<void>;
  loadMoreProducts: () => Promise<void>;
}

// Create store using zustand with persistence for scanHistory
export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Initial products state
      products: [],
      selectedProduct: null,
      isProductsLoading: false,
      productError: null,
      
      // Initial categories state
      categories: [],
      selectedCategory: null,
      isCategoriesLoading: false,
      categoryError: null,
      
      // Initial search/sort state
      searchQuery: '',
      sortBy: 'name',
      sortOrder: 'asc',
      
      // Initial scan history state
      scanHistory: [],
      
      // Auto-search defaults and toggles
      autoSearchOnEnter: true,
      autoSearchOnTab: false,
      itemSaveTriggeredAt: null,

      // Initial Square Connection state
      isSquareConnected: false,
      
      // Products actions
      setProducts: (products: ConvertedItem[]) => set({ products }),
      setSelectedProduct: (selectedProduct: ConvertedItem | null) => set({ selectedProduct }),
      setProductsLoading: (isProductsLoading: boolean) => set({ isProductsLoading }),
      setProductError: (productError: string | null) => set({ productError }),
      
      // Categories actions
      setCategories: (categories: Category[]) => set({ categories }),
      setSelectedCategory: (selectedCategory: Category | null) => set({ selectedCategory }),
      setCategoriesLoading: (isCategoriesLoading: boolean) => set({ isCategoriesLoading }),
      setCategoryError: (categoryError: string | null) => set({ categoryError }),
      
      // Search/sort actions
      setSearchQuery: (searchQuery: string) => set({ searchQuery }),
      setSortBy: (sortBy: 'name' | 'price' | 'date' | 'category') => set({ sortBy }),
      setSortOrder: (sortOrder: 'asc' | 'desc') => set({ sortOrder }),
      
      // Scan History actions
      addScanHistoryItem: (item: ScanHistoryItem) => {
        set((state) => {
          // Prevent duplicates based on scanId, keep latest
          const existingIndex = state.scanHistory.findIndex(histItem => histItem.id === item.id); // Check by item ID
          let newHistory = [...state.scanHistory];
          if (existingIndex > -1) {
            // Remove the old entry if it exists
            newHistory.splice(existingIndex, 1);
          }
          // Add the new item to the beginning and limit history size (e.g., 100 items)
          newHistory = [item, ...newHistory].slice(0, 100); 
          return { scanHistory: newHistory };
        });
      },
      clearScanHistory: () => set({ scanHistory: [] }),
      
      // Auto-search toggles
      toggleAutoSearchOnEnter: () => set((state) => ({ autoSearchOnEnter: !state.autoSearchOnEnter })),
      toggleAutoSearchOnTab: () => set((state) => ({ autoSearchOnTab: !state.autoSearchOnTab })),
      triggerItemSave: () => set({ itemSaveTriggeredAt: Date.now() }),
      
      // Square Connection action implementation
      setSquareConnected: (isSquareConnected: boolean) => set({ isSquareConnected }),

      // Add placeholders for missing actions
      refreshProducts: async () => { console.warn('refreshProducts not implemented in store'); },
      loadMoreProducts: async () => { console.warn('loadMoreProducts not implemented in store'); },
      
      // ... rest of the store implementation ...
    }),
    {
      name: 'app-storage', // AsyncStorage key
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist a subset of the state
      partialize: (state) =>
        Object.fromEntries(
          Object.entries(state).filter(([key]) =>
            ['scanHistory', 'autoSearchOnEnter', 'autoSearchOnTab'].includes(key)
          )
        ),
    }
  )
);
