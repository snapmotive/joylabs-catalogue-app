import React, { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';
import {
  View,
  FlatList,
  // StyleSheet, // Will be replaced by indexStyles
  SafeAreaView,
  StatusBar,
  Text,
  Pressable,
  ActivityIndicator,
  TextInput,
  // Button, // No longer explicitly needed
  Platform, // For KeyboardAvoidingView if we re-add it, but SearchBar handles its input.
  KeyboardAvoidingView, // Keep for filter pills for now, may remove if SearchBar covers all
  ScrollView,

  Animated, // For swipe action
  Alert, // Added for print feedback
  Vibration, // Added for haptic feedback
  Image, // Added for item thumbnails
} from 'react-native';
import { useRouter, useFocusEffect, Link, useNavigation } from 'expo-router';
import { useIsFocused, useNavigationState } from '@react-navigation/native';
import { Swipeable } from 'react-native-gesture-handler'; // Added for swipe actions
import ConnectionStatusBar from '../../../src/components/ConnectionStatusBar';
import NotificationBell from '../../../src/components/NotificationBell'; // Added for notifications access
import { ConvertedItem, SearchResultItem } from '../../../src/types/api';
import { Ionicons } from '@expo/vector-icons';
import { useApi } from '../../../src/providers/ApiProvider';
import { useAppStore } from '../../../src/store';
import { apiClientInstance } from '../../../src/api';
import logger from '../../../src/utils/logger';
// DatabaseProvider import removed - already provided by app/_layout.tsx
import { transformCatalogItemToItem } from '../../../src/utils/catalogTransformers';
import { v4 as uuidv4 } from 'uuid';
import { lightTheme } from '../../../src/themes';
import * as modernDb from '../../../src/database/modernDb';
import { useCatalogItems } from '../../../src/hooks/useCatalogItems';
import { styles } from '../../../src/styles/_indexStyles'; // Updated import
import { SearchFilters } from '../../../src/database/modernDb'; // For search filters type
import { printItemLabel, LabelData } from '../../../src/utils/printLabel'; // Added for printing
import SystemModal from '../../../src/components/SystemModal'; // Added for notifications
import { reorderService, TeamData } from '../../../src/services/reorderService'; // Added for reorder functionality
import { generateClient } from 'aws-amplify/api';
import * as queries from '../../../src/graphql/queries';
import { useAuthenticator } from '@aws-amplify/ui-react-native';
import CachedImage from '../../../src/components/CachedImage';
import { imageCacheService } from '../../../src/services/imageCacheService';
import ImageManagementModal from '../../../src/components/ImageManagementModal';
import { squareImageService } from '../../../src/services/squareImageService';

const client = generateClient();

// Debounce utility
const debounce = <F extends (...args: any[]) => any>(func: F, waitFor: number) => {
  let timeout: NodeJS.Timeout | null = null;
  
  const debounced = (...args: Parameters<F>) => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    timeout = setTimeout(() => func(...args), waitFor);
  };

  debounced.cancel = () => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  };
  
  return debounced as ((...args: Parameters<F>) => void) & { cancel: () => void };
};

// --- START: SearchResultsArea Component Definition ---
interface SearchResultsAreaProps {
  searchTopic: string;
  onPrintSuccessForChaining: () => void;
  onCreateNewItem: (params: { name?: string; sku?: string; barcode?: string }) => void;
  isAwaitingPostSaveSearch: boolean;
  onSearchComplete: () => void;
  onClearSearch: () => void;
}

const SearchResultsArea = memo(({
  searchTopic,
  onPrintSuccessForChaining,
  onCreateNewItem,
  isAwaitingPostSaveSearch,
  onSearchComplete,
  onClearSearch
}: SearchResultsAreaProps) => {
  const router = useRouter(); 
  const swipeableRefs = useRef<Record<string, Swipeable | null>>({});
  
  // Get authenticated user information
  const { user } = useAuthenticator((context) => [context.user]);

  // Audio/Haptic feedback for reorder actions
  const playSuccessSound = useCallback(() => {
    console.log('🔊 SUCCESS - Item added to reorder!');
    logger.info('SearchResultsArea', 'Playing success feedback for reorder');
    // Single short vibration for success
    Vibration.vibrate(100);
  }, []);

  const { lastUpdatedItem, setLastUpdatedItem } = useAppStore();

  const [showPrintNotification, setShowPrintNotification] = useState(false);
  const [printNotificationMessage, setPrintNotificationMessage] = useState('');
  const [printNotificationType, setPrintNotificationType] = useState<'success' | 'error'>('success');

  // Reorder notification state
  const [showReorderNotification, setShowReorderNotification] = useState(false);
  const [reorderNotificationMessage, setReorderNotificationMessage] = useState('');
  const [reorderNotificationType, setReorderNotificationType] = useState<'success' | 'error'>('success');
  const [reorderNotificationItemId, setReorderNotificationItemId] = useState<string | null>(null);

  // Image management modal state
  const [isImageManagementVisible, setIsImageManagementVisible] = useState(false);
  const [selectedItemForImageManagement, setSelectedItemForImageManagement] = useState<SearchResultItem | null>(null);

  // Handle opening image management modal directly
  const handleImageLongPress = useCallback((item: SearchResultItem) => {
    setSelectedItemForImageManagement(item);
    setIsImageManagementVisible(true);
  }, []);

  // Handle closing image management modal
  const handleCloseImageManagement = useCallback(() => {
    setIsImageManagementVisible(false);
    setSelectedItemForImageManagement(null);
  }, []);

  // Image management handlers
  // Image management handlers are defined after executeSearch to avoid dependency issues

  const [searchResults, setSearchResults] = useState<SearchResultItem[]>([]);
  const [allSearchResults, setAllSearchResults] = useState<SearchResultItem[]>([]); // Keep original results
  const [isSearchPending, setIsSearchPending] = useState(false);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({
    name: true,
    sku: true,
    barcode: true,
    category: false
  });
  const [sortOrder, setSortOrder] = useState<'default' | 'az' | 'za' | 'price_asc' | 'price_desc'>('default');
  const [selectedResultCategoryId, setSelectedResultCategoryId] = useState<string | null>(null);
  const [availableResultCategories, setAvailableResultCategories] = useState<Array<{ id: string; name: string; count: number }>>([]);

  const { performSearch, isSearching: catalogIsSearching, searchError: catalogSearchError } = useCatalogItems();
  
  // Get categories from store for manual category lookup if needed
  const categories = useAppStore((state) => state.categories);
  
  // Helper function to fetch team data for an item (now uses reorder service for caching)
  const fetchTeamData = useCallback(async (itemId: string): Promise<TeamData | undefined> => {
    return await reorderService.fetchTeamData(itemId);
  }, []);

  // Helper function to ensure proper category conversion
  const ensureCategoryName = useCallback(async (item: SearchResultItem): Promise<string | undefined> => {
    // First try the already converted category from search results
    if (item.category) {
      return item.category;
    }
    
    // If no category name, try to look it up using categoryId or reporting_category_id from database
    const categoryId = item.categoryId || item.reporting_category_id;
    if (categoryId) {
      try {
        const categoriesFromDb = await modernDb.getAllCategories();
        const foundCategory = categoriesFromDb.find(cat => cat.id === categoryId);
        return foundCategory?.name;
      } catch (error) {
        logger.error('SearchResultsArea:ensureCategoryName', 'Error fetching categories from DB', { error, categoryId });
      }
    }
    
    return undefined;
  }, []);
  
  const itemModalJustClosed = useAppStore((state) => state.itemModalJustClosed);
  
  // Extracted search logic into a useCallback
  const executeSearch = useCallback(async () => {
    if (searchTopic.trim() === '') {
      setSearchResults([]);
      setAllSearchResults([]);
      setIsSearchPending(false); // Clear pending state for empty search
      return;
    }

    // Set pending state immediately and clear old results to prevent flash
    setIsSearchPending(true);
    setSearchResults([]); // Clear old results immediately
    setAllSearchResults([]); // Clear all results immediately

    logger.info('SearchResultsArea', 'Executing search for topic:', { topic: searchTopic });
    const rawResults = await performSearch(searchTopic, searchFilters);

    let processedResults = [...rawResults];

    // Store ALL results (no category filtering here - this is for data storage)
    setAllSearchResults(processedResults);
    setIsSearchPending(false); // Clear pending state when search completes
    onSearchComplete(); // Notify parent that search is done

    // Preload images for better performance
    processedResults.forEach(item => {
      if (item.images && item.images.length > 0 && item.images[0].url) {
        imageCacheService.preloadImage(item.images[0].url);
      }
    });

    // logger.info('SearchResultsArea', 'Search executed, results set.', { count: processedResults.length });
  }, [searchTopic, searchFilters, performSearch, setSearchResults, onSearchComplete]);

  // useEffect to run search when query/filters change (but NOT sort or category filter)
  useEffect(() => {
    executeSearch();
  }, [executeSearch]); // Depends on the memoized executeSearch

  // Separate effect for VIEW-ONLY filtering and sorting (lightning fast)
  useEffect(() => {
    if (allSearchResults.length === 0) {
      setSearchResults([]);
      return;
    }

    let viewResults = [...allSearchResults];

    // Apply category filter for VIEW only (not destructive)
    if (selectedResultCategoryId) {
      const selectedCategory = availableResultCategories.find(c => c.id === selectedResultCategoryId);
      if (selectedCategory) {
        viewResults = viewResults.filter(item => {
          const itemCategory = item.category || 'Uncategorized';
          return itemCategory === selectedCategory.name;
        });
      }
    }

    // Apply sorting
    switch (sortOrder) {
      case 'az':
        viewResults.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      case 'za':
        viewResults.sort((a, b) => (b.name || '').localeCompare(a.name || ''));
        break;
      case 'price_asc':
        viewResults.sort((a, b) => (a.price || 0) - (b.price || 0));
        break;
      case 'price_desc':
        viewResults.sort((a, b) => (b.price || 0) - (a.price || 0));
        break;
      default:
        // Keep default order
        break;
    }

    setSearchResults(viewResults);
  }, [allSearchResults, selectedResultCategoryId, sortOrder, availableResultCategories]);

  // Effect to update/refresh search results if a relevant item was globally updated or created
  useEffect(() => {
    if (lastUpdatedItem) {
      logger.info('SearchResultsArea', 'lastUpdatedItem detected, queueing re-search.', { itemId: lastUpdatedItem.id });
      // Add a small delay to give the database time to process the update
      // before we re-query. This helps prevent race conditions on save.
      const refreshTimer = setTimeout(() => {
        logger.info('SearchResultsArea', 'Executing delayed search refresh.');
        executeSearch(); 
        setLastUpdatedItem(null); 
      }, 300); // 300ms delay

      return () => clearTimeout(refreshTimer);
    }
  }, [lastUpdatedItem, setLastUpdatedItem, executeSearch]);

  // Use refs to access current search results without causing re-renders
  const searchResultsRef = useRef(searchResults);
  const allSearchResultsRef = useRef(allSearchResults);

  // Update refs when search results change
  useEffect(() => {
    searchResultsRef.current = searchResults;
    allSearchResultsRef.current = allSearchResults;
  }, [searchResults, allSearchResults]);

  // Debounced refresh to prevent race conditions and multiple simultaneous refreshes
  const debouncedRefresh = useRef<NodeJS.Timeout | null>(null);

  const triggerDebouncedRefresh = useCallback((reason: string, delay: number = 500) => {
    // Clear any existing timeout
    if (debouncedRefresh.current) {
      clearTimeout(debouncedRefresh.current);
    }

    // Set new timeout
    debouncedRefresh.current = setTimeout(() => {
      logger.info('SearchResultsArea', `Executing debounced refresh: ${reason}`);
      executeSearch();
      debouncedRefresh.current = null;
    }, delay);
  }, [executeSearch]);

  // Image management handlers - completion signals come from modal callback
  const handleImageUpload = useCallback(async (imageUri: string, imageName: string): Promise<void> => {
    if (!selectedItemForImageManagement) {
      throw new Error('No item selected for image management');
    }

    // COMPLETELY DISABLE all database change notifications during image operation
    const { dataChangeNotifier } = await import('../../../src/services/dataChangeNotifier');
    dataChangeNotifier.disable();
    logger.info('SearchResultsArea', 'Disabled database change notifications for image upload');

    try {
      const result = await squareImageService.uploadImage(imageUri, imageName, selectedItemForImageManagement.id);
      if (!result.success) {
        throw new Error(result.error || 'Failed to upload image');
      }

      logger.info('SearchResultsArea', 'Image upload completed successfully, waiting for modal completion signal');

    } catch (error) {
      // Re-enable notifications on error
      dataChangeNotifier.enable();
      logger.info('SearchResultsArea', 'Re-enabled database change notifications due to error');
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to upload image: ${errorMessage}`);
    }
  }, [selectedItemForImageManagement]);

  const handleImageDelete = useCallback(async (imageId: string): Promise<void> => {
    if (!selectedItemForImageManagement) return;

    try {
      const result = await squareImageService.deleteImage(imageId, selectedItemForImageManagement.id);
      if (!result.success) {
        throw new Error(result.error || 'Failed to delete image');
      }

      // No immediate completion signal - modal will handle this via callback
      logger.info('SearchResultsArea', 'Image delete completed successfully, waiting for modal completion signal');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to delete image: ${errorMessage}`);
    }
  }, [selectedItemForImageManagement]);

  const handleImageMakePrimary = useCallback(async (imageId: string): Promise<void> => {
    if (!selectedItemForImageManagement) return;

    try {
      const currentImages = [...(selectedItemForImageManagement.images || [])];
      const imageIndex = currentImages.findIndex(img => img.id === imageId);

      if (imageIndex === -1) {
        throw new Error('Image not found in current images');
      }

      if (imageIndex === 0) {
        return; // Already primary
      }

      // Reorder images to make selected image primary
      const [selectedImage] = currentImages.splice(imageIndex, 1);
      const reorderedImages = [selectedImage, ...currentImages];
      const imageIds = reorderedImages.map(img => img.id);

      logger.info('SearchResultsArea', 'Making image primary - reordering images', {
        selectedImageId: imageId,
        currentOrder: currentImages.map(img => img.id),
        newOrder: imageIds,
        primaryImageId: imageIds[0]
      });

      const result = await squareImageService.reorderImages(selectedItemForImageManagement.id, imageIds);
      if (!result.success) {
        throw new Error(result.error || 'Failed to reorder images');
      }

      // No immediate completion signal - modal will handle this via callback
      logger.info('SearchResultsArea', 'Image reorder completed successfully, waiting for modal completion signal');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to make image primary: ${errorMessage}`);
    }
  }, [selectedItemForImageManagement]);

  // Handle completion signal from image management modal
  const handleImageOperationComplete = useCallback(async () => {
    logger.info('SearchResultsArea', 'Received completion signal from image management modal, re-enabling notifications and refreshing');

    // Re-enable database change notifications
    const { dataChangeNotifier } = await import('../../../src/services/dataChangeNotifier');
    dataChangeNotifier.enable();
    logger.info('SearchResultsArea', 'Re-enabled database change notifications');

    // DO NOT clear store cache as it causes app remounting
    logger.info('SearchResultsArea', 'Skipping cache clear to prevent app remount - search will fetch fresh data');

    // Execute search immediately, then update selectedItemForImageManagement
    logger.info('SearchResultsArea', 'About to execute search refresh after image upload');
    executeSearch().then(() => {
      // CRITICAL FIX: Update selectedItemForImageManagement AFTER search completes
      // This ensures it happens after any app remounting
      setTimeout(async () => {
        logger.info('SearchResultsArea', 'Post-search: Checking selectedItemForImageManagement for update', {
          hasSelectedItem: !!selectedItemForImageManagement,
          selectedItemId: selectedItemForImageManagement?.id,
          selectedItemImageCount: selectedItemForImageManagement?.images?.length || 0
        });

        if (selectedItemForImageManagement) {
          logger.info('SearchResultsArea', 'Post-search: About to call getProductById', {
            itemId: selectedItemForImageManagement.id
          });

          const updatedItem = await getProductById(selectedItemForImageManagement.id);

          logger.info('SearchResultsArea', 'Post-search: getProductById result', {
            itemId: selectedItemForImageManagement.id,
            hasUpdatedItem: !!updatedItem,
            updatedItemImageCount: updatedItem?.images?.length || 0,
            updatedItemImageIds: updatedItem?.images?.map((img: any) => img.id) || []
          });

          if (updatedItem) {
            logger.info('SearchResultsArea', 'Post-search: Updating selectedItemForImageManagement with fresh data', {
              itemId: selectedItemForImageManagement.id,
              oldImageCount: selectedItemForImageManagement.images?.length || 0,
              newImageCount: updatedItem.images?.length || 0
            });

            // Update the selected item with fresh data so modal gets updated images
            setSelectedItemForImageManagement(updatedItem as SearchResultItem);
          } else {
            logger.error('SearchResultsArea', 'Post-search: getProductById returned null!', {
              itemId: selectedItemForImageManagement.id
            });
          }
        } else {
          logger.error('SearchResultsArea', 'Post-search: selectedItemForImageManagement is null!');
        }
      }, 500); // Longer delay to ensure remount is complete
    });
  }, [executeSearch, selectedItemForImageManagement]);

  // Real-time data change monitoring with proper debouncing and race condition prevention
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    // Only set up listener if we have an active search
    if (searchTopic.trim() === '') {
      return;
    }

    // Set up event-driven data change monitoring
    import('../../../src/services/dataChangeNotifier').then(({ dataChangeNotifier }) => {
      unsubscribe = dataChangeNotifier.addListener(async (event) => {
        // Handle different types of data changes with proper debouncing
        if (searchTopic.trim() === '') return; // No search active, ignore changes

        // Handle bulk sync completion - immediate refresh needed
        if (event.table === 'catalog_items' && event.itemId === 'BULK_SYNC_COMPLETE') {
          logger.info('SearchResultsArea', 'Bulk sync completed, triggering immediate refresh', {
            syncType: event.data?.syncType,
            itemCount: event.data?.itemCount
          });
          triggerDebouncedRefresh('bulk-sync-complete', 1000); // Longer delay for bulk operations
          return;
        }

        // Check if this change affects items in current search results
        let affectedItemId = event.itemId;
        if (event.table === 'images' && event.data?.itemId) {
          affectedItemId = event.data.itemId; // For images, the actual item ID is in data
        }

        const isItemInCurrentResults = searchResultsRef.current.some(item => item.id === affectedItemId) ||
                                      allSearchResultsRef.current.some(item => item.id === affectedItemId);

        if (isItemInCurrentResults) {
          logger.info('SearchResultsArea', `${event.table} ${event.operation} detected for item in results`, {
            table: event.table,
            operation: event.operation,
            itemId: event.itemId,
            affectedItemId
          });

          // Use debounced refresh for all operations
          triggerDebouncedRefresh(`${event.table}-${event.operation}`, 300);
        } else {
          logger.debug('SearchResultsArea', `${event.table} ${event.operation} detected but item not in current results - ignoring`, {
            table: event.table,
            operation: event.operation,
            itemId: event.itemId,
            affectedItemId
          });
        }
      });

      logger.debug('SearchResultsArea', 'Event-driven data change monitoring set up');
    }).catch((error) => {
      logger.warn('SearchResultsArea', 'Failed to set up data change monitoring', { error });
    });

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
      // Clean up any pending debounced refresh
      if (debouncedRefresh.current) {
        clearTimeout(debouncedRefresh.current);
        debouncedRefresh.current = null;
      }
    };
  }, [executeSearch, searchTopic, triggerDebouncedRefresh]);



  // Generate dynamic category filter data from ALL search results (not filtered view)
  useEffect(() => {
    if (allSearchResults.length === 0) {
      setAvailableResultCategories([]);
      return;
    }

    const categoryMap = new Map<string, { id: string; count: number }>();



    allSearchResults.forEach(item => {
      let categoryName = item.category || 'Uncategorized';
      let categoryId = item.categoryId || item.reporting_category_id || 'uncategorized';

      if (categoryMap.has(categoryName)) {
        categoryMap.get(categoryName)!.count++;
      } else {
        categoryMap.set(categoryName, { id: categoryId, count: 1 });
      }
    });

    const categories = Array.from(categoryMap.entries())
      .map(([name, data]) => ({ id: data.id, name, count: data.count }))
      .sort((a, b) => b.count - a.count); // Sort by count descending


    setAvailableResultCategories(categories);
  }, [allSearchResults]);

  const toggleFilter = useCallback((toggledFilter: keyof Omit<SearchFilters, 'category'>) => {
    setSearchFilters(currentFilters => {
      const relevantFilters = { name: currentFilters.name, sku: currentFilters.sku, barcode: currentFilters.barcode };
      let countActive = 0;
      let isToggledFilterActive = false;
      for (const key in relevantFilters) {
        if (relevantFilters[key as keyof typeof relevantFilters]) {
          countActive++;
          if (key === toggledFilter) {
            isToggledFilterActive = true;
          }
        }
      }
      const isCurrentlyTheOnlyActiveFilter = isToggledFilterActive && countActive === 1;
      if (isCurrentlyTheOnlyActiveFilter) {
        return { ...currentFilters, name: true, sku: true, barcode: true };
      } else {
        const newFiltersState: SearchFilters = { ...currentFilters, name: false, sku: false, barcode: false };
        newFiltersState[toggledFilter] = true;
        return newFiltersState;
      }
    });
  }, [setSearchFilters]);

  const handleSelectResultCategory = useCallback((categoryId: string | null) => {
      setSelectedResultCategoryId(categoryId);
      // Note: When categoryId is null (All Categories), we just remove the filter view
      // We do NOT clear the search - that's handled separately by the clear button
  }, [setSelectedResultCategoryId]);

  // Listen for search topic changes to reset category filter when search is cleared
  useEffect(() => {
    if (searchTopic.trim() === '') {
      setSelectedResultCategoryId(null); // Reset category filter when search is cleared
    }
  }, [searchTopic]);

  const handleResultItemPress = useCallback((item: SearchResultItem) => {
    // logger.info('SearchResultsArea', 'Search result selected', { itemId: item.id, name: item.name });
    router.push(`/item/${item.id}`);
  }, [router]);

  const handleSwipePrint = useCallback(async (item: SearchResultItem) => {
    logger.info('SearchResultsArea:handleSwipePrint', 'Print triggered for item', { itemId: item.id, name: item.name });
    const labelData: LabelData = {
      itemId: item.id,
      itemName: item.name || 'Item Name',
      price: item.price,
      sku: item.sku,
      barcode: item.barcode,
    };

    let printWasSuccessful = false;
    try {
      const success = await printItemLabel(labelData);
      if (success) {
        setPrintNotificationMessage(`Label for "${item.name || 'Item'}" sent to printer.`);
        setPrintNotificationType('success');
        printWasSuccessful = true;
      } else {
        setPrintNotificationMessage('Could not send label to printer. Check connection.');
        setPrintNotificationType('error');
      }
    } catch (error) {
      logger.error('SearchResultsArea:handleSwipePrint', 'Error printing label', { error });
      setPrintNotificationMessage('An unexpected error occurred during printing.');
      setPrintNotificationType('error');
    } finally {
      setShowPrintNotification(true); 
      setTimeout(() => setShowPrintNotification(false), 3000);
      swipeableRefs.current[item.id]?.close(); // Close swipeable row
      if (printWasSuccessful) {
        onPrintSuccessForChaining(); // Call the callback on successful print
      }
    }
  }, [printItemLabel, swipeableRefs, setPrintNotificationMessage, setPrintNotificationType, setShowPrintNotification, onPrintSuccessForChaining]);

  const handleSwipeReorder = useCallback(async (item: SearchResultItem) => {
    // IMMEDIATE FEEDBACK - No delays, no awaits, just instant response
    setReorderNotificationMessage(`"${item.name || 'Item'}" added to reorder list.`);
    setReorderNotificationType('success');
    setReorderNotificationItemId(item.id);
    setShowReorderNotification(true);
    playSuccessSound();
    swipeableRefs.current[item.id]?.close();
    
    logger.info('SearchResultsArea:handleSwipeReorder', 'Reorder triggered for item', { itemId: item.id, name: item.name });
    
    // Now do all the async work in the background
    // Ensure we have the proper category name
    const categoryName = await ensureCategoryName(item);
    
    // Debug logging for category data
    logger.info('SearchResultsArea:handleSwipeReorder', 'Category data debug', {
      itemId: item.id,
      originalCategory: item.category,
      categoryId: item.categoryId,
      reportingCategoryId: item.reporting_category_id,
      ensuredCategoryName: categoryName,
      categoriesCount: categories?.length || 0
    });
    
    // SearchResultItem now contains a complete ConvertedItem from getProductById
    // Just update the category name to ensure it's current
    const convertedItem: ConvertedItem = {
      ...item, // Use the complete ConvertedItem data from getProductById
      category: categoryName, // Override with ensured category name
    };

    try {
      // Fetch team data for the item
      const teamData = await fetchTeamData(item.id);
      const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
      const success = await reorderService.addItem(convertedItem, 1, teamData, userName);
      if (!success) {
        // Only update notification if there was an error
        setReorderNotificationMessage('Failed to add item to reorder list.');
        setReorderNotificationType('error');
      }
    } catch (error) {
      logger.error('SearchResultsArea:handleSwipeReorder', 'Error adding item to reorder list', { error });
      setReorderNotificationMessage('An unexpected error occurred while adding to reorder list.');
      setReorderNotificationType('error');
    }
    
    // Hide notification after delay
      setTimeout(() => {
        setShowReorderNotification(false);
        setReorderNotificationItemId(null);
      }, 3000);
  }, [reorderService, swipeableRefs, setReorderNotificationMessage, setReorderNotificationType, setShowReorderNotification, setReorderNotificationItemId, ensureCategoryName, fetchTeamData, user, playSuccessSound]);

  const handleFullSwipeReorder = useCallback(async (item: SearchResultItem) => {
    // IMMEDIATE FEEDBACK - No delays, no awaits, just instant response
    setReorderNotificationMessage(`"${item.name || 'Item'}" added to reorder list.`);
    setReorderNotificationType('success');
    setReorderNotificationItemId(item.id);
    setShowReorderNotification(true);
    playSuccessSound();
    
    logger.info('SearchResultsArea:handleFullSwipeReorder', 'Full swipe reorder triggered for item', { itemId: item.id, name: item.name });
    
    // Now do all the async work in the background
    // Ensure we have the proper category name
    const categoryName = await ensureCategoryName(item);
    
    // SearchResultItem now contains a complete ConvertedItem from getProductById
    // Just update the category name to ensure it's current
    const convertedItem: ConvertedItem = {
      ...item, // Use the complete ConvertedItem data from getProductById
      category: categoryName, // Override with ensured category name
    };

    try {
      // Fetch team data for the item
      const teamData = await fetchTeamData(item.id);
      const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
      const success = await reorderService.addItem(convertedItem, 1, teamData, userName);
      if (!success) {
        // Only update notification if there was an error
        setReorderNotificationMessage('Failed to add item to reorder list.');
        setReorderNotificationType('error');
      }
    } catch (error) {
      logger.error('SearchResultsArea:handleFullSwipeReorder', 'Error adding item to reorder list', { error });
      setReorderNotificationMessage('An unexpected error occurred while adding to reorder list.');
      setReorderNotificationType('error');
    }
    
    // Hide notification after delay
      setTimeout(() => {
        setShowReorderNotification(false);
        setReorderNotificationItemId(null);
      }, 2000); // Shorter timeout for full swipe
  }, [reorderService, setReorderNotificationMessage, setReorderNotificationType, setShowReorderNotification, setReorderNotificationItemId, ensureCategoryName, fetchTeamData, user, playSuccessSound]);

  const renderLeftActions = useCallback((progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>, item: SearchResultItem) => {
    const SWIPE_BUTTON_WIDTH = 100; 
    // const LIST_HORIZONTAL_PADDING = 16; // No longer needed here

    const trans = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [-SWIPE_BUTTON_WIDTH, 0], 
      extrapolate: 'clamp',
    });

    return (
      <Pressable 
        onPress={() => { 
          handleSwipePrint(item);
        }}
        // Apply width directly, margin hacks removed.
        style={[styles.swipePrintActionLeft, { width: SWIPE_BUTTON_WIDTH }]} 
      >
        <Animated.View style={[
          styles.swipePrintButtonContainer, 
          { width: SWIPE_BUTTON_WIDTH, transform: [{ translateX: trans }] }
        ]}>
            <Ionicons name="print-outline" size={24} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.swipePrintActionText}>Print</Text>
        </Animated.View>
      </Pressable>
    );
  }, [handleSwipePrint, styles]);

  const renderRightActions = useCallback((progress: Animated.AnimatedInterpolation<number>, dragX: Animated.AnimatedInterpolation<number>, item: SearchResultItem) => {
    const SWIPE_BUTTON_WIDTH = 100; // Reduced width since no icon

    const trans = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [SWIPE_BUTTON_WIDTH, 0],
      extrapolate: 'clamp',
    });

    return (
      <Pressable 
        onPress={() => { 
          handleSwipeReorder(item);
        }}
        style={[styles.swipeReorderActionRight, { width: SWIPE_BUTTON_WIDTH }]} 
      >
        <Animated.View style={[
          styles.swipeReorderButtonContainer, 
          { width: SWIPE_BUTTON_WIDTH, transform: [{ translateX: trans }] }
        ]}>
            <Text style={styles.swipeReorderActionText}>Reorder</Text>
        </Animated.View>
      </Pressable>
    );
  }, [handleSwipeReorder, styles]);

  const renderSearchResultItem = useCallback(({ item, index }: { item: SearchResultItem; index: number }) => {
    const formattedPrice = typeof item.price === 'number' 
      ? `$${item.price.toFixed(2)}` 
      : (item.price ? String(item.price) : 'N/A');
    return (
      <Swipeable
        ref={(ref) => { swipeableRefs.current[item.id] = ref; }}
        renderLeftActions={(progress, dragX) => renderLeftActions(progress, dragX, item)} 
        renderRightActions={(progress, dragX) => renderRightActions(progress, dragX, item)}
        onSwipeableWillOpen={() => {
          Object.values(swipeableRefs.current).forEach(ref => {
            if (ref && ref !== swipeableRefs.current[item.id]) {
              ref.close();
            }
          });
        }}
        onSwipeableRightOpen={() => {
          // Full swipe to the left (revealing right actions) - auto add to reorder
          handleFullSwipeReorder(item);
          // Close the swipeable immediately for instant feedback
            swipeableRefs.current[item.id]?.close();
        }}
        friction={1}
        leftThreshold={40} 
        rightThreshold={40}
        overshootFriction={8} 
        enableTrackpadTwoFingerGesture
      >
        <Pressable style={styles.resultItem} onPress={() => handleResultItemPress(item)}>
          {/* Item Image Thumbnail */}
          <View style={(styles as any).resultImageContainer}>
            {item.images && item.images.length > 0 && item.images[0].url ? (
              <Pressable
                onPress={() => handleResultItemPress(item)}
                onLongPress={() => {
                  // Long press on image thumbnail opens image management modal directly
                  handleImageLongPress(item);
                }}
                style={(styles as any).resultImage}
              >
                <CachedImage
                  source={{ uri: item.images[0].url }}
                  style={(styles as any).resultImage}
                  fallbackStyle={(styles as any).resultImageFallback}
                  fallbackText={item.name ? item.name.substring(0, 2).toUpperCase() : '📦'}
                  showLoadingIndicator={false}
                  onError={() => {
                    // Handle image load error silently
                    console.log('Failed to load image for item:', item.id);
                  }}
                />
              </Pressable>
            ) : (
              <Pressable
                onPress={() => handleResultItemPress(item)}
                onLongPress={() => {
                  // Long press on fallback image opens image management modal directly
                  handleImageLongPress(item);
                }}
                style={(styles as any).resultImageFallback}
              >
                <Text style={(styles as any).resultImageFallbackText}>
                  {item.name ? item.name.substring(0, 2).toUpperCase() : '📦'}
                </Text>
              </Pressable>
            )}
          </View>

          <View style={styles.resultDetails}>
            <Text style={styles.resultName} numberOfLines={3}>{item.name ?? 'N/A'}</Text>
            <View style={[styles.resultMeta, { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }]}>
              {item.category && <Text style={styles.resultCategory}>{item.category}</Text>}
              {item.barcode && <Text style={styles.resultBarcode}>UPC: {item.barcode}</Text>}
              {item.sku && <Text style={[styles.resultBarcode, { marginLeft: 8 }]}>SKU: {item.sku}</Text>}
            </View>
          </View>
          <View style={styles.resultPrice}>
            <Text style={styles.priceText}>{formattedPrice}</Text>
          </View>
          {/* Inline reorder success notification */}
          {showReorderNotification && reorderNotificationItemId === item.id && reorderNotificationType === 'success' && (
            <View style={styles.inlineNotification}>
              <Ionicons name="checkmark-circle" size={16} color="#fff" />
              <Text style={styles.inlineNotificationText}>Added to reorder!</Text>
            </View>
          )}
        </Pressable>
      </Swipeable>
    );
  }, [handleResultItemPress, renderLeftActions, renderRightActions, styles, swipeableRefs, showReorderNotification, reorderNotificationItemId, reorderNotificationType, handleFullSwipeReorder]);

  const renderEmptyState = useCallback(() => {
    if (catalogSearchError) {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="alert-circle-outline" size={48} color="#FF3B30" />
          <Text style={styles.emptyTitle}>Search Error</Text>
          <Text style={styles.emptyText}>{catalogSearchError}</Text>
        </View>
      );
    }
    // While searching OR awaiting post-save search OR search is pending, show a spinner.
    if (catalogIsSearching || isAwaitingPostSaveSearch || isSearchPending) {
      return (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="large" color={lightTheme.colors.primary} />
          <Text style={styles.searchingText}>Searching...</Text>
        </View>
      );
    }
    if (searchTopic.trim() === '') {
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="search-outline" size={48} color="#ccc" />
          <Text style={styles.emptyTitle}>Scan or Search Your Catalog</Text>
          <Text style={styles.emptyText}>Use the input below to search by name, SKU, barcode, or category.</Text>
        </View>
      );
    }
    if (searchResults.length === 0 && searchTopic.trim() !== '') {
      const query = searchTopic.trim();
      return (
        <View style={styles.emptyContainer}>
          <Ionicons name="file-tray-outline" size={48} color="#ccc" />
          <Text style={styles.emptyTitle}>No Results Found</Text>
          <Text style={styles.emptyText}>No items found matching "{query}".</Text>
          <View style={styles.createItemButtonsContainer}>
            <Pressable 
              style={styles.createItemButton} 
              onPress={() => onCreateNewItem({ name: query })}
            >
              <Text style={styles.createItemButtonText}>Create new item with name "{query}"</Text>
            </Pressable>
            <Pressable 
              style={styles.createItemButton} 
              onPress={() => onCreateNewItem({ sku: query })}
            >
              <Text style={styles.createItemButtonText}>Create new item with SKU "{query}"</Text>
            </Pressable>
            <Pressable 
              style={styles.createItemButton} 
              onPress={() => onCreateNewItem({ barcode: query })}
            >
              <Text style={styles.createItemButtonText}>Create new item with UPC "{query}"</Text>
            </Pressable>
          </View>
        </View>
      );
    }
    return null;
  }, [catalogSearchError, catalogIsSearching, searchTopic, searchResults, styles, lightTheme, onCreateNewItem, isAwaitingPostSaveSearch, isSearchPending]);

  const renderFilterBadges = useCallback(() => {
    const activeFilters = Object.entries(searchFilters).filter(([key, isEnabled]) => key !== 'category' && isEnabled).map(([key]) => key as keyof SearchFilters);
    if (activeFilters.length === 3 || activeFilters.length === 0) return null;
    if (searchTopic.trim().length === 0) return null; 
    return (
      <View style={styles.filterBadgesContainer}>
        {activeFilters.map((filterKey) => (
          <View key={filterKey} style={styles.filterBadge}><Text style={styles.filterBadgeText}>{filterKey.charAt(0).toUpperCase() + filterKey.slice(1)}</Text></View>
        ))}
        {selectedResultCategoryId && availableResultCategories.find(c => c.id === selectedResultCategoryId) && (
            <View style={styles.filterBadge}><Text style={styles.filterBadgeText}>Category: {availableResultCategories.find(c => c.id === selectedResultCategoryId)?.name}</Text></View>
        )}
      </View>
    );
  }, [searchFilters, searchTopic, styles, selectedResultCategoryId, availableResultCategories]);

  return (
    <View style={styles.mainContent}> 
      <FlatList
        data={searchResults}
        renderItem={renderSearchResultItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.resultsContainer}
        ListEmptyComponent={renderEmptyState}
        ListHeaderComponent={renderFilterBadges}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
      />
      {searchTopic.trim().length > 0 && (
        <FilterAndSortControls
          searchFilters={searchFilters}
          onToggleFilter={toggleFilter}
          sortOrder={sortOrder}
          onSetSortOrder={setSortOrder}
          availableResultCategories={availableResultCategories}
          selectedResultCategoryId={selectedResultCategoryId}
          onSelectResultCategory={handleSelectResultCategory}
          searchResults={searchResults}
          allSearchResults={allSearchResults}
        />
      )}
      <SystemModal
        visible={showPrintNotification}
        onClose={() => setShowPrintNotification(false)}
        message={printNotificationMessage}
        type={printNotificationType}
        position="top"
        autoClose={true}
        autoCloseTime={2500} // Slightly shorter time for quick feedback
      />

      {/* Image Management Modal */}
      <ImageManagementModal
        visible={isImageManagementVisible}
        onClose={handleCloseImageManagement}
        images={selectedItemForImageManagement?.images || []}
        itemId={selectedItemForImageManagement?.id || ''}
        itemName={selectedItemForImageManagement?.name || ''}
        onImageUpload={handleImageUpload}
        onImageMakePrimary={handleImageMakePrimary}
        onImageDelete={handleImageDelete}
        onOperationComplete={handleImageOperationComplete}
      />

    </View>
  );
});
// --- END: SearchResultsArea Component Definition ---

// --- START: FilterAndSortControls Component Definition ---
interface FilterAndSortControlsProps {
  searchFilters: SearchFilters;
  onToggleFilter: (filter: keyof Omit<SearchFilters, 'category'>) => void;
  sortOrder: 'default' | 'az' | 'za' | 'price_asc' | 'price_desc';
  onSetSortOrder: (order: 'default' | 'az' | 'za' | 'price_asc' | 'price_desc') => void;
  availableResultCategories: Array<{ id: string; name: string; count: number }>;
  selectedResultCategoryId: string | null;
  onSelectResultCategory: (categoryId: string | null) => void;
  searchResults: SearchResultItem[];
  allSearchResults: SearchResultItem[];
}
const FilterAndSortControls = memo(({
  searchFilters,
  onToggleFilter,
  sortOrder,
  onSetSortOrder,
  availableResultCategories,
  selectedResultCategoryId,
  onSelectResultCategory,
  searchResults,
  allSearchResults
}: FilterAndSortControlsProps) => {
  const sortLabels: Record<typeof sortOrder, string> = {
    default: 'Default',
    az: 'A-Z',
    za: 'Z-A',
    price_asc: 'Price Low-High',
    price_desc: 'Price High-Low',
  };

  const handleSortCycle = () => {
    const orders: Array<typeof sortOrder> = ['default', 'az', 'za', 'price_asc', 'price_desc'];
    const currentIndex = orders.indexOf(sortOrder);
    const nextIndex = (currentIndex + 1) % orders.length;
    onSetSortOrder(orders[nextIndex]);
  };

  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);

  const filteredModalCategories = useMemo(() => availableResultCategories, [availableResultCategories]);

  // Memoize category button text for performance
  const categoryButtonText = useMemo(() => {
    if (selectedResultCategoryId) {
      const selectedCategory = availableResultCategories.find(c => c.id === selectedResultCategoryId);
      return selectedCategory ? `${selectedCategory.name} (${selectedCategory.count})` : 'Categories';
    }
    return `Categories (${availableResultCategories.length})`;
  }, [selectedResultCategoryId, availableResultCategories]);

  return (
    <View style={styles.controlsContainer}> 
      <View style={styles.filterAndSortInnerContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.filterContainer}
          contentContainerStyle={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 0
          }}
        >
          <Pressable style={[styles.filterButton, searchFilters.name && styles.filterButtonActive]} onPress={() => onToggleFilter('name')}><Text style={[styles.filterButtonText, searchFilters.name && styles.filterButtonTextActive]}>Name</Text></Pressable>
          <Pressable style={[styles.filterButton, searchFilters.sku && styles.filterButtonActive]} onPress={() => onToggleFilter('sku')}><Text style={[styles.filterButtonText, searchFilters.sku && styles.filterButtonTextActive]}>SKU</Text></Pressable>
          <Pressable style={[styles.filterButton, searchFilters.barcode && styles.filterButtonActive]} onPress={() => onToggleFilter('barcode')}><Text style={[styles.filterButtonText, searchFilters.barcode && styles.filterButtonTextActive]}>UPC</Text></Pressable>
          <Pressable
            style={[styles.filterButton, selectedResultCategoryId && styles.filterButtonActive, { flexDirection: 'row', alignItems: 'center', position: 'relative' }]}
            onPress={() => setShowCategoryDropdown(!showCategoryDropdown)}
          >
            <Ionicons name="filter-outline" size={14} color={selectedResultCategoryId ? '#FFFFFF' : lightTheme.colors.text} style={{ marginRight: 3 }} />
            <Text style={[styles.filterButtonText, selectedResultCategoryId && styles.filterButtonTextActive]}>
              {categoryButtonText}
            </Text>
          </Pressable>

          <Pressable style={styles.sortCycleButton} onPress={handleSortCycle}>
            <Ionicons name="swap-vertical-outline" size={16} color={lightTheme.colors.text} style={{ marginRight: 5 }} />
            <Text style={styles.sortCycleButtonText}>Sort: {sortLabels[sortOrder]}</Text>
          </Pressable>
        </ScrollView>
      </View>
      {showCategoryDropdown && (
        <>
          {/* Backdrop to close dropdown when clicking outside */}
          <Pressable
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onPress={() => setShowCategoryDropdown(false)}
          />
          <View style={styles.dropdownContainer}>
            <View style={styles.dropdownHeader}>
              <Text style={styles.dropdownHeaderText}>Filter by Category</Text>
            </View>
            <ScrollView style={styles.dropdownScrollView}>
              {[{ id: null, name: `All Categories`, count: allSearchResults.length }, ...filteredModalCategories].map((item) => (
                <Pressable
                  key={item.id ?? 'all'}
                  style={[
                    styles.dropdownItem,
                    {
                      backgroundColor: (item.id === selectedResultCategoryId) ? '#f0f8ff' : 'transparent',
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center'
                    }
                  ]}
                  onPress={() => {
                    onSelectResultCategory(item.id);
                    setShowCategoryDropdown(false);
                  }}
                >
                  <Text
                    style={[
                      styles.dropdownItemText,
                      (item.id === selectedResultCategoryId) && styles.dropdownItemTextSelected
                    ]}
                  >
                    {item.name}
                  </Text>
                  <View style={{
                    backgroundColor: (item.id === selectedResultCategoryId) ? '#007AFF' : '#e0e0e0',
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 12,
                    minWidth: 24,
                    alignItems: 'center',
                  }}>
                    <Text style={{
                      fontSize: 12,
                      color: (item.id === selectedResultCategoryId) ? '#fff' : '#666',
                      fontWeight: '600',
                    }}>
                      {item.count}
                    </Text>
                  </View>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </>
      )}
    </View>
  );
});
// --- END: FilterAndSortControls Component Definition ---

// REMOVED NESTED DatabaseProvider - already provided by app/_layout.tsx
export default function App() {
  return <RootLayoutNav />;
}

function RootLayoutNav() {
  const router = useRouter();
  const { isConnected } = useApi();
  const searchInputRef = useRef<TextInput>(null);

  // State for the *finalized* search term that triggers the actual search.
  const [searchTopic, setSearchTopic] = useState('');
  const [isAwaitingPostSaveSearch, setIsAwaitingPostSaveSearch] = useState(false);
  
  // Track reorder count for badge
  const [reorderCount, setReorderCount] = useState(0);
  
  // Listen to reorder service changes
  useEffect(() => {
    setReorderCount(reorderService.getCount());
    const unsubscribe = reorderService.addListener((items) => {
      setReorderCount(items.length);
    });
    return unsubscribe;
  }, []);



  useFocusEffect(
    useCallback(() => {
      // Failsafe to ensure the loading state doesn't get stuck.
      if (isAwaitingPostSaveSearch) {
        const timer = setTimeout(() => {
          if (isAwaitingPostSaveSearch) {
              setIsAwaitingPostSaveSearch(false);
          }
        }, 2000);
        return () => clearTimeout(timer);
      }
    }, [isAwaitingPostSaveSearch])
  );


  const handleSearchSubmit = useCallback((query: string) => {
    // logger.info('RootLayoutNav', 'Search submitted', { query });
    setSearchTopic(query);
    // NOTE: No longer triggering select all here to avoid aggressive highlighting.
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchTopic('');
    // Focus the input after clearing
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  }, []);

  const handleCreateNewItem = useCallback((params: { name?: string; sku?: string; barcode?: string }) => {
    logger.info('RootLayoutNav', 'Navigating to create new item', params);
    setIsAwaitingPostSaveSearch(true);
    router.push({ pathname: '/item/new', params });
  }, [router]);

  const handlePrintAndClear = useCallback(() => {
    setSearchTopic('');
    // After printing, just focus the input. Selection is handled by the focus effect.
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  }, []);

  const handleSearchComplete = useCallback(() => {
    setIsAwaitingPostSaveSearch(false);
  }, []);
  
  const scanHistory = useAppStore((state) => state.scanHistory);
  const addScanHistoryItem = useAppStore((state) => state.addScanHistoryItem);
  
  const navigateToHistory = useCallback(() => {
    router.push('/(tabs)/scanHistory');
  }, [router]);
  
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={lightTheme.colors.background} />
      
      {/* Header with JOYLABS Logo and Status/Notification */}
      <View style={styles.headerContainer}>
        <Text style={styles.logoText}>JOYLABS</Text>
        <View style={styles.headerRightContainer}>
          <ConnectionStatusBar 
            connected={isConnected} 
            compact={true}
          />
          <NotificationBell />
        </View>
      </View>

      <ScanHistoryButtonComponent count={scanHistory.length} onNavigate={navigateToHistory} />

      <SearchResultsArea
        searchTopic={searchTopic}
        onPrintSuccessForChaining={handlePrintAndClear}
        onCreateNewItem={handleCreateNewItem}
        isAwaitingPostSaveSearch={isAwaitingPostSaveSearch}
        onSearchComplete={handleSearchComplete}
        onClearSearch={handleClearSearch}
      />

      <BottomSearchBarComponent 
        ref={searchInputRef} 
        searchTopic={searchTopic}
        onSearchSubmit={handleSearchSubmit} 
        onClearSearch={handleClearSearch}
      />
    </SafeAreaView>
  );
}

// Define Memoized Components
interface FilterButtonsProps {
  searchFilters: SearchFilters;
  onToggleFilter: (filter: keyof SearchFilters) => void;
}
const FilterButtonsComponent = memo(({ searchFilters, onToggleFilter }: FilterButtonsProps) => {
  return (
    <View style={styles.filterContainer}>
      <Pressable style={[styles.filterButton, searchFilters.name && styles.filterButtonActive]} onPress={() => onToggleFilter('name')}><Text style={[styles.filterButtonText, searchFilters.name && styles.filterButtonTextActive]}>Name</Text></Pressable>
      <Pressable style={[styles.filterButton, searchFilters.sku && styles.filterButtonActive]} onPress={() => onToggleFilter('sku')}><Text style={[styles.filterButtonText, searchFilters.sku && styles.filterButtonTextActive]}>SKU</Text></Pressable>
      <Pressable style={[styles.filterButton, searchFilters.barcode && styles.filterButtonActive]} onPress={() => onToggleFilter('barcode')}><Text style={[styles.filterButtonText, searchFilters.barcode && styles.filterButtonTextActive]}>UPC</Text></Pressable>
      <Pressable style={[styles.filterButton, searchFilters.category && styles.filterButtonActive]} onPress={() => onToggleFilter('category')}><Text style={[styles.filterButtonText, searchFilters.category && styles.filterButtonTextActive]}>Category</Text></Pressable>
    </View>
  );
});

interface BottomSearchBarProps {
  searchTopic: string;
  onSearchSubmit: (query: string) => void;
  onClearSearch: () => void;
}
const BottomSearchBarComponent = memo(React.forwardRef<TextInput, BottomSearchBarProps>(({ 
  searchTopic,
  onSearchSubmit,
  onClearSearch,
}, ref) => {
  // This state is for UI responsiveness (e.g., showing/hiding clear buttons).
  const [inputValue, setInputValue] = useState(searchTopic);
  const inputRef = useRef<TextInput>(null);

  // Debounced function to trigger search after user stops typing.
  const debouncedSearch = useCallback(debounce((query: string) => {
    onSearchSubmit(query);
  }, 500), [onSearchSubmit]);

  // Sync from parent if searchTopic changes externally (e.g., from history).
  // Only update if the values are actually different to prevent unnecessary re-renders
  useEffect(() => {
    if (searchTopic !== inputValue) {
      setInputValue(searchTopic);
      // Update the actual TextInput value for uncontrolled component
      if (inputRef.current) {
        inputRef.current.setNativeProps({ text: searchTopic });
    }
    }
  }, [searchTopic]); // Remove inputValue from dependencies to prevent loops

  const handleChangeText = (text: string) => {
    setInputValue(text); // Update local state for UI purposes.
    debouncedSearch(text); // Trigger the actual debounced search.
  };

  const handleClear = () => {
    debouncedSearch.cancel();
    setInputValue('');
    // Clear the uncontrolled TextInput
    if (inputRef.current) {
      inputRef.current.setNativeProps({ text: '' });
    }
    onClearSearch(); // Notify parent to clear search results
  };

  // Combine refs - use both the forwarded ref and our internal ref
  const combinedRef = useCallback((instance: TextInput | null) => {
    inputRef.current = instance;
    if (typeof ref === 'function') {
      ref(instance);
    } else if (ref) {
      ref.current = instance;
    }
  }, [ref]);

  const KAV_OFFSET_IOS_internal = 62; // Should be 62 for iPhone. Increased for tab bar + safe area
  const KAV_OFFSET_ANDROID_internal = 20;

  return (
    <KeyboardAvoidingView 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? KAV_OFFSET_IOS_internal : KAV_OFFSET_ANDROID_internal}
      style={styles.searchBarContainer} 
    >
      <Pressable 
        style={[styles.externalClearTextButton, inputValue.length === 0 && styles.externalClearTextButtonDisabled]}
        onPress={handleClear}
        disabled={inputValue.length === 0}
      >
        <Text style={[styles.externalClearButtonText, inputValue.length === 0 && styles.externalClearButtonTextDisabled]}>Clear</Text>
      </Pressable>
      <View style={styles.searchInputWrapper}>
        <Ionicons name="search" size={22} color="#888" style={styles.searchIcon} />
        <TextInput
          ref={combinedRef}
          style={styles.searchInput}
          placeholder="Scan barcode or search items..."
          placeholderTextColor="#999"
          defaultValue={searchTopic} // Back to uncontrolled for HID scanner
          onChangeText={handleChangeText}
          autoFocus={true}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          blurOnSubmit={true}
          onSubmitEditing={() => {
            // Dismiss keyboard when "Done" is pressed
            if (inputRef.current) {
              inputRef.current.blur();
            }
          }}
        />
        {inputValue.length > 0 && (
          <Pressable style={styles.clearButton} onPress={handleClear}>
            <Ionicons name="close-circle" size={20} color="#aaa" />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}));

// Define Memoized ScanHistoryButtonComponent
interface ScanHistoryButtonProps {
  count: number;
  onNavigate: () => void;
}
const ScanHistoryButtonComponent = memo(({ count, onNavigate }: ScanHistoryButtonProps) => {
  return (
    <View style={styles.historyButtonContainer}>
      <Link href="/(tabs)/scanHistory" asChild>
        <Pressable style={styles.historyButton} onPress={onNavigate}>
          <Ionicons name="archive-outline" size={20} color={lightTheme.colors.primary} style={{marginRight: 8}} />
          <Text style={styles.historyButtonText}>View Scan History ({count})</Text>
        </Pressable>
      </Link>
    </View>
  );
});

// Note: The StyleSheet.create block is now expected to be in ./indexStyles.tsx
// Ensure styles.loadingOverlay and styles.loadingText are defined in indexStyles.tsx

// The old StyleSheet from index.tsx is removed, but its specific styles (like loadingOverlay)
// need to be present in indexStyles.tsx or merged.
// I will assume indexStyles.tsx (copied from searchStyles.tsx) will be the base,
// and any unique, necessary styles from the original index.tsx's StyleSheet (like loadingOverlay)
// should be added to indexStyles.tsx if not already covered.
// For now, I will add loadingOverlay to indexStyles.tsx as it's referenced. 