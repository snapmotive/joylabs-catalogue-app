import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TextInput, 
  TouchableOpacity, 
  ScrollView, 
  Image, 
  Alert, 
  Switch,
  Platform,
  Keyboard,
  Modal,
  FlatList,
  TouchableWithoutFeedback,
  KeyboardAvoidingView,
  Animated,
  ActivityIndicator,
  SafeAreaView,
  Pressable,
  useWindowDimensions
} from 'react-native';
import { useRouter, useLocalSearchParams, Stack, useNavigation } from 'expo-router';
import { usePreventRemove } from '@react-navigation/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
// import { useCategories } from '../../src/hooks'; // Commented out
import { useCatalogItems } from '../../src/hooks/useCatalogItems';
import { ConvertedItem, ConvertedCategory } from '../../src/types/api';
import { lightTheme } from '../../src/themes';
import { getAllCategories, getAllTaxes, getAllModifierLists, getAllLocations } from '../../src/database/modernDb';
import { getRecentCategoryIds, addRecentCategoryId } from '../../src/utils/recentCategories';
import { useAppStore } from '../../src/store';
import logger from '../../src/utils/logger';
import { printItemLabel, LabelData, getLabelPrinterStatus } from '../../src/utils/printLabel';
import { styles } from '../../src/styles/_itemStyles';
import SystemModal from '../../src/components/SystemModal';
import { generateClient } from 'aws-amplify/api';
import { useAuthenticator } from '@aws-amplify/ui-react-native';
import TeamDataSection from './TeamDataSection';
import ItemHistorySection from '../../src/components/ItemHistorySection';
import { itemHistoryService } from '../../src/services/itemHistoryService';
import MultiCategorySelectionModal from '../../src/components/MultiCategorySelectionModal';
import ItemImageDisplay from '../../src/components/ItemImageDisplay';
import ImageManagementModal from '../../src/components/ImageManagementModal';
import { squareImageService } from '../../src/services/squareImageService';
import { getDatabase } from '../../src/database/modernDb';

// Define type for Tax and Modifier List Pickers
type TaxPickerItem = { id: string; name: string; percentage: string | null };
type ModifierListPickerItem = { id: string; name: string }; // Used for both CRV and others
type ModalCategoryPickerItem = { id: string; name: string };

// Empty item template for new items
const EMPTY_ITEM: ConvertedItem = {
  id: '',
  name: '',
  variationName: null,
  sku: '',
  price: undefined,
  description: '',
  categoryId: '', // Keep for backward compatibility
  reporting_category_id: '', // Required reporting category
  categories: [], // Initialize empty categories array
  category: '', // Keep for display compatibility
  isActive: true,
  images: [],
  taxIds: [], // Initialize taxIds
  modifierListIds: [], // Use an array for multiple modifier lists
  updatedAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  variations: [] // Initialize empty variations array
};

// Define a type for Location Overrides
export interface LocationOverrideType {
  locationId: string;
  locationName?: string;
  price?: number;
}

// Define a type for variations
export interface ItemVariation {
  id?: string;
  version?: number;
  name: string | null;
  sku: string | null;
  price?: number;
  barcode?: string;
  locationOverrides?: Array<LocationOverrideType>; // Use defined type
}

const client = generateClient();

export default function ItemDetails() {
  const router = useRouter();
  const { id, ...params } = useLocalSearchParams<{ id: string, name?: string, sku?: string, barcode?: string }>();
  const navigation = useNavigation();
  const { user } = useAuthenticator((context) => [context.user]);
  const isNewItem = id === 'new';
  const { width } = useWindowDimensions();
  const isTablet = width >= 768;
  const panGesture = Gesture.Pan()
    .onUpdate((event) => {
      // You could add logic here for interactive dismissal, but for now we'll just use onEnd
    })
    .onEnd((event) => {
      if (event.translationY > 50) { // If swiped down more than 50 pixels
        router.back();
      }
    });
  
  // Hooks for categories and items
  // const { // Commented out
  //   categories, // Commented out
  //   getCategoryById, // Commented out
  //   dropdownItems // Commented out
  // } = useCategories(); // Commented out
  
  const {
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
    isProductsLoading,
    productError
  } = useCatalogItems();
  
  // State for the current item
  const [item, setItem] = useState<ConvertedItem>(EMPTY_ITEM);
  const [originalItem, setOriginalItem] = useState<ConvertedItem | null>(null);
  const [isEdited, setIsEdited] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPrinting, setIsPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printingVariationIndex, setPrintingVariationIndex] = useState<number | null>(null); // For inline print button loading state
  const [isSavingAndPrinting, setIsSavingAndPrinting] = useState(false);
  
  // State for print notification
  const [showPrintNotification, setShowPrintNotification] = useState(false);
  const [printNotificationMessage, setPrintNotificationMessage] = useState('');
  const [printNotificationType, setPrintNotificationType] = useState<'success' | 'error'>('success');
  
  // Removed isReadyToNavigate - navigation now handled directly in handlePostSaveSuccess

  // State to track team data changes
  const [hasTeamDataChanges, setHasTeamDataChanges] = useState(false);

  // State for image management modal
  const [isImageManagementVisible, setIsImageManagementVisible] = useState(false);
  const [isImageModalClosing, setIsImageModalClosing] = useState(false);

  // State for vendor unit cost from team data
  const [vendorUnitCost, setVendorUnitCost] = useState<number | undefined>(undefined);

  // State for variations
  const [variations, setVariations] = useState<ItemVariation[]>([{
    name: null,
    sku: '',
    price: undefined,
    barcode: ''
  }]);
  
  // State for category list and modal
  const [availableCategories, setAvailableCategories] = useState<ModalCategoryPickerItem[]>([]);
  const [filteredCategories, setFilteredCategories] = useState<ModalCategoryPickerItem[]>([]);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [showMultiCategoryModal, setShowMultiCategoryModal] = useState(false);
  const [categorySearch, setCategorySearch] = useState('');
  
  // State for recent categories
  const [recentCategories, setRecentCategories] = useState<ModalCategoryPickerItem[]>([]);
  
  // State for Taxes
  const [availableTaxes, setAvailableTaxes] = useState<TaxPickerItem[]>([]);
  const [allTaxesSelected, setAllTaxesSelected] = useState(false);

  // State for Modifiers
  const [availableModifierLists, setAvailableModifierLists] = useState<ModifierListPickerItem[]>([]);
  
  // State for Locations
  const [availableLocations, setAvailableLocations] = useState<Array<{id: string, name: string}>>([]);
  
  const itemSaveTriggeredAt = useAppStore((state: any) => state.itemSaveTriggeredAt);
  const lastProcessedSaveTrigger = useRef<number | null>(null);
  
  // State for our new action modal
  const [isActionModalVisible, setIsActionModalVisible] = useState(false);
  const [modalContent, setModalContent] = useState<{
    title: string;
    actions: Array<{ label: string; onPress: () => void; isDestructive?: boolean }>;
  } | null>(null);
  
  // State for inline location picker
  const [expandedLocationPicker, setExpandedLocationPicker] = useState<{ variationIndex: number; overrideIndex: number } | null>(null);
  
  const setLastUpdatedItem = useAppStore((state) => state.setLastUpdatedItem);
  
  const teamDataSaveRef = useRef<(() => Promise<void>) | null>(null);

  // Add state to track the real item ID after save (fixes team data save bug for new items)
  const [realItemId, setRealItemId] = useState<string>(id);

  // Callback to handle team data changes
  const handleTeamDataChange = useCallback((hasChanges: boolean) => {
    setHasTeamDataChanges(hasChanges);
  }, []);
  
  // --- Printing Logic --- 

  // Original initiatePrint for inline variation print buttons (takes index)
  const initiatePrint = useCallback(async (variationIndex: number) => {
    if (!item || !variations || variationIndex < 0 || variationIndex >= variations.length) {
      logger.warn('ItemDetails:initiatePrint', 'Invalid data for printing', { itemId: item?.id, variationIndex });
      setPrintNotificationMessage('Could not get variation data for printing.');
      setPrintNotificationType('error');
      setShowPrintNotification(true);
      setTimeout(() => setShowPrintNotification(false), 3000);
      return;
    }

    const variationToPrint = variations[variationIndex];

    const labelData: LabelData = {
      itemId: item.id,
      itemName: item.name || 'Item Name',
      variationId: variationToPrint.id,
      variationName: variationToPrint.name === null ? undefined : variationToPrint.name,
      price: variationToPrint.price,
      sku: variationToPrint.sku,
      barcode: variationToPrint.barcode,
    };

    logger.info('ItemDetails:initiatePrint', 'Initiating print for variation (inline button)', { 
      itemId: item.id, 
      variationIndex, 
      variationId: variationToPrint.id
    });
    
    setPrintingVariationIndex(variationIndex); 
      setIsPrinting(true); 
    try {
      const success = await printItemLabel(labelData);
      if (success) {
        setPrintNotificationMessage(`Label for "${variationToPrint.name || item.name || 'Item'}" sent to printer.`);
        setPrintNotificationType('success');
      } else {
        setPrintNotificationMessage('Print failed. Check printer connection.');
        setPrintNotificationType('error');
      }
    } catch (error) {
      logger.error('ItemDetails:initiatePrint', 'Error during print (inline button)', { error });
      setPrintNotificationMessage('An unexpected error occurred during print.');
      setPrintNotificationType('error');
    } finally {
      setIsPrinting(false);
      setShowPrintNotification(true);
      setTimeout(() => setShowPrintNotification(false), 3000);
      setPrintingVariationIndex(null);
    }
  }, [item, variations, setIsPrinting, setPrintNotificationMessage, setPrintNotificationType, setShowPrintNotification]);

  // New function to execute print action, potentially with price override (used by footer/popover)
  const executePrintAction = useCallback(async (variationToPrint: ItemVariation, priceOverride?: LocationOverrideType, options?: { manageState?: boolean }): Promise<boolean> => {
    const manageState = options?.manageState ?? true;

    if (!item) {
      logger.warn('ItemDetails:executePrintAction', 'Item data not available for printing');
      setPrintNotificationMessage('Item data not available.');
      setPrintNotificationType('error');
      setShowPrintNotification(true);
      setTimeout(() => setShowPrintNotification(false), 3000);
      return false;
    }

    const finalPrice = priceOverride ? priceOverride.price : variationToPrint.price;

    const labelData: LabelData = {
      itemId: item.id,
      itemName: item.name || 'Item Name',
      variationId: variationToPrint.id,
      variationName: variationToPrint.name === null ? undefined : variationToPrint.name,
      price: finalPrice,
      sku: variationToPrint.sku,
      barcode: variationToPrint.barcode,
    };

    logger.info('ItemDetails:executePrintAction', 'Initiating print (footer/popover)', { 
      itemId: item.id, 
      variationId: variationToPrint.id,
      hasPriceOverride: !!priceOverride 
    });
    
    // General printing state, not tied to a specific variation index for popover
    if (manageState) setIsPrinting(true);
    let printSuccess = false;
    try {
      const success = await printItemLabel(labelData);
      if (success) {
        const displayName = variationToPrint.name || item.name || 'Item';
        const locationName = priceOverride ? availableLocations.find(loc => loc.id === priceOverride.locationId)?.name : null;
        const message = locationName 
          ? `Label for "${displayName}" (${locationName}) sent to printer.`
          : `Label for "${displayName}" sent to printer.`;
        setPrintNotificationMessage(message);
        setPrintNotificationType('success');
        printSuccess = true;
    } else {
        setPrintNotificationMessage('Print failed. Check printer connection.');
        setPrintNotificationType('error');
      }
    } catch (error) {
      logger.error('ItemDetails:executePrintAction', 'Error during print (footer/popover)', { error });
      setPrintNotificationMessage('An unexpected error occurred during print.');
      setPrintNotificationType('error');
    } finally {
      if (manageState) setIsPrinting(false);
      setShowPrintNotification(true);
      setTimeout(() => setShowPrintNotification(false), 3000);
    }
    return printSuccess;
  }, [item, availableLocations, setIsPrinting, setPrintNotificationMessage, setPrintNotificationType, setShowPrintNotification]);

  // Define handlers before they are used
  const handleInputChange = (key: keyof ConvertedItem, value: string | number | undefined) => {
    // Handle potential numeric conversion for price
    if (key === 'price') {
      const textValue = value as string; // Input value is text

      // If input is empty or explicitly cleared, treat as variable price
      if (textValue === '' || textValue === null || textValue === undefined) {
        updateItem('price', undefined);
        return;
      }

      // Keep only digits
      const digits = textValue.replace(/[^0-9]/g, '');

      // If no digits remain (e.g., input was just '.'), treat as variable
      if (digits === '') {
        updateItem('price', undefined);
        return;
      }

      // Parse digits as cents
      const cents = parseInt(digits, 10);

      // Handle potential parsing errors (though unlikely with digit filter)
      if (isNaN(cents)) {
        console.warn('Invalid number parsed for price:', digits);
        // Optionally reset to variable or keep previous state? Resetting for safety.
        updateItem('price', undefined); 
        return;
      }

      // Calculate price in dollars and update state
      const dollars = cents / 100;
      updateItem('price', dollars);
      
    } else {
      // Handle other fields normally (treat as strings)
      updateItem(key, value as string);
    }
  };

  // Handler for variation input changes
  const handleVariationChange = (index: number, field: keyof ItemVariation, value: string | number | undefined) => {
    setVariations(prevVariations => {
      const newVariations = [...prevVariations];
      
      if (field === 'price') {
        // Handle price conversion similar to handleInputChange
        const textValue = value as string;
        
        if (textValue === '' || textValue === null || textValue === undefined) {
          newVariations[index] = { ...newVariations[index], price: undefined };
          return newVariations;
        }
        
        const digits = textValue.replace(/[^0-9]/g, '');
        
        if (digits === '') {
          newVariations[index] = { ...newVariations[index], price: undefined };
          return newVariations;
        }
        
        const cents = parseInt(digits, 10);
        
        if (isNaN(cents)) {
          console.warn('Invalid number parsed for variation price:', digits);
          newVariations[index] = { ...newVariations[index], price: undefined };
          return newVariations;
        }
        
        const dollars = cents / 100;
        newVariations[index] = { ...newVariations[index], price: dollars };
      } else if (field === 'locationOverrides') {
        // Handle location overrides as a special case
        newVariations[index] = { ...newVariations[index], locationOverrides: value as any };
      } else {
        // Handle other fields
        newVariations[index] = { ...newVariations[index], [field]: value };
      }
      
      return newVariations;
    });
    
    // Mark as edited
    setIsEdited(true);
  };

  // Handler to add a new variation
  const addVariation = () => {
    setVariations(prev => [...prev, {
      name: null,
      sku: '',
      price: undefined,
      barcode: ''
    }]);
    setIsEdited(true);
  };

  // Handler to remove a variation
  const removeVariation = (index: number) => {
    // Don't allow removing the last variation
    if (variations.length <= 1) {
      return;
    }

    setVariations(prev => prev.filter((_, i) => i !== index));
    setIsEdited(true);
  };

  // Handler to add a price override to a variation
  const addPriceOverride = (variationIndex: number) => {
    setVariations(prevVariations => {
      const newVariations = [...prevVariations];
      const variation = newVariations[variationIndex];
      
      // Initialize locationOverrides array if it doesn't exist
      if (!variation.locationOverrides) {
        variation.locationOverrides = [];
      }
      
      // Add a new empty override
      variation.locationOverrides.push({
        locationId: '', // Will be selected by user
        price: undefined // Will be entered by user
      });
      
      return newVariations;
    });
    
    setIsEdited(true);
  };

  // Handler to remove a price override from a variation
  const removePriceOverride = (variationIndex: number, overrideIndex: number) => {
    setVariations(prevVariations => {
      const newVariations = [...prevVariations];
      const variation = newVariations[variationIndex];
      
      if (variation.locationOverrides && variation.locationOverrides.length > overrideIndex) {
        variation.locationOverrides.splice(overrideIndex, 1);
      }
      
      return newVariations;
    });
    
    setIsEdited(true);
  };

  // Handler to update a price override
  const updatePriceOverride = (variationIndex: number, overrideIndex: number, field: 'locationId' | 'price', value: string | number | undefined) => {
    setVariations(prevVariations => {
      const newVariations = [...prevVariations];
      const variation = newVariations[variationIndex];
      
      if (!variation.locationOverrides || variation.locationOverrides.length <= overrideIndex) {
        return newVariations;
      }
      
      if (field === 'price') {
        // Handle price conversion similar to handleInputChange
        const textValue = value as string;
        
        if (textValue === '' || textValue === null || textValue === undefined) {
          variation.locationOverrides[overrideIndex].price = undefined;
          return newVariations;
        }
        
        const digits = textValue.replace(/[^0-9]/g, '');
        
        if (digits === '') {
          variation.locationOverrides[overrideIndex].price = undefined;
          return newVariations;
        }
        
        const cents = parseInt(digits, 10);
        
        if (isNaN(cents)) {
          console.warn('Invalid number parsed for override price:', digits);
          variation.locationOverrides[overrideIndex].price = undefined;
          return newVariations;
        }
        
        const dollars = cents / 100;
        variation.locationOverrides[overrideIndex].price = dollars;
      } else {
        // Handle locationId
        variation.locationOverrides[overrideIndex].locationId = value as string;
        
        // Update the location name if available
        const location = availableLocations.find(loc => loc.id === value);
        if (location) {
          variation.locationOverrides[overrideIndex].locationName = location.name;
        }
      }
      
      return newVariations;
    });
    
    setIsEdited(true);
  };

  const handleTaxSelection = (taxId: string) => {
    const currentIds = item.taxIds || [];
    const newIds = currentIds.includes(taxId)
      ? currentIds.filter(id => id !== taxId)
      : [...currentIds, taxId];
    updateItem('taxIds', newIds);
  };

  const handleModifierSelection = (modifierId: string) => {
    // Log before update
    console.log(`[Modifier Selection] Tapped ID: ${modifierId}`);
    console.log(`[Modifier Selection] Item state BEFORE updateItem call:`, JSON.stringify(item)); // Log state before calling updateItem

    // Directly pass the toggled modifierId to updateItem.
    // The logic to add/remove is handled within updateItem itself.
    updateItem('modifierListIds', modifierId);
  };
  
  // == Stable Handlers ==
  const isEmpty = useCallback((): boolean => {
    return (
      !(item.name && item.name.trim()) && 
      !(item.sku && item.sku.trim()) &&
      item.price === undefined &&
      !(item.description && item.description.trim()) &&
      !item.reporting_category_id
    );
  }, [item]); // Depends on item state

  const handleFooterCancel = useCallback(() => {
    router.back();
  }, [router]);


  // Removed handleSaveSuccessNavigation - now using handlePostSaveSuccess

  const trackItemChanges = useCallback(async (savedItem: ConvertedItem): Promise<void> => {
    // Gracefully handle unauthenticated users
    if (!user?.signInDetails?.loginId) {
      logger.info('ItemDetails:trackItemChanges', 'Skipping change tracking - user not authenticated', {
        itemId: savedItem.id
      });
      return;
    }
    
    const userName = user.signInDetails.loginId.split('@')[0] || 'Unknown User';
    
    try {
      // Track item creation
      if (isNewItem) {
        await itemHistoryService.logItemCreation(
          savedItem.id,
          savedItem.name || 'Unnamed Item',
          userName
        );
        return; // For new items, no need to check for other changes
      }
      
      // Track changes for existing items
      if (!originalItem) return;
      
      const changes: Promise<boolean>[] = [];
      
      // Track price changes for each variation
      if (originalItem.variations && savedItem.variations) {
        const originalVariationsMap = new Map(originalItem.variations.map(v => [v.id || v.name || 'default', v]));
        
        for (const newVar of savedItem.variations) {
          const originalVar = originalVariationsMap.get(newVar.id || newVar.name || 'default');
          
          if (originalVar && originalVar.price !== newVar.price) {
            changes.push(
              itemHistoryService.logPriceChange(
                savedItem.id,
                savedItem.name || 'Unnamed Item',
                newVar.name,
                originalVar.price,
                newVar.price,
                userName
              )
            );
          }
        }
      }
      
      // Track tax changes
      const originalTaxIds = new Set(originalItem.taxIds || []);
      const newTaxIds = new Set(savedItem.taxIds || []);
      const addedTaxes = [...newTaxIds].filter(id => !originalTaxIds.has(id));
      const removedTaxes = [...originalTaxIds].filter(id => !newTaxIds.has(id));
      
      if (addedTaxes.length > 0 || removedTaxes.length > 0) {
        const taxNameMap: Record<string, string> = {};
        availableTaxes.forEach(tax => {
          taxNameMap[tax.id] = `${tax.name} (${tax.percentage}%)`;
        });
        
        changes.push(
          itemHistoryService.logTaxChange(
            savedItem.id,
            savedItem.name || 'Unnamed Item',
            addedTaxes,
            removedTaxes,
            taxNameMap,
            userName
          )
        );
      }
      
      // Track category changes
      const originalCategoryId = originalItem.reporting_category_id;
      const newCategoryId = savedItem.reporting_category_id;
      
      if (originalCategoryId !== newCategoryId) {
        const originalCategoryName = availableCategories.find(cat => cat.id === originalCategoryId)?.name;
        const newCategoryName = availableCategories.find(cat => cat.id === newCategoryId)?.name;
        
        changes.push(
          itemHistoryService.logCategoryChange(
            savedItem.id,
            savedItem.name || 'Unnamed Item',
            originalCategoryName,
            newCategoryName,
            userName
          )
        );
      }
      
      // Track variation additions/removals
      const originalVariationIds = new Set((originalItem.variations || []).map(v => v.id).filter(Boolean));
      const newVariationIds = new Set((savedItem.variations || []).map(v => v.id).filter(Boolean));
      
      // Added variations
      for (const newVar of savedItem.variations || []) {
        if (newVar.id && !originalVariationIds.has(newVar.id)) {
          changes.push(
            itemHistoryService.logVariationChange(
              savedItem.id,
              savedItem.name || 'Unnamed Item',
              'added',
              newVar.name,
              userName
            )
          );
        }
      }
      
      // Removed variations
      for (const originalVar of originalItem.variations || []) {
        if (originalVar.id && !newVariationIds.has(originalVar.id)) {
          changes.push(
            itemHistoryService.logVariationChange(
              savedItem.id,
              savedItem.name || 'Unnamed Item',
              'removed',
              originalVar.name,
              userName
            )
          );
        }
      }
      
      // Execute all change logging in parallel
      if (changes.length > 0) {
        await Promise.allSettled(changes);
        logger.info('ItemDetails:trackItemChanges', 'Successfully logged item changes', {
          itemId: savedItem.id,
          changeCount: changes.length
        });
      }
      
    } catch (error) {
      logger.error('ItemDetails:trackItemChanges', 'Error tracking item changes', { error, itemId: savedItem.id });
      // Don't fail the save operation if history tracking fails
    }
  }, [user, isNewItem, originalItem, availableTaxes, availableCategories]);

  const handleSaveAction = async (options?: { manageState?: boolean }): Promise<ConvertedItem | null> => {
    const manageState = options?.manageState ?? true;

    logger.info('ItemDetails:handleSaveAction', 'Save action initiated', { isNewItem, itemId: id, manageState });
    Keyboard.dismiss();

    if (!item.name || item.name.trim() === '') {
      Alert.alert('Validation Error', 'Item name cannot be empty.');
      return null;
    }

    if (variations.length === 0) {
      Alert.alert('Validation Error', 'At least one item variation is required.');
      return null;
    }

    for (const v of variations) {
      if (v.price !== undefined && v.price !== null && (isNaN(v.price) || v.price < 0)) {
        Alert.alert('Validation Error', `Invalid price for variation "${v.name || 'Unnamed'}. Price must be a positive number.`);
        return null;
      }
    }

    if (manageState) setIsSaving(true);
    setError(null);
    
    const itemPayload: ConvertedItem = {
        ...item, 
      variations: variations,
    };

    itemPayload.variations = itemPayload.variations?.map(v => {
      const { id: variationId, ...rest } = v;
      if (variationId && variationId.startsWith('temp-')) {
        return rest;
      }
      return v;
    });
    
    logger.debug('ItemDetails:handleSaveAction', 'Item payload for save:', itemPayload);

    try {
      let savedItem;
      if (isNewItem) {
        logger.info('ItemDetails:handleSaveAction', 'Creating new item...');
        savedItem = await createProduct(itemPayload);
      } else {
        logger.info('ItemDetails:handleSaveAction', `Updating item with ID: ${id}`);
        savedItem = await updateProduct(id!, itemPayload);
      }
      
      if (savedItem) {
        // Track item changes in history
        await trackItemChanges(savedItem);

        // Update the real item ID for team data save (fixes new item bug)
        setRealItemId(savedItem.id);

        // Wait for state update to propagate before saving team data
        await new Promise(resolve => setTimeout(resolve, 100));

        // Save team data with the correct item ID
        if (teamDataSaveRef.current) {
          logger.info('ItemDetails:handleSaveAction', 'Saving team data for item', { itemId: savedItem.id });
          await teamDataSaveRef.current();
        }

        // Images are now handled independently by the image service
        // No need to save images here - they're already saved when uploaded
        if (item.images && item.images.length > 0) {
          logger.info('ItemDetails:handleSaveAction', 'Images handled independently by image service', {
            itemId: savedItem.id,
            imageCount: item.images.length,
            imageIds: item.images.map(img => img.id)
          });
        }

        setLastUpdatedItem(savedItem);
        // Reset team data changes flag after successful save
        setHasTeamDataChanges(false);
        return savedItem;
      } else {
        logger.error('ItemDetails:handleSaveAction', 'Save failed. No saved item data returned.');
        setError('Failed to save item. Please try again.');
        Alert.alert('Error', 'Failed to save item. An unexpected error occurred.');
        return null;
      }
    } catch (err: any) {
      logger.error('ItemDetails:handleSaveAction', 'Error saving item', { error: err });
      setError(err.message || 'An unknown error occurred during save.');
      Alert.alert('Save Error', err.message || 'An unexpected error occurred. Please try again.');
      return null;
    } finally {
      if (manageState) setIsSaving(false);
    }
  };

  // Consolidated function to handle post-save state management and navigation
  const handlePostSaveSuccess = useCallback((savedItem: ConvertedItem) => {
    logger.info('ItemDetails:handlePostSaveSuccess', 'Processing post-save state updates', {
      itemId: savedItem.id,
      isNewItem
    });

    try {
      // Update all state in a single batch to prevent race conditions
      setLastUpdatedItem(savedItem);

      // For existing items with images, don't navigate away - let user see their uploaded images
      const hasImages = savedItem.images && savedItem.images.length > 0;
      const shouldStayOnPage = !isNewItem && hasImages;

      if (shouldStayOnPage) {
        logger.info('ItemDetails:handlePostSaveSuccess', 'Staying on page - item has images', {
          itemId: savedItem.id,
          imageCount: savedItem.images?.length || 0
        });

        // Update item state but preserve the current images in the UI
        // Don't update originalItem so change detection still works for future changes
        setItem(savedItem);
        setVariations(savedItem.variations || []);
        setHasTeamDataChanges(false);

        // Clear loading states
        setIsSaving(false);
        setIsPrinting(false);
        setIsSavingAndPrinting(false);
        setIsEdited(false);

        // Show success message
        Alert.alert('Success', 'Item and images saved successfully!');

      } else {
        // Original behavior for new items or items without images
        setItem(savedItem);
        setOriginalItem(savedItem);
        setVariations(savedItem.variations || []);
        setHasTeamDataChanges(false);

        // Clear any loading states that might be active
        setIsSaving(false);
        setIsPrinting(false);
        setIsSavingAndPrinting(false);

        // Use requestAnimationFrame to ensure all state updates are processed
        requestAnimationFrame(() => {
          setIsEdited(false);
          // Navigate after clearing edited state
          requestAnimationFrame(() => {
            router.back();
          });
        });
      }
    } catch (error) {
      logger.error('ItemDetails:handlePostSaveSuccess', 'Error in post-save handler', { error });
      // Fallback navigation if state updates fail
      router.back();
    }
  }, [router, setLastUpdatedItem, isNewItem, setItem, setOriginalItem, setVariations, setHasTeamDataChanges, setIsEdited, setIsSaving, setIsPrinting, setIsSavingAndPrinting]);

  const handleActionSelect = async (action: 'print' | 'save_and_print', selectedVariation: ItemVariation, selectedOverride?: LocationOverrideType) => {
    // For a simple print action, manage its own state.
    if (action === 'print') {
        setIsPrinting(true);
        try {
            await executePrintAction(selectedVariation, selectedOverride); 
        } catch (e) {
            logger.error('ItemDetails:handleActionSelect', 'Error during print action', { error: e });
            Alert.alert("Error", "An unexpected error occurred during the print action.");
        } finally {
            setIsPrinting(false);
        }
        return;
    }

    // For the combined "Save & Print" action, orchestrate the state here.
    if (action === 'save_and_print') {
        setIsSavingAndPrinting(true);
        try {
            // Step 1: Print the item first with the current (unsaved) data from the form.
            const printSuccess = await executePrintAction(selectedVariation, selectedOverride, { manageState: false });
            
            // Step 2: If printing is successful, proceed to save the item.
            if (printSuccess) {
                // Step 3: Save the item. Let it manage its own state flags.
                const savedItem = await handleSaveAction({ manageState: false });

                // Step 4: If saving is successful, use consolidated post-save handler
                if (savedItem) {
                    handlePostSaveSuccess(savedItem);
                }
            }
        } catch (e) {
            logger.error('ItemDetails:handleActionSelect', 'Error during save_and_print action', { error: e });
            Alert.alert("Error", "An unexpected error occurred while processing the save and print action.");
        } finally {
            // Step 5: Always turn off the loading indicator.
            setIsSavingAndPrinting(false);
        }
    }
  };

  // Helper to generate items for the print options menu
  const getPrintMenuItems = useCallback(() => {
    const menuItems: Array<{ label: string; variation: ItemVariation; override?: LocationOverrideType }> = [];
    if (!variations || variations.length === 0) {
      return menuItems;
    }

    variations.forEach(variation => {
      if (!variation.locationOverrides || variation.locationOverrides.length === 0) {
        // No overrides, just the base variation
        menuItems.push({
          label: `${variation.name || item?.name || 'Item'} (${variation.price !== undefined ? '$' + variation.price.toFixed(2) : 'Variable Price'})`,
          variation: variation,
        });
          } else {
        // Has overrides, list each one
        variation.locationOverrides.forEach(override => {
          const locationName = availableLocations.find(loc => loc.id === override.locationId)?.name || override.locationId || 'Unknown Location';
          menuItems.push({
            label: `${variation.name || item?.name || 'Item'} - ${locationName} ($${override.price !== undefined ? override.price.toFixed(2) : 'N/A'})`,
            variation: variation,
            override: override,
          });
        });
        // Optionally, also list the base price of the variation if it has overrides and a defined price
        if (variation.price !== undefined) {
          menuItems.push({
             label: `${variation.name || item?.name || 'Item'} - Standard Price ($${variation.price.toFixed(2)})`,
             variation: variation,
           });
        }
      }
    });
    return menuItems.sort((a,b) => a.label.localeCompare(b.label)); // Sort for consistent order
  }, [variations, item?.name, availableLocations]);

  // Handler to open the modal for Print or Save & Print
  const openActionModal = (action: 'print' | 'save_and_print') => {
    const printItems = getPrintMenuItems();
    if (printItems.length === 0) {
      Alert.alert("Cannot Print", "No printable variations or options found for this item.");
      return;
    }

    const isTrulySingleOption = printItems.length === 1 && variations.length === 1 &&
                               (!variations[0].locationOverrides || variations[0].locationOverrides.length === 0);

    // If there's only one, non-override option, perform the action directly
    if (isTrulySingleOption) {
        handleActionSelect(action, printItems[0].variation, printItems[0].override);
        return;
    }

    // Otherwise, show the modal with all options
    setModalContent({
        title: action === 'print' ? 'Select Option to Print' : 'Select Option to Save & Print',
        actions: printItems.map(menuItem => ({
            label: menuItem.label,
            onPress: () => {
                setIsActionModalVisible(false);
                handleActionSelect(action, menuItem.variation, menuItem.override);
            }
        })),
    });
    setIsActionModalVisible(true);
  };
  
  // Fetch the item data, categories, taxes, and modifiers on component mount
  useEffect(() => {
    const fetchInitialData = async () => {
      setIsLoading(true);
      setError(null);
      
      try {
        // Fetch categories, taxes, modifiers, and locations concurrently
        const [fetchedCategories, fetchedTaxes, fetchedModifierLists, fetchedLocations] = await Promise.all([
          getAllCategories(),
          getAllTaxes(),
          getAllModifierLists(),
          getAllLocations()
        ]);

        console.log('[ItemDetails] Fetched Taxes:', JSON.stringify(fetchedTaxes, null, 2));
        console.log('[ItemDetails] Fetched Modifier Lists:', JSON.stringify(fetchedModifierLists, null, 2));

        setAvailableCategories(fetchedCategories);
        setFilteredCategories(fetchedCategories); 
        setAvailableTaxes(fetchedTaxes);
        setAvailableModifierLists(fetchedModifierLists);
        setAvailableLocations(fetchedLocations);
        
        const initialTaxIdsSet = new Set(item?.taxIds || []);
        const allFetchedTaxIds = new Set(fetchedTaxes.map(tax => tax.id));
        const areAllSelected = fetchedTaxes.length > 0 && fetchedTaxes.every(tax => initialTaxIdsSet.has(tax.id));
        setAllTaxesSelected(Boolean(areAllSelected));
        
        const recentIds = await getRecentCategoryIds();
        const recentCategoryObjects = recentIds
          .map(id => fetchedCategories.find(cat => cat.id === id))
          .filter((cat): cat is ModalCategoryPickerItem => cat !== undefined); 
        setRecentCategories(recentCategoryObjects);
        
        if (!isNewItem && typeof id === 'string') {
          const fetchedItem = await getProductById(id);
          if (fetchedItem) {
            console.log('[ItemDetails] Fetched Item Data:', JSON.stringify(fetchedItem, null, 2));
            logger.info('ItemDetails', 'Item images debug after fetch:', {
              imageCount: fetchedItem.images?.length || 0,
              imageIds: fetchedItem.images?.map(img => img.id) || [],
              imageUrls: fetchedItem.images?.map(img => img.url) || []
            });



            // Create the canonical 'variations' array first to ensure consistent structure.
            const itemVariations = (fetchedItem.variations && Array.isArray(fetchedItem.variations) && fetchedItem.variations.length > 0
              ? fetchedItem.variations.map(v => ({
                  id: (v as ItemVariation).id,
                  version: (v as ItemVariation).version,
                  name: (v as ItemVariation).name || null,
                  sku: (v as ItemVariation).sku || null,
                  price: (v as ItemVariation).price,
                  barcode: (v as ItemVariation).barcode,
                  locationOverrides: (v as ItemVariation).locationOverrides || []
                }))
              : [{ // Fallback for older data structures
                  id: fetchedItem.variationId,
                  version: fetchedItem.variationVersion,
                  name: fetchedItem.variationName || null,
                  sku: fetchedItem.sku || null,
                  price: fetchedItem.price,
                  barcode: fetchedItem.barcode,
                  locationOverrides: []
                }]).map(v => ({...v, locationOverrides: v.locationOverrides || []})); // Ensure overrides array exists
            
            const initialReportingCategoryId = (fetchedItem as any).reporting_category?.id || fetchedItem.reporting_category_id || '';
            const initialTaxIds = fetchedItem.taxIds || [];
            const initialModifierListIds = fetchedItem.modifierListIds || [];
            const initialVersion = fetchedItem.version; 
            
            // Construct the definitive item object using the transformed variations.
            const definitiveItem = { 
              ...fetchedItem, 
              version: initialVersion, 
              reporting_category_id: initialReportingCategoryId,
              taxIds: initialTaxIds, 
              modifierListIds: initialModifierListIds,
              variations: itemVariations, // Use the canonical variations array
            };

            // Set all relevant state from this single source of truth.
            setItem(definitiveItem);
            setOriginalItem(definitiveItem);
            setVariations(itemVariations);
            // Update real item ID for existing items too
            setRealItemId(definitiveItem.id);
            
          } else {
            setError('Item not found');
            setItem(EMPTY_ITEM);
          }
        } else if (isNewItem) {
          setItem(EMPTY_ITEM);
          setOriginalItem(null);
          // Initialize with one default variation for new items
          let initialSku = '';
          let initialBarcode = '';

          const initialItemState = { ...EMPTY_ITEM };
          if (params.name) {
            initialItemState.name = params.name;
          }
          if (params.sku) {
            initialSku = params.sku;
            initialItemState.sku = params.sku; // Also set on item for consistency, though primary is variation
          }
          if (params.barcode) {
            initialBarcode = params.barcode;
            // Barcode is primarily a variation field, but can be set on item if needed by backend
          }

          setItem(initialItemState);

          setVariations([{
            name: null, // Default variation name
            sku: initialSku,
            price: undefined,
            barcode: initialBarcode
          }]);
        } else {
          setError('Invalid Item ID');
          setItem(EMPTY_ITEM);
        }
        
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data');
        console.error('Error fetching initial data:', err);
        setItem(EMPTY_ITEM);
      } finally {
        setIsLoading(false);
      }
    };
    
    fetchInitialData();
  }, [id, getProductById, isNewItem]);
  
  // Filter categories when search text changes
  useEffect(() => {
    if (!categorySearch) {
      setFilteredCategories(availableCategories);
    } else {
      const searchLower = categorySearch.toLowerCase().trim();
      const filtered = availableCategories.filter(
        category => category.name.toLowerCase().includes(searchLower)
      );
      setFilteredCategories(filtered);
    }
  }, [availableCategories, categorySearch]);
  
  // Check if item has been edited and update 'all taxes selected' status
  useEffect(() => {
    const areArraysEqual = (a: string[] = [], b: string[] = []) => {
      if (a.length !== b.length) return false;
      const sortedA = [...a].sort();
      const sortedB = [...b].sort();
      return sortedA.every((val, index) => val === sortedB[index]);
    };

    const areVariationsEqual = (varsA: ItemVariation[] = [], varsB: ItemVariation[] = []) => {
      if (varsA.length !== varsB.length) return false;
      const sortById = (a: ItemVariation, b: ItemVariation) => (a.id || '').localeCompare(b.id || '');
      const sortedA = [...varsA].sort(sortById);
      const sortedB = [...varsB].sort(sortById);

      for (let i = 0; i < sortedA.length; i++) {
        const varA = sortedA[i];
        const varB = sortedB[i];
        if (varA.name !== varB.name || varA.sku !== varB.sku || varA.price !== varB.price || varA.barcode !== varB.barcode) {
          return false;
        }

        const overridesA = varA.locationOverrides || [];
        const overridesB = varB.locationOverrides || [];
        if (overridesA.length !== overridesB.length) return false;
        
        if (overridesA.length > 0) {
          const sortByLocationId = (a: LocationOverrideType, b: LocationOverrideType) => (a.locationId || '').localeCompare(b.locationId || '');
          const sortedOverridesA = [...overridesA].sort(sortByLocationId);
          const sortedOverridesB = [...overridesB].sort(sortByLocationId);

          for (let j = 0; j < sortedOverridesA.length; j++) {
            if (sortedOverridesA[j].locationId !== sortedOverridesB[j].locationId || sortedOverridesA[j].price !== sortedOverridesB[j].price) {
              return false;
            }
          }
        }
      }
      return true;
    };

    // Images are now handled independently - no need for complex change detection

    if (isNewItem) {
      const defaultNewVariations = [{ name: null, sku: '', price: undefined, barcode: '' }];
      const variationsChanged = !areVariationsEqual(variations, defaultNewVariations);

      const calculatedIsEdited =
          !!(item.name && item.name.trim()) ||
          !!(item.description && item.description.trim()) ||
          !!item.reporting_category_id ||
          (item.taxIds && item.taxIds.length > 0) ||
        (item.modifierListIds && item.modifierListIds.length > 0) ||
        variationsChanged ||
        hasTeamDataChanges; // Include team data changes

      setIsEdited(calculatedIsEdited);

    } else if (item && originalItem) {
      const taxIdsChanged = !areArraysEqual(originalItem.taxIds, item.taxIds);
      const modifierIdsChanged = !areArraysEqual(originalItem.modifierListIds, item.modifierListIds);
      const variationsChanged = !areVariationsEqual(originalItem.variations, variations);

      const calculatedIsEdited =
          originalItem.name !== item.name ||
          originalItem.sku !== item.sku ||
          originalItem.price !== item.price ||
          originalItem.description !== item.description ||
          originalItem.reporting_category_id !== item.reporting_category_id ||
          taxIdsChanged ||
        modifierIdsChanged ||
        variationsChanged ||
        hasTeamDataChanges; // Include team data changes

      setIsEdited(calculatedIsEdited);
    }
  }, [item, originalItem, variations, isNewItem, hasTeamDataChanges]); // Add hasTeamDataChanges to dependencies

  // This effect now ONLY handles the state of the "select all taxes" button.
  useEffect(() => {
    if (item && availableTaxes && availableTaxes.length > 0) {
      const currentTaxIdsSet = new Set(item.taxIds || []);
      const areAllSelected = availableTaxes.every(tax => currentTaxIdsSet.has(tax.id));
      setAllTaxesSelected(areAllSelected);
    }
  }, [item.taxIds, availableTaxes]);
  
  // Update a field in the item state
  const updateItem = (key: keyof ConvertedItem, value: any) => {
    // Use functional update to ensure we work with the latest state
    // **Ensure variationName defaults to 'Regular' if cleared**
    if (key === 'variationName' && (value === '' || value === null || value === undefined)) {
      value = 'Regular';
    }
    setItem(prev => {
      let newState = { ...prev }; // Copy previous state

      // Special handling for modifierListIds array
      if (key === 'modifierListIds') {
        const modifierId = value; // 'value' is the single ID being toggled
        const currentIds = prev.modifierListIds || [];
        let newIds;
        if (currentIds.includes(modifierId)) {
          newIds = currentIds.filter(id => id !== modifierId); // Remove ID
        } else {
          newIds = [...currentIds, modifierId]; // Add ID
        }
        newState = { ...prev, modifierListIds: newIds };
      } else {
        // Handle other fields normally
        newState = { ...prev, [key]: value };
      }

      // Recalculate 'all taxes selected' state *after* the main state update logic
      // Only do this if taxIds was the key being updated
      if (key === 'taxIds') {
        let areAllSelected = false;
        const newTaxIds = newState.taxIds || []; // Use the updated tax IDs from newState
        // Ensure availableTaxes is populated before checking
        if (availableTaxes && availableTaxes.length > 0) {
           areAllSelected = availableTaxes.every(tax => newTaxIds.includes(tax.id));
        }
        // Set the dependent state - guaranteed boolean
        setAllTaxesSelected(areAllSelected);
      }

      return newState; // Return the fully updated state
    });
  };
  
  // Toggle all taxes selection
  const handleSelectAllTaxes = () => {
    const currentTaxIds = item.taxIds || [];
    let newTaxIds: string[];

    if (allTaxesSelected) {
      // If all are selected, deselect all
      newTaxIds = [];
    } else {
      // If not all are selected (or none), select all
      newTaxIds = availableTaxes.map(tax => tax.id);
    }
    updateItem('taxIds', newTaxIds);
  };
  
  // Get the current category display text, handle loading state
  const selectedCategoryDisplayText = useMemo(() => {
    if (isLoading) return 'Loading...';
    
    // Check if we have categories array (new system)
    if (item.categories && item.categories.length > 0) {
      const reportingCategory = availableCategories.find(c => c.id === item.reporting_category_id);
      const reportingName = reportingCategory?.name || 'Unknown';
      
      if (item.categories.length === 1) {
        return reportingName;
      } else {
        // Get subcategories (all except reporting category)
        const subcategories = item.categories
          .filter(cat => cat.id !== item.reporting_category_id)
          .map(cat => {
            const categoryData = availableCategories.find(c => c.id === cat.id);
            return categoryData?.name || 'Unknown';
          })
          .filter(name => name !== 'Unknown');
        
        if (subcategories.length === 0) {
          return reportingName;
        }
        
        return `Reporting: ${reportingName}\nSubcategories: ${subcategories.join(', ')}`;
      }
    }
    
    // Fallback to legacy single category system
    const categoryId = item.reporting_category_id;
    if (categoryId) {
      const found = availableCategories.find(c => c.id === categoryId);
      if (found) {
        if (originalItem?.reporting_category_id !== categoryId) {
             addRecentCategoryId(categoryId);
        }
        return found.name;
      } else {
        console.warn(`[ItemDetails SelectedCategory] Category ID "${categoryId}" found in item but NOT in availableCategories list!`);
        return 'Select Category';
      }
    }
    return 'Select Category';
  }, [item.reporting_category_id, item.categories, availableCategories, isLoading, originalItem]);
  
  // Handle selecting a category (legacy single category)
  const handleSelectCategory = (categoryId: string | null) => {
    updateItem('reporting_category_id', categoryId); 
    if (categoryId) {
        addRecentCategoryId(categoryId); // Also add to recent when selected this way
    }
    setShowCategoryModal(false);
    setCategorySearch(''); // Reset search on selection
  };

  // Handle multi-category selection
  const handleMultiCategorySelection = (selectedCategories: Array<{ id: string; ordinal?: number }>, reportingCategoryId: string) => {
    // Enrich categories with names for better UX
    const enrichedCategories = selectedCategories.map(cat => {
      const categoryData = availableCategories.find(c => c.id === cat.id);
      return {
        id: cat.id,
        name: categoryData?.name,
        ordinal: cat.ordinal
      };
    });

    updateItem('categories', enrichedCategories);
    updateItem('reporting_category_id', reportingCategoryId);
    
    if (reportingCategoryId) {
      addRecentCategoryId(reportingCategoryId);
    }
    
    logger.info('ItemDetails:handleMultiCategorySelection', 'Updated item with multiple categories', {
      categoriesCount: selectedCategories.length,
      reportingCategoryId,
      categories: enrichedCategories
    });
  };
  
  // Handle delete button press
  const handleDelete = useCallback(async () => {
    if (!item?.id || isNewItem) return; // Do not allow delete for new items

    Alert.alert(
      'Delete Item',
      `Are you sure you want to delete "${item.name || 'this item'}"? This action cannot be undone.`,
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteProduct(item.id as string); // Ensure item.id is passed as string
              Alert.alert('Success', 'Item deleted successfully');
              // Manually set isEdited to false right before navigating to prevent prompt.
              setIsEdited(false);
              setHasTeamDataChanges(false); // Reset team data changes
              router.back(); // Dismiss modal on delete
            } catch (error: any) {
              console.error('Error deleting item:', error);
              Alert.alert('Error', `Error deleting item: ${error.message}`);
            }
          },
        },
      ],
      { cancelable: true } // Allow dismissing by tapping outside on Android
    );
  }, [item, deleteProduct, router, isNewItem]);

  // Helper function to save image to local database
  const saveImageToDatabase = async (imageId: string, imageData: any, itemId: string): Promise<void> => {
    try {
      logger.info('ItemDetails', 'Starting database save for image', { imageId, itemId, imageUrl: imageData.url });

      const db = await getDatabase();

      // 1. Save the image to the images table
      logger.info('ItemDetails', 'Inserting image into images table', { imageId });
      await db.runAsync(
        `INSERT OR REPLACE INTO images
         (id, updated_at, version, is_deleted, name, url, caption, type, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          imageId,
          new Date().toISOString(),
          '1',
          0,
          imageData.name || '',
          imageData.url || '',
          imageData.caption || '',
          'IMAGE',
          JSON.stringify({
            name: imageData.name,
            url: imageData.url,
            caption: imageData.caption
          })
        ]
      );
      logger.info('ItemDetails', 'Image inserted into images table successfully', { imageId });

      // 2. Update the item's data to include the image ID
      // First get the current item data
      logger.info('ItemDetails', 'Fetching current item data', { itemId });
      const itemResult = await db.getFirstAsync<{
        id: string;
        data_json: string;
      }>(`SELECT id, data_json FROM catalog_items WHERE id = ?`, [itemId]);

      if (itemResult) {
        logger.info('ItemDetails', 'Found item in database', { itemId, hasDataJson: !!itemResult.data_json });
        const currentData = itemResult.data_json ? JSON.parse(itemResult.data_json) : {};
        const currentImageIds = currentData.image_ids || [];

        logger.info('ItemDetails', 'Current image IDs', { currentImageIds, newImageId: imageId });

        // Add the new image ID if not already present
        if (!currentImageIds.includes(imageId)) {
          const updatedData = {
            ...currentData,
            image_ids: [...currentImageIds, imageId]
          };

          logger.info('ItemDetails', 'Updating item with new image ID', {
            itemId,
            imageId,
            updatedImageIds: updatedData.image_ids
          });

          // Update the item with new image_ids
          await db.runAsync(
            `UPDATE catalog_items SET data_json = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(updatedData), new Date().toISOString(), itemId]
          );

          logger.info('ItemDetails', 'Updated item with new image ID in database', {
            itemId,
            imageId,
            totalImages: updatedData.image_ids.length
          });
        } else {
          logger.info('ItemDetails', 'Image ID already exists in item data', { itemId, imageId });
        }
      } else {
        logger.warn('ItemDetails', 'Item not found in database', { itemId });
        throw new Error(`Item ${itemId} not found in database`);
      }

      logger.info('ItemDetails', 'Image saved to database successfully', { imageId, itemId });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown database error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error('ItemDetails', 'Failed to save image to database', {
        error: errorMessage,
        errorStack,
        imageId,
        itemId,
        fullError: error
      });
      console.error('saveImageToDatabase error:', error);
      throw error;
    }
  };

  // Image management handlers
  const handleImageUpload = async (imageUri: string, imageName: string): Promise<void> => {
    try {
      const realItemId = item.id || 'new-item-temp';
      logger.info('ItemDetails', 'Starting independent image upload', { imageName, itemId: realItemId });

      // Validate inputs
      if (!imageUri || !imageName) {
        throw new Error('Invalid image URI or name');
      }

      // The image service now handles everything: Square upload + database save + item association
      const result = await squareImageService.uploadImage(imageUri, imageName, realItemId);

      if (!result.success) {
        throw new Error(result.error || 'Failed to upload image');
      }

      if (!result.imageId || !result.imageUrl) {
        throw new Error('Upload succeeded but missing image data');
      }

      logger.info('ItemDetails', 'Independent image upload successful', {
        imageId: result.imageId,
        imageUrl: result.imageUrl.substring(0, 50) + '...' // Log partial URL
      });

      // Simply add the image to React state for immediate UI update
      const newImage = {
        id: result.imageId,
        name: imageName,
        url: result.imageUrl, // Use the URL returned by the service
        caption: `Image for ${item.name || 'item'}`
      };

      // Validate current item state before updating
      if (!item) {
        throw new Error('Item state is invalid');
      }

      // Add the image to the current item
      const updatedItem = {
        ...item,
        images: [...(item.images || []), newImage]
      };

      // Use React's functional state update to avoid race conditions
      setItem(prevItem => {
        if (!prevItem) return prevItem;
        return {
          ...prevItem,
          images: [...(prevItem.images || []), newImage]
        };
      });

      // For new items, update originalItem so it has a baseline
      if (isNewItem) {
        setOriginalItem(prevOriginal => {
          if (!prevOriginal) return prevOriginal;
          return {
            ...prevOriginal,
            images: [...(prevOriginal.images || []), newImage]
          };
        });
        // Note: New items will trigger change detection naturally due to other changes
      } else {
        // For existing items, image is already saved independently - no save button needed
        logger.info('ItemDetails', 'Image uploaded and saved independently for existing item', {
          imageId: result.imageId,
          itemId: realItemId,
          note: 'No save button needed - image already persisted'
        });
      }

      logger.info('ItemDetails', 'Image added to React state', {
        imageId: result.imageId,
        imageCount: updatedItem.images.length,
        isNewItem
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ItemDetails', 'Independent image upload failed', {
        error: errorMessage,
        itemId: item?.id || 'unknown',
        imageName,
        fullError: error
      });
      throw error;
    }
  };

  const handleImageMakePrimary = async (imageId: string): Promise<void> => {
    try {
      logger.info('ItemDetails', 'Starting make image primary', { imageId });

      // Reorder the images array to put the selected image first
      const currentImages = [...(item.images || [])];
      const imageIndex = currentImages.findIndex(img => img.id === imageId);

      if (imageIndex === -1) {
        throw new Error('Image not found in current images');
      }

      if (imageIndex === 0) {
        logger.info('ItemDetails', 'Image is already primary', { imageId });
        return; // Already primary
      }

      // Move the selected image to the front
      const [selectedImage] = currentImages.splice(imageIndex, 1);
      const reorderedImages = [selectedImage, ...currentImages];

      // Update the item's image_ids array in the database
      const imageIds = reorderedImages.map(img => img.id);

      // Update the local item state immediately for UI responsiveness
      setItem(prev => ({
        ...prev,
        images: reorderedImages
      }));

      // Update the database with the new image order
      const result = await squareImageService.reorderImages(item.id, imageIds);

      if (!result.success) {
        // Revert the UI change if database update failed
        setItem(prev => ({
          ...prev,
          images: currentImages
        }));
        throw new Error(result.error || 'Failed to reorder images');
      }

      logger.info('ItemDetails', 'Image made primary successfully', { imageId });

      // Mark item as edited since image order was changed
      setIsEdited(true);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ItemDetails', 'Make image primary failed', {
        error: errorMessage,
        imageId,
        itemId: realItemId,
        fullError: error
      });
      throw error;
    }
  };

  const handleImageDelete = async (imageId: string): Promise<void> => {
    try {
      logger.info('ItemDetails', 'Starting image deletion', { imageId });

      const result = await squareImageService.deleteImage(imageId, item.id);

      if (!result.success) {
        throw new Error(result.error || 'Failed to delete image');
      }

      logger.info('ItemDetails', 'Image deletion successful', { imageId });

      // Mark item as edited since image was deleted
      setIsEdited(true);

      // Refresh the item to get updated images
      if (!isNewItem && item.id) {
        const updatedItem = await getProductById(item.id);
        if (updatedItem) {
          setItem(updatedItem);
          // DON'T update originalItem - we want to track the change!
        }
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ItemDetails', 'Image deletion failed', {
        error: errorMessage,
        imageId,
        itemId: realItemId,
        fullError: error
      });
      throw error;
    }
  };

  // Render component for matching text in search results
  const highlightMatchingText = (text: string, query: string) => {
    if (!query) return <Text>{text}</Text>;
    
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    
    return (
      <Text>
        {parts.map((part, index) => 
          part.toLowerCase() === query.toLowerCase() ? (
            <Text key={index} style={styles.highlightedText}>{part}</Text>
          ) : (
            <Text key={index}>{part}</Text>
          )
        )}
      </Text>
    );
  };
  
  // Get the display name for a selected modifier list ID
  const getModifierListName = (modifierId: string): string => {
    return availableModifierLists.find(m => m.id === modifierId)?.name || 'Unknown Modifier';
  };
  
  // Effect to listen for global save triggers from the bottom tab bar
  useEffect(() => {
    if (itemSaveTriggeredAt && itemSaveTriggeredAt !== lastProcessedSaveTrigger.current) {
      lastProcessedSaveTrigger.current = itemSaveTriggeredAt;
      if (isEdited) { // Only save if there are actual changes
        logger.info('ItemDetails', 'Save triggered via bottom tab bar (modal context)', { isNewItem, isEdited });
        const triggerSave = async () => {
            const savedItem = await handleSaveAction();
            if (savedItem) {
                // Use consolidated post-save handler
                handlePostSaveSuccess(savedItem);
            }
        };
        triggerSave();
      } else {
        logger.info('ItemDetails', 'Save trigger via bottom tab bar ignored - no changes (modal context)', { isNewItem, isEdited });
      }
    }
  }, [itemSaveTriggeredAt, isEdited, handleSaveAction, isNewItem, router, handlePostSaveSuccess]);
  
  // Effect to set header buttons and options
  useEffect(() => {
    const screenTitle = isNewItem ? 'New Item' : (item?.name || 'Edit Item');
    navigation.setOptions({
      headerShown: true,
      headerTitle: () => (
        <View style={{ alignItems: 'center' }}>
          <View style={styles.grabber} />
          <Text style={{ fontSize: 17, fontWeight: '600', width: '100%', marginTop: 10, marginBottom: 10 }}>{screenTitle}</Text>
        </View>
      ),
      title: screenTitle, // Keep for accessibility
      headerLeft: () => null,
      headerBackButtonMenuEnabled: false,
      headerRight: () => {
        // Remove all header right buttons for print/save actions
        // If any other headerRight items were needed, they'd go here.
        // For now, returning null to remove them all.
        // An activity indicator for global save triggered by other means might still be useful here,
        // but for direct save/print buttons, loading is handled on the footer buttons.
        // if (isSaving) { // General saving indicator could remain if desired
        //   return <ActivityIndicator size="small" color={lightTheme.colors.primary} style={{ marginRight: Platform.OS === 'ios' ? 15 : 20 }} />;
        // }
        return null; 
      },
    });
  }, [navigation, isNewItem, item?.name, isEdited, router]);



  // NEW: Effect to handle unsaved changes before leaving the screen
  usePreventRemove(
    isEdited,
    ({ data }) => {
      // Show a confirmation modal
      setModalContent({
        title: 'Unsaved Changes',
        actions: [
          {
            label: 'Discard Changes',
            onPress: () => {
              navigation.dispatch(data.action);
            },
            isDestructive: true,
          },
          {
            label: 'Keep Editing',
            onPress: () => setIsActionModalVisible(false),
          },
        ],
      });
      setIsActionModalVisible(true);
    }
  );

  // Navigation is now handled directly in handlePostSaveSuccess to prevent race conditions

  // If loading, show spinner
  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}> 
        <StatusBar style="dark" />
        <View style={styles.loadingContainer}> 
          <ActivityIndicator size="large" color={lightTheme.colors.primary} />
          <Text style={styles.loadingText}>Loading item data...</Text>
        </View>
      </SafeAreaView>
    );
  }
  
  // If loading is done AND we can render content (Removed canRenderContent check)
  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" />

      {/* Error handling: Render error view if error exists */} 
        {error && !isNewItem && ( // Only show full error screen if not new item and error occurs
        <View style={styles.errorContainer}> 
          <Ionicons name="alert-circle-outline" size={48} color="red" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.errorButton} onPress={() => router.back()}>
            <Text style={styles.errorButtonText}>Go Back</Text>
          </TouchableOpacity>
        </View>
      )}

        {/* Main Content: Render ScrollView and Modal if NO error OR if it's a new item (allows form filling even if some dropdown data failed) */} 
        {(!error || isNewItem) && (
        <GestureDetector gesture={panGesture}>
          <View style={{ flex: 1, width: '100%', maxWidth: isTablet ? 800 : '100%' }}>
            <ScrollView 
              style={styles.content}
              keyboardShouldPersistTaps="handled" 
              contentContainerStyle={styles.scrollContentContainer}
            >
            {/* Item Header with Name and Image */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>Item Name</Text>
              <View style={styles.itemHeaderContainer}>
                <View style={styles.nameInputContainer}>
                  <TextInput
                    style={styles.input}
                    value={item.name || ''}
                    onChangeText={value => handleInputChange('name', value)}
                    placeholder="Enter item name"
                    placeholderTextColor="#999"
                  />
                  {(item.name || '').length > 0 && (
                    <TouchableOpacity onPress={() => handleInputChange('name', '')} style={styles.clearButton}>
                      <Ionicons name="close-circle" size={20} color="#ccc" />
                    </TouchableOpacity>
                  )}
                </View>
                <ItemImageDisplay
                  images={item.images || []}
                  itemName={item.name || ''}
                  onImagePress={(image, index) => {
                    // Handle image press - could open full screen view
                    console.log('Image pressed:', image, index);
                  }}
                  onManageImages={() => {
                    // Prevent opening modal while it's closing to avoid state conflicts
                    if (!isImageModalClosing) {
                      logger.info('ItemDetails', 'Opening image management modal');
                      setIsImageManagementVisible(true);
                    } else {
                      logger.warn('ItemDetails', 'Prevented opening image modal while closing');
                    }
                  }}
                  style={styles.itemImage}
                />
              </View>
            </View>

            {/* Variations Section */}
            <View style={styles.fieldContainer}>
              <Text style={styles.sectionHeaderText}>Variations</Text>
              
              {variations.map((variation, index) => (
                <View key={`variation-${index}`} style={styles.variationContainer}>
                  <View style={styles.variationHeader}>
                    <Text style={styles.variationTitle}>Variation {index + 1}</Text>
                    <View style={styles.variationHeaderButtons}>
                      <TouchableOpacity
                        style={styles.inlinePrintButton}
                          onPress={() => initiatePrint(index)} // Direct call to initiatePrint with index
                          disabled={isPrinting} // Disable if any print is ongoing
                      >
                          {isPrinting && printingVariationIndex === index ? (
                            <ActivityIndicator size="small" color={lightTheme.colors.primary} />
                          ) : (
                            <>
                          <Ionicons name="print-outline" size={20} color={lightTheme.colors.primary} style={styles.inlinePrintIcon} />
                        <Text style={styles.inlinePrintButtonText}>Print</Text>
                            </>
                          )}
                      </TouchableOpacity>
                    {variations.length > 1 && (
                      <TouchableOpacity 
                        onPress={() => removeVariation(index)}
                        style={styles.removeVariationButton}
                          disabled={isSaving || isSavingAndPrinting} // Disable during save
                      >
                        <Ionicons name="close-circle" size={22} color="#ff3b30" />
                      </TouchableOpacity>
                    )}
                    </View>
                  </View>

                  {/* Variation Name */}
                  <View style={styles.fieldContainer}>
                    <Text style={styles.subLabel}>Variation Name</Text>
                    <View style={styles.inputWrapper}>
                    <TextInput
                      style={styles.input}
                      value={variation.name || ''}
                      onChangeText={(value) => handleVariationChange(index, 'name', value)}
                      placeholder="e.g., Regular, Large, Blue (optional)"
                      placeholderTextColor="#999"
                    />
                      {(variation.name || '').length > 0 && (
                        <TouchableOpacity onPress={() => handleVariationChange(index, 'name', '')} style={styles.clearButton}>
                          <Ionicons name="close-circle" size={20} color="#ccc" />
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>

                  {/* UPC/Barcode and SKU Row */}
                  <View style={styles.variationRowContainer}>
                    <View style={[styles.fieldContainer, styles.variationRowField]}>
                      <Text style={styles.subLabel}>UPC / Barcode</Text>
                      <View style={styles.inputWrapper}>
                        <TextInput
                          style={styles.input}
                          value={variation.barcode || ''}
                          onChangeText={(value) => handleVariationChange(index, 'barcode', value)}
                          placeholder="Enter UPC or scan barcode"
                          placeholderTextColor="#999"
                          keyboardType="numeric"
                        />
                        {(variation.barcode || '').length > 0 && (
                          <TouchableOpacity onPress={() => handleVariationChange(index, 'barcode', '')} style={styles.clearButton}>
                            <Ionicons name="close-circle" size={20} color="#ccc" />
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>

                    <View style={[styles.fieldContainer, styles.variationRowField]}>
                      <Text style={styles.subLabel}>SKU</Text>
                      <View style={styles.inputWrapper}>
                        <TextInput
                          style={styles.input}
                          value={variation.sku || ''}
                          onChangeText={(value) => handleVariationChange(index, 'sku', value)}
                          placeholder="Enter SKU (optional)"
                          placeholderTextColor="#999"
                          autoCapitalize="characters"
                        />
                        {(variation.sku || '').length > 0 && (
                          <TouchableOpacity onPress={() => handleVariationChange(index, 'sku', '')} style={styles.clearButton}>
                            <Ionicons name="close-circle" size={20} color="#ccc" />
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </View>

                  {/* Price */}
                  <View style={styles.fieldContainer}>
                    <View style={styles.priceHeaderContainer}>
                    <Text style={styles.subLabel}>Price</Text>
                      {vendorUnitCost !== undefined && (
                        <Text style={styles.vendorUnitCostHelper}>
                          Unit Cost: ${vendorUnitCost.toFixed(2)}
                        </Text>
                      )}
                    </View>
                    <View style={styles.priceInputContainer}>
                      <Text style={styles.currencySymbol}>$</Text>
                      <TextInput
                        style={styles.priceInput}
                        value={variation.price !== undefined ? variation.price.toFixed(2) : ''}
                        onChangeText={(value) => handleVariationChange(index, 'price', value)}
                        placeholder="Variable"
                        placeholderTextColor="#999"
                        keyboardType="numeric"
                      />
                      {variation.price !== undefined && (
                        <TouchableOpacity onPress={() => handleVariationChange(index, 'price', undefined)} style={styles.clearButton}>
                          <Ionicons name="close-circle" size={20} color="#ccc" />
                        </TouchableOpacity>
                      )}
                    </View>
                    <Text style={styles.helperText}>Leave blank for variable pricing</Text> 

                    {/* Price Overrides Section */}
                    <View style={{
                      marginTop: 10,
                      borderTopWidth: 1,
                      borderTopColor: '#eeeeee',
                      paddingTop: 8,
                    }}>
                      <View style={{
                        flexDirection: 'row',
                        justifyContent: 'flex-start',
                        marginBottom: 8,
                        alignItems: 'center',
                      }}>
                        <TouchableOpacity 
                            style={styles.addPriceOverrideButton} // Use style from styles.ts
                          onPress={() => addPriceOverride(index)}
                            disabled={availableLocations.length === 0 || isSaving || isSavingAndPrinting} // Disable during save
                        >
                            <Text style={styles.addPriceOverrideButtonText}>Add Price Override</Text>
                        </TouchableOpacity>
                      </View>

                      {/* Render existing price overrides */}
                      {variation.locationOverrides && variation.locationOverrides.map((override, overrideIndex) => (
                          <View key={`override-${index}-${overrideIndex}`} style={styles.priceOverrideItemContainer}>
                            <View style={styles.priceOverrideInputWrapper}>
                            <Text style={styles.currencySymbol}>$</Text>
                            <TextInput
                                style={styles.priceOverrideInput}
                              value={override.price !== undefined ? override.price.toFixed(2) : ''}
                              onChangeText={(value) => updatePriceOverride(index, overrideIndex, 'price', value)}
                                placeholder="Variable"
                              placeholderTextColor="#999"
                              keyboardType="numeric"
                            />
                              {override.price !== undefined && (
                                <TouchableOpacity onPress={() => updatePriceOverride(index, overrideIndex, 'price', undefined)} style={styles.clearButton}>
                                  <Ionicons name="close-circle" size={20} color="#ccc" />
                                </TouchableOpacity>
                              )}
                          </View>

                          {/* Location selector */}
                            <View style={styles.priceOverrideLocationSelectorWrapper}>
                            {availableLocations.length > 0 ? (
                              <>
                              <TouchableOpacity 
                                  style={styles.priceOverrideLocationButton}
                                onPress={() => {
                                      const isExpanded = expandedLocationPicker?.variationIndex === index && expandedLocationPicker?.overrideIndex === overrideIndex;
                                      setExpandedLocationPicker(isExpanded ? null : { variationIndex: index, overrideIndex: overrideIndex });
                                }}
                              >
                                <Text style={[
                                    styles.priceOverrideLocationText,
                                    !override.locationId && styles.priceOverrideLocationPlaceholder
                                ]}>
                                  {override.locationId ? 
                                      (override.locationName || availableLocations.find(loc => loc.id === override.locationId)?.name || 'Select Location') :
                                    'Select Location'}
                                </Text>
                                  <Ionicons name={
                                      expandedLocationPicker?.variationIndex === index && expandedLocationPicker?.overrideIndex === overrideIndex ?
                                      "chevron-up" : "chevron-down"
                                    } size={16} color="#666" />
                              </TouchableOpacity>
                                {expandedLocationPicker?.variationIndex === index && expandedLocationPicker?.overrideIndex === overrideIndex && (
                                  <View style={styles.inlineLocationListContainer}>
                                    <ScrollView nestedScrollEnabled>
                                      {availableLocations.map(location => (
                                        <TouchableOpacity
                                          key={location.id}
                                          style={styles.inlineLocationListItem}
                                          onPress={() => {
                                            updatePriceOverride(index, overrideIndex, 'locationId', location.id);
                                            setExpandedLocationPicker(null); // Close the list
                                          }}
                                        >
                                          <Text style={styles.inlineLocationListItemText}>{location.name}</Text>
                                        </TouchableOpacity>
                                      ))}
                                    </ScrollView>
                                  </View>
                                )}
                              </>
                            ) : (
                                <Text style={styles.noLocationsText}>No locations</Text>
                            )}
                          </View>

                          {/* Remove override button */}
                          <TouchableOpacity 
                              style={styles.removePriceOverrideButton}
                            onPress={() => removePriceOverride(index, overrideIndex)}
                              disabled={isSaving || isSavingAndPrinting}
                          >
                            <Ionicons name="close-circle" size={18} color="#ff3b30" />
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  </View>
                </View>
              ))}
              
              <TouchableOpacity 
                style={styles.addVariationButton}
                onPress={addVariation}
                  disabled={isSaving || isSavingAndPrinting} // Disable during save
              >
                <Ionicons name="add-circle-outline" size={20} color={lightTheme.colors.primary} />
                <Text style={styles.addVariationText}>Add Variation</Text>
              </TouchableOpacity>
            </View>

            {/* Categories */}
            <View style={styles.fieldContainer}>
              <View style={styles.categoryHeaderContainer}>
                <Text style={styles.label}>Categories</Text>
                <TouchableOpacity 
                  style={styles.advancedToggle}
                  onPress={() => setShowMultiCategoryModal(true)}
                  disabled={isSaving || isSavingAndPrinting}
                >
                  <Text style={styles.advancedToggleText}>Advanced</Text>
                  <Ionicons name="grid-outline" size={16} color={lightTheme.colors.primary} />
                </TouchableOpacity>
              </View>
              <TouchableOpacity 
                style={styles.selectorButton} 
                onPress={() => setShowCategoryModal(true)} 
                disabled={isSaving || isSavingAndPrinting}
              >
                <Text style={[styles.selectorText, { flex: 1 }]} numberOfLines={0}>
                  {selectedCategoryDisplayText}
                </Text>
                <Ionicons name="chevron-down" size={20} color="#666" />
              </TouchableOpacity>
              {item.categories && item.categories.length > 1 && (
                <Text style={styles.categorySubtext}>
                  Advanced mode: {item.categories.length} total categories
                </Text>
              )}

              {/* Recent Categories Horizontal List */} 
              <View style={styles.recentCategoriesContainer}>
                {recentCategories.length > 0 && (
                  <>
                    <Text style={styles.recentLabel}>Recent:</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {recentCategories.map((cat) => (
                        <TouchableOpacity
                          key={cat.id}
                          style={styles.recentCategoryChip}
                          onPress={() => handleSelectCategory(cat.id)}
                            disabled={isSaving || isSavingAndPrinting}
                        >
                          <Text style={styles.recentCategoryChipText}>{cat.name}</Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </>
                )}
              </View>
            </View>

            {/* Taxes */}
            <View style={styles.fieldContainer}>
              <View style={styles.sectionHeader}>
                <Text style={styles.label}>Taxes</Text>
                <TouchableOpacity 
                  style={[styles.selectAllButton, allTaxesSelected && styles.selectAllButtonSelected]}
                  onPress={handleSelectAllTaxes}
                    disabled={isSaving || isSavingAndPrinting} // Disable during save
                >
                  <Text style={[styles.selectAllButtonText, allTaxesSelected && styles.selectAllButtonTextSelected]}>
                    {allTaxesSelected ? 'Deselect All' : 'Select All'}
                  </Text>
                </TouchableOpacity>
              </View>
              {availableTaxes.length > 0 ? (
                  availableTaxes.map((tax) => (
                  <TouchableOpacity
                    key={tax.id}
                    style={styles.checkboxContainer}
                    onPress={() => handleTaxSelection(tax.id)}
                    activeOpacity={0.7}
                      disabled={isSaving || isSavingAndPrinting} // Disable during save
                  >
                    <Ionicons
                      name={item.taxIds?.includes(tax.id) ? 'checkbox' : 'square-outline'}
                      size={24}
                      color={item.taxIds?.includes(tax.id) ? lightTheme.colors.primary : '#ccc'}
                      style={styles.checkboxIcon}
                    />
                    <Text style={styles.checkboxLabel}>{tax.name} ({tax.percentage}%)</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.noItemsText}>No applicable taxes found.</Text>
              )}
            </View>

            {/* Modifiers */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>Modifiers</Text>
              {availableModifierLists.length > 0 ? (
                  availableModifierLists.map((modifier) => (
                  <TouchableOpacity
                    key={modifier.id}
                    style={styles.checkboxContainer}
                      onPress={() => handleModifierSelection(modifier.id)}
                    activeOpacity={0.7}
                      disabled={isSaving || isSavingAndPrinting} // Disable during save
                  >
                    <Ionicons
                      name={item.modifierListIds?.includes(modifier.id) ? 'checkbox' : 'square-outline'}
                      size={24}
                      color={item.modifierListIds?.includes(modifier.id) ? lightTheme.colors.primary : '#ccc'}
                      style={styles.checkboxIcon}
                    />
                    <Text style={styles.checkboxLabel}>{modifier.name}</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <Text style={styles.noItemsText}>No modifier lists available.</Text>
              )}
            </View>

            {/* Description */}
            <View style={styles.fieldContainer}>
              <Text style={styles.label}>Description</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                value={item.description || ''}
                onChangeText={(value) => handleInputChange('description', value)}
                placeholder="Enter item description..."
                multiline
              />
            </View>

            <TeamDataSection itemId={realItemId} onSaveRef={teamDataSaveRef} onDataChange={handleTeamDataChange} onVendorUnitCostChange={setVendorUnitCost} isNewItem={isNewItem} />

            {/* History Section - Only for existing items and authenticated users */}
            {!isNewItem && (
              <View style={styles.fieldContainer}>
                {user?.signInDetails?.loginId ? (
                  <ItemHistorySection itemId={id} itemName={item.name || undefined} />
                ) : (
                  <View style={styles.historyAuthPrompt}>
                    <Text style={styles.historyAuthPromptTitle}>Item History</Text>
                    <Text style={styles.historyAuthPromptText}>
                      Sign in to view item change history and track modifications.
                    </Text>
                  </View>
                )}
              </View>
            )}

              {/* Delete Button - Only for existing items */}
              {!isNewItem && (
                <View style={styles.deleteButtonContainer}>
                <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
                    <Text style={styles.deleteButtonText}>Delete Item</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Spacer to push delete button to the bottom / general spacing */}
              <View style={{ height: Platform.OS === 'ios' ? 80 : 100 }} /> 
          </ScrollView>

            {/* Fixed Footer Button Container */}
            <View style={[styles.footerContainer, { paddingBottom: isTablet ? 20 : 10 }]}>
              {/* Close Button */}
              <TouchableOpacity
                style={[styles.footerButton, styles.footerButtonClose, { flex: 1, justifyContent: 'center', alignItems: 'center' }]}
                onPress={handleFooterCancel}
                disabled={isSaving || isPrinting || isSavingAndPrinting}
              >
                <Ionicons name="close-outline" size={22} color={lightTheme.colors.text} style={styles.footerButtonIcon} />
                <Text style={styles.footerButtonText}>Close</Text>
              </TouchableOpacity>

              {/* Print Button */}
              <TouchableOpacity
                style={[styles.footerButton, { flex: 1, justifyContent: 'center', alignItems: 'center' }]}
                onPress={() => openActionModal('print')}
                disabled={isPrinting || isSaving || isSavingAndPrinting}
              >
                {(isPrinting && !isSavingAndPrinting) ? (
                  <ActivityIndicator size="small" color={lightTheme.colors.primary} />
                ) : (
                  <>
                    <Ionicons name="print-outline" size={22} color={lightTheme.colors.primary} style={styles.footerButtonIcon} />
                    <Text style={[styles.footerButtonText, { color: lightTheme.colors.primary }]}>Print</Text>
                  </>
                )}
              </TouchableOpacity>

              {/* Save Button */}
              <TouchableOpacity
                style={[styles.footerButton, styles.footerButtonSave, { flex: 1 }]}
                onPress={async () => {
                  const savedItem = await handleSaveAction();
                  if (savedItem) {
                      // Use consolidated post-save handler
                      handlePostSaveSuccess(savedItem);
                  }
                }}
                disabled={isSaving || isPrinting || isSavingAndPrinting || !isEdited} 
              >
                {(isSaving && !isPrinting && !isSavingAndPrinting) ? (
                  <ActivityIndicator 
                    size="small" 
                    color={(isEdited ? lightTheme.colors.primary : lightTheme.colors.border)} 
                    style={styles.footerButtonIcon} 
                  />
                ) : (
                  <Ionicons 
                    name="save-outline" 
                    size={22} 
                    color={(isEdited ? lightTheme.colors.primary : lightTheme.colors.border)} 
                    style={styles.footerButtonIcon} 
                  />
                )}
                <Text style={[
                  styles.footerButtonText, 
                  { color: (isEdited ? lightTheme.colors.primary : lightTheme.colors.border) } 
                ]}>Save</Text>
              </TouchableOpacity>

              {/* Save & Print Button */}
              <TouchableOpacity
                style={[styles.footerButton, { flex: 1, justifyContent: 'center', alignItems: 'center' }]}
                onPress={() => openActionModal('save_and_print')}
                disabled={isSavingAndPrinting || isSaving || isPrinting || !isEdited}
              >
                {isSavingAndPrinting ? (
                  <ActivityIndicator 
                    size="small" 
                    color={(isEdited ? lightTheme.colors.primary : lightTheme.colors.border)}
                  />
                ) : (
                  <>
                    <Ionicons 
                      name="document-text-outline" 
                      size={22} 
                      color={(isEdited ? lightTheme.colors.primary : lightTheme.colors.border)} 
                      style={styles.footerButtonIcon} 
                    />
                    <Text style={[
                      styles.footerButtonText, 
                      { color: (isEdited ? lightTheme.colors.primary : lightTheme.colors.border) }
                    ]}>Save & Print</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>

          {/* FINALLY a CORRECT Category Selection Modal - Centered Pop-up with Slide Animation */}
          <Modal
            animationType="fade"
            transparent={true}
            visible={showCategoryModal}
            onRequestClose={() => {
              setShowCategoryModal(false);
              setCategorySearch('');
            }}
          >
            <Pressable
              style={styles.categoryModalContainer}
              onPress={() => {
              setShowCategoryModal(false);
              setCategorySearch('');
              }}
            >
                  <KeyboardAvoidingView 
                    behavior={Platform.OS === "ios" ? "padding" : "height"} 
                    style={{ width: '100%', alignItems: 'center' }} 
                    keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
                  >
                <TouchableWithoutFeedback>
                    <View style={styles.categoryModalContent}>
                      <Text style={styles.categoryModalTitle}>Select Reporting Category</Text>
                      <View style={styles.categoryModalSearchInputWrapper}>
                        <TextInput
                            style={styles.categoryModalSearchInput}
                            placeholder="Search categories..."
                            placeholderTextColor="#999"
                            value={categorySearch}
                            onChangeText={setCategorySearch}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoFocus
                        />
                        {categorySearch.length > 0 && (
                          <TouchableOpacity onPress={() => setCategorySearch('')} style={styles.clearButton}>
                            <Ionicons name="close-circle" size={20} color="#ccc" />
                          </TouchableOpacity>
                        )}
                      </View>
                      <View style={styles.categoryModalListContainer}>
                      <FlatList
                          data={filteredCategories}
                          keyExtractor={(cat) => cat.id}
                          renderItem={({ item: cat }) => (
                              <TouchableOpacity 
                                  style={styles.categoryModalItem}
                                  onPress={() => handleSelectCategory(cat.id)}
                              >
                                  <Text 
                                      style={[
                                          styles.categoryModalItemText,
                                          (cat.id === item.reporting_category_id) && styles.categoryModalItemTextSelected 
                                      ]}
                                  >
                                      {cat.name}
                                  </Text>
                              </TouchableOpacity>
                          )}
                          ListEmptyComponent={() => (
                              <View style={styles.categoryModalEmpty}>
                                  <Text style={styles.categoryModalEmptyText}>No categories match "{categorySearch}"</Text>
                              </View>
                          )}
                      />
                      </View>
                      <View style={styles.categoryModalFooter}>
                          <TouchableOpacity 
                              style={[styles.categoryModalButton, styles.categoryModalClearButton]} 
                              onPress={() => handleSelectCategory(null)}
                          >
                              <Text style={[styles.categoryModalButtonText, styles.categoryModalClearButtonText]}>Clear Selection</Text>
                          </TouchableOpacity>
                          <TouchableOpacity 
                              style={[styles.categoryModalButton, styles.categoryModalCloseButton]} 
                              onPress={() => {
                                  setShowCategoryModal(false);
                                  setCategorySearch('');
                              }}
                          >
                              <Text style={styles.categoryModalButtonText}>Close</Text>
                          </TouchableOpacity>
                      </View>
                    </View>
                </TouchableWithoutFeedback>
              </KeyboardAvoidingView>
            </Pressable>
          </Modal>

            {/* Print Notification Modal - Replaced with SystemModal */}
            <SystemModal
            visible={showPrintNotification}
              onClose={() => setShowPrintNotification(false)}
            message={printNotificationMessage}
            type={printNotificationType}
              position="top"
              autoClose={true}
              autoCloseTime={2000}
            />

            {/* Multi-Category Selection Modal */}
            <MultiCategorySelectionModal
              visible={showMultiCategoryModal}
              onClose={() => setShowMultiCategoryModal(false)}
              availableCategories={availableCategories}
              selectedCategories={item.categories || []}
              reportingCategoryId={item.reporting_category_id}
              onSave={handleMultiCategorySelection}
            />
            
            {/* ACTION MODAL */}
            <Modal
              animationType="slide"
              transparent={true}
              visible={isActionModalVisible}
              onRequestClose={() => setIsActionModalVisible(false)}
            >
              <TouchableWithoutFeedback onPress={() => setIsActionModalVisible(false)}>
                <View style={modalStyles.modalOverlay}>
                  <TouchableWithoutFeedback>
                    <View style={modalStyles.modalContentContainer}>
                      {modalContent && (
                        <>
                          <Text style={modalStyles.modalTitle}>{modalContent.title}</Text>
                          <ScrollView>
                            {modalContent.actions.map((action, index) => (
                              <TouchableOpacity
                                key={index}
                                style={modalStyles.modalButton}
                                onPress={action.onPress}
                              >
                                <Text style={[
                                  modalStyles.modalButtonText,
                                  action.isDestructive && modalStyles.modalButtonDestructiveText
                                ]}>
                                  {action.label}
                                </Text>
                              </TouchableOpacity>
                            ))}
                          </ScrollView>
                        </>
                      )}
                      <TouchableOpacity
                        style={[modalStyles.modalButton, modalStyles.modalCancelButton]}
                        onPress={() => setIsActionModalVisible(false)}
                      >
                        <Text style={modalStyles.modalCancelButtonText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  </TouchableWithoutFeedback>
                </View>
              </TouchableWithoutFeedback>
            </Modal>

            {/* Image Management Modal */}
            <ImageManagementModal
              visible={isImageManagementVisible}
              onClose={() => {
                logger.info('ItemDetails', 'Closing image management modal');
                setIsImageModalClosing(true);
                setIsImageManagementVisible(false);

                // Reset closing state after modal animation completes
                setTimeout(() => {
                  setIsImageModalClosing(false);
                  logger.debug('ItemDetails', 'Image modal closing state reset');
                }, 300); // Standard modal animation time
              }}
              images={item.images || []}
              itemId={item.id}
              itemName={item.name || ''}
              onImageUpload={handleImageUpload}
              onImageMakePrimary={handleImageMakePrimary}
              onImageDelete={handleImageDelete}
            />
        </View>
      </GestureDetector>
      )}
    </SafeAreaView>
  );
}

const modalStyles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'transparent',
    alignItems: 'center',
    //backgroundColor: 'rgba(255, 0, 0, 0.2)', // temporary
  },
  modalContentContainer: {
    backgroundColor: lightTheme.colors.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 10, // For bottom safe area
    maxHeight: '40%',
    width: '60%',
    //backgroundColor: 'rgba(0, 0, 255, 0.2)', // temporary
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: lightTheme.colors.text,
    textAlign: 'center',
    marginBottom: 15,
  },
  modalButton: {
    backgroundColor: lightTheme.colors.card,
    borderRadius: 14,
    paddingVertical: 16,
    marginBottom: 10,
    alignItems: 'center',
    //backgroundColor: 'rgba(0, 255, 0, 0.4)', // temporary
  },
  modalButtonText: {
    fontSize: 17,
    fontWeight: '500',
    color: lightTheme.colors.primary,
  },
  modalButtonDestructiveText: {
    color: '#FF3B30',
  },
  modalCancelButton: {
    backgroundColor: '#FF3B30',
  },
  modalCancelButtonText: {
    fontSize: 17,
    fontWeight: '500',
    color: '#FFFFFF', // white text
  },
});