import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  FlatList,
  ActivityIndicator,
  SafeAreaView,
  Modal,
  Alert,
  ScrollView,
  Animated,
  RefreshControl,
  Vibration
} from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Swipeable from 'react-native-gesture-handler/Swipeable';
import { useCatalogItems } from '../../src/hooks/useCatalogItems';
import { BarcodeScanner } from '../../src/components/BarcodeScanner';
import * as modernDb from '../../src/database/modernDb';
import { ConvertedItem } from '../../src/types/api';
import logger from '../../src/utils/logger';
import { reorderStyles } from '../../src/styles/_reorderStyles';
import { reorderService, ReorderItem as ServiceReorderItem, DisplayReorderItem } from '../../src/services/reorderService';
import crossReferenceService from '../../src/services/crossReferenceService';
import { generateClient } from 'aws-amplify/api';
import { useAuthenticator } from '@aws-amplify/ui-react-native';
import { useAppStore } from '../../src/store';
import CachedImage from '../../src/components/CachedImage';
import ImageOverlay from '../../src/components/ImageOverlay';
import ReorderGridItem from '../../src/components/ReorderGridItem';
import { imageCacheService } from '../../src/services/imageCacheService';

const client = generateClient();

// Types for reorder functionality - use the service type
type ReorderItem = ServiceReorderItem & {
  isCustom?: boolean;
  notes?: string;
};

// Add interface for custom item being edited
interface CustomItemEdit {
  id: string;
  itemName: string;
  itemCategory: string;
  vendor: string;
  quantity: number;
  notes: string;
}

interface QuantityModalProps {
  visible: boolean;
  item: DisplayReorderItem | null;
  onSubmit: (quantity: number) => void;
  onCancel: () => void;
}

interface ItemSelectionModalProps {
  visible: boolean;
  items: ConvertedItem[];
  onSelect: (item: ConvertedItem) => void;
  onCancel: () => void;
}

type FilterType = 'completed' | 'incomplete' | 'category' | 'vendor' | 'sortConfig';

const TAG = '[ReordersScreen]';

// Static styles to prevent recreation on every render
const staticStyles = {
  headerLeftContainer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    marginLeft: 8
  },
  headerRightContainer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const
  },
  pendingBadge: {
    backgroundColor: '#FF9500',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    marginLeft: 4
  },
  filterScrollContainer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  filterScrollStyle: {
    marginBottom: 8,
    paddingLeft: 16
  },
  modalOverlayStyle: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
    padding: 20
  },
  listContainerPadding: {
    paddingBottom: 20
  },
  dropdownOverlay: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'transparent',
    zIndex: 999,
  },
  dropdownContainer: {
    position: 'absolute' as const,
    top: 120,
    left: 16,
    right: 16,
    backgroundColor: '#fff',
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 12,
    zIndex: 1000,
    minHeight: 300,
    maxHeight: 400,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  dropdownHeader: {
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    backgroundColor: '#f8f9fa',
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
  },
  dropdownHeaderText: {
    fontSize: 16,
    fontWeight: '600' as const,
    color: '#333',
    textAlign: 'center' as const
  },
  configDropdownContent: {
    padding: 12
  },
  configToggleButton: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  configToggleButtonLast: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingVertical: 12,
  },
  configToggleText: {
    fontSize: 15,
    color: '#333',
    fontWeight: '400' as const,
  },
  configToggleIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center' as const,
    alignItems: 'center' as const,
  },
  configHelpText: {
    fontSize: 12,
    color: '#666',
    fontStyle: 'italic' as const,
    marginTop: 8,
    textAlign: 'center' as const,
  },
  swipeDeleteContainer: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'flex-end' as const,
    paddingRight: 16,
  },
  swipeReceivedContainer: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'flex-start' as const,
    paddingLeft: 16,
  },
  dropdownScrollView: {
    flex: 1,
    maxHeight: 320
  },
  customItemContainer: {
    borderColor: '#007AFF',
    borderWidth: 2
  },
  customItemIndexContainer: {
    backgroundColor: '#007AFF'
  },
  customItemNameInput: {
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    paddingBottom: 4
  },
  customItemRowContainer: {
    flexDirection: 'row' as const,
    gap: 8,
    marginTop: 8
  },
  customItemFieldInput: {
    flex: 1,
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    paddingBottom: 2,
    fontSize: 12
  },
  customItemQtyInput: {
    borderBottomWidth: 1,
    borderBottomColor: '#ddd',
    textAlign: 'center' as const,
    minWidth: 40
  },
  customItemActionsContainer: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const
  },
  customItemCancelButton: {
    backgroundColor: '#ff3b30',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6
  },
  customItemSaveButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6
  },
  customItemButtonText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600' as const
  },
  itemDetailsContainer: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    flexWrap: 'wrap' as const,
    marginTop: 2
  }
};

// Quantity Modal Component - now for manual editing only
const QuantityModal: React.FC<QuantityModalProps & { quantity: string; setQuantity: (qty: string) => void }> = ({ 
  visible, 
  item, 
  onSubmit, 
  onCancel, 
  quantity, 
  setQuantity 
}) => {
  const [isFirstInput, setIsFirstInput] = useState(true);

  // Reset quantity when modal opens with current item quantity
  useEffect(() => {
    if (visible && item) {
      setQuantity(item.quantity.toString());
      setIsFirstInput(true); // Mark that the next input should overwrite
    }
  }, [visible, item, setQuantity]);

  const handleKeypadPress = (value: string) => {
    if (value === 'backspace') {
      setQuantity(quantity.length > 1 ? quantity.slice(0, -1) : '1');
      setIsFirstInput(false);
    } else if (value === 'reset') {
      setQuantity('1');
      setIsFirstInput(false);
    } else {
      // First digit after opening modal overwrites existing value, subsequent digits append
      const newValue = isFirstInput ? value : quantity + value;
      setQuantity(parseInt(newValue) > 999 ? quantity : newValue);
      setIsFirstInput(false);
    }
  };

  const handleSubmit = () => {
    const qty = parseInt(quantity);
    // Allow 0 for deletion, but default to 1 for invalid input
    const finalQty = isNaN(qty) ? 1 : qty;
    onSubmit(finalQty);
  };

  const keypadButtons = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['reset', '0', 'backspace']
  ];

  return (
    <Modal visible={visible} transparent animationType="none">
      <View style={reorderStyles.modalOverlay}>
        <View style={reorderStyles.modalContainer}>
          <View style={reorderStyles.modalHeader}>
            <Text style={reorderStyles.modalTitle}>Edit Quantity</Text>
            <Text style={reorderStyles.modalItemName} numberOfLines={2}>
              {item?.itemName || 'Unknown Item'}
            </Text>
          </View>

          <View style={reorderStyles.quantityContainer}>
            <Text style={reorderStyles.quantityDisplay}>{quantity}</Text>
            
            <View style={reorderStyles.keypadContainer}>
              {keypadButtons.map((row, rowIndex) => (
                <View key={rowIndex} style={reorderStyles.keypadRow}>
                  {row.map((button) => (
                    <Pressable
                      key={button}
                      style={[
                        reorderStyles.keypadButton,
                        (button === 'reset' || button === 'backspace') && reorderStyles.keypadButtonSpecial
                      ]}
                      onPress={() => handleKeypadPress(button)}
                    >
                      {button === 'backspace' ? (
                        <Ionicons name="backspace-outline" size={20} color="#fff" />
                      ) : button === 'reset' ? (
                        <Text style={reorderStyles.keypadButtonSpecialText}>Reset</Text>
                      ) : (
                        <Text style={reorderStyles.keypadButtonText}>{button}</Text>
                      )}
                    </Pressable>
                  ))}
                </View>
              ))}
            </View>
          </View>

          <View style={reorderStyles.modalActions}>
            <Pressable
              style={[reorderStyles.modalButton, reorderStyles.modalButtonSecondary]}
              onPress={onCancel}
            >
              <Text style={[reorderStyles.modalButtonText, reorderStyles.modalButtonTextSecondary]}>
                Cancel
              </Text>
            </Pressable>
            
            <Pressable
              style={[reorderStyles.modalButton, reorderStyles.modalButtonPrimary]}
              onPress={handleSubmit}
            >
              <Text style={[reorderStyles.modalButtonText, reorderStyles.modalButtonTextPrimary]}>
                Submit
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// Item Selection Modal Component
const ItemSelectionModal: React.FC<ItemSelectionModalProps> = ({ visible, items, onSelect, onCancel }) => {
  return (
    <Modal visible={visible} transparent animationType="none">
      <View style={reorderStyles.modalOverlay}>
        <View style={reorderStyles.modalContainer}>
          <View style={reorderStyles.modalHeader}>
            <Text style={reorderStyles.modalTitle}>Multiple Items Found</Text>
            <Text style={reorderStyles.modalItemName}>
              Select the item you want to reorder:
            </Text>
          </View>

          <ScrollView style={reorderStyles.selectionList}>
            {items.map((item, index) => (
              <Pressable
                key={item.id}
                style={[
                  reorderStyles.selectionItem,
                  index === items.length - 1 && reorderStyles.selectionItemLast
                ]}
                onPress={() => onSelect(item)}
              >
                <Text style={reorderStyles.selectionItemName}>{item.name}</Text>
                <Text style={reorderStyles.selectionItemDetails}>
                  {item.category} • ${item.price} • {item.barcode}
                </Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={reorderStyles.modalActions}>
            <Pressable
              style={[reorderStyles.modalButton, reorderStyles.modalButtonSecondary]}
              onPress={onCancel}
            >
              <Text style={[reorderStyles.modalButtonText, reorderStyles.modalButtonTextSecondary]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// Render multi-select dropdown for categories
const renderCategoryDropdown = (
  items: Array<{ name: string; count: number }>,
  selectedValues: string[],
  onSelect: (values: string[]) => void,
  placeholder: string
) => {
  const toggleCategory = (categoryName: string) => {
    const isSelected = selectedValues.includes(categoryName);
    if (isSelected) {
      onSelect(selectedValues.filter(cat => cat !== categoryName));
    } else {
      onSelect([...selectedValues, categoryName]);
    }
  };

  const clearAll = () => {
    onSelect([]);
  };

  return (
    <ScrollView style={staticStyles.dropdownScrollView} showsVerticalScrollIndicator={false}>
      <Pressable
        style={{
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: '#f0f0f0',
          backgroundColor: selectedValues.length === 0 ? '#f0f8ff' : 'transparent',
        }}
        onPress={clearAll}
      >
        <Text style={{
          fontSize: 15,
          color: selectedValues.length === 0 ? '#007AFF' : '#333',
          fontWeight: selectedValues.length === 0 ? '600' : '400',
        }}        >
          All Categories
        </Text>
      </Pressable>
      {selectedValues.length > 0 && (
        <Pressable
          style={{
            paddingHorizontal: 20,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: '#f0f0f0',
            backgroundColor: '#fff5f5',
          }}
          onPress={clearAll}
        >
          <Text style={{
            fontSize: 14,
            color: '#ff3b30',
            fontWeight: '600',
            textAlign: 'center',
          }}>
            Clear All ({selectedValues.length} selected)
          </Text>
        </Pressable>
      )}
      {items.length === 0 ? (
        <View style={{
          paddingHorizontal: 20,
          paddingVertical: 20,
          alignItems: 'center',
        }}>
          <Text style={{
            fontSize: 14,
            color: '#999',
            fontStyle: 'italic',
          }}>
            No categories available
          </Text>
        </View>
      ) : (
        items.map((item, index) => {
          const isSelected = selectedValues.includes(item.name);
          return (
            <Pressable
              key={`${item.name}-${index}`}
              style={{
                paddingHorizontal: 20,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: '#f0f0f0',
                backgroundColor: isSelected ? '#f0f8ff' : 'transparent',
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
              onPress={() => toggleCategory(item.name)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <View style={{
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  borderWidth: 2,
                  borderColor: isSelected ? '#007AFF' : '#ccc',
                  backgroundColor: isSelected ? '#007AFF' : 'transparent',
                  marginRight: 12,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}>
                  {isSelected && (
                    <Ionicons name="checkmark" size={12} color="#fff" />
                  )}
                </View>
                <Text style={{
                  fontSize: 15,
                  color: '#333',
                  fontWeight: '400',
                  flex: 1,
                }}>
                  {item.name}
                </Text>
              </View>
              <View style={{
                backgroundColor: isSelected ? '#007AFF' : '#e0e0e0',
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 12,
                minWidth: 24,
                alignItems: 'center',
              }}>
                <Text style={{
                  fontSize: 12,
                  color: isSelected ? '#fff' : '#666',
                  fontWeight: '600',
                }}>
                  {item.count}
                </Text>
              </View>
            </Pressable>
          );
        })
      )}
    </ScrollView>
  );
};

// Render dropdown for vendor filters
const renderDropdown = (
  items: Array<{ name: string; count: number }>,
  selectedValue: string | null,
  onSelect: (value: string | null) => void,
  placeholder: string
) => {
  return (
    <ScrollView style={staticStyles.dropdownScrollView} showsVerticalScrollIndicator={false}>
      <Pressable
        style={{
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderBottomWidth: 1,
          borderBottomColor: '#f0f0f0',
          backgroundColor: !selectedValue ? '#f0f8ff' : 'transparent',
        }}
        onPress={() => onSelect(null)}
      >
        <Text style={{
          fontSize: 15,
          color: !selectedValue ? '#007AFF' : '#333',
          fontWeight: !selectedValue ? '600' : '400',
        }}>
          All {placeholder}
        </Text>
      </Pressable>
      {items.length === 0 ? (
        <View style={{
          paddingHorizontal: 20,
          paddingVertical: 20,
          alignItems: 'center',
        }}>
          <Text style={{
            fontSize: 14,
            color: '#999',
            fontStyle: 'italic',
          }}>
            No {placeholder.toLowerCase()} available
          </Text>
        </View>
      ) : (
        items.map((item, index) => (
          <Pressable
            key={`${item.name}-${index}`}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: '#f0f0f0',
              backgroundColor: selectedValue === item.name ? '#f0f8ff' : 'transparent',
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
            onPress={() => onSelect(item.name)}
          >
            <Text style={{
              fontSize: 15,
              color: selectedValue === item.name ? '#007AFF' : '#333',
              fontWeight: selectedValue === item.name ? '600' : '400',
              flex: 1,
            }}>
              {item.name}
            </Text>
            <View style={{
              backgroundColor: selectedValue === item.name ? '#007AFF' : '#e0e0e0',
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 12,
              minWidth: 24,
              alignItems: 'center',
            }}>
              <Text style={{
                fontSize: 12,
                color: selectedValue === item.name ? '#fff' : '#666',
                fontWeight: '600',
              }}>
                {item.count}
              </Text>
            </View>
          </Pressable>
        ))
      )}
    </ScrollView>
  );
};

const ReordersScreen = React.memo(() => {
  const router = useRouter();
  const { products: catalogItems, isProductsLoading: loading } = useCatalogItems();
  
  // State management
  const [reorderItems, setReorderItems] = useState<DisplayReorderItem[]>([]);
  const [currentFilter, setCurrentFilter] = useState<FilterType | null>(null);
  const [showQuantityModal, setShowQuantityModal] = useState(false);
  const [showSelectionModal, setShowSelectionModal] = useState(false);
  const [currentEditingItem, setCurrentEditingItem] = useState<DisplayReorderItem | null>(null);
  const [multipleItems, setMultipleItems] = useState<ConvertedItem[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [showImageOverlay, setShowImageOverlay] = useState(false);
  const [selectedImageUrl, setSelectedImageUrl] = useState('');
  const [selectedItemInfo, setSelectedItemInfo] = useState<any>(null);
  const [viewMode, setViewMode] = useState<'list' | 'large-grid' | 'medium-grid' | 'small-grid'>('list');
  const [isScreenFocused, setIsScreenFocused] = useState(true);

  // Track last scanned item for smart increment logic
  const [lastScannedItemId, setLastScannedItemId] = useState<string | null>(null);
  
  // Quantity modal state - for manual editing only
  const [modalQuantity, setModalQuantity] = useState('1');
  
  // Custom item states
  const [showAddCustomItem, setShowAddCustomItem] = useState(false);
  const [editingCustomItem, setEditingCustomItem] = useState<string | null>(null);
  const [customItemEdit, setCustomItemEdit] = useState<CustomItemEdit | null>(null);
  
  // Sync status state
  const [syncStatus, setSyncStatus] = useState({ isOnline: false, pendingCount: 0, isAuthenticated: false });
  const [showSyncStatusPopover, setShowSyncStatusPopover] = useState(false);

  // List maintenance expanded state
  const [showMaintenanceButtons, setShowMaintenanceButtons] = useState(false);

  // Track swipe state to prevent tap conflicts
  const [swipingItemId, setSwipingItemId] = useState<string | null>(null);
  
  // State for filters and sorting
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showVendorDropdown, setShowVendorDropdown] = useState(false);
  const [showConfigDropdown, setShowConfigDropdown] = useState(false);
  const [sectionByCategory, setSectionByCategory] = useState(false);
  const [sectionByVendor, setSectionByVendor] = useState(false);
  const [sortState, setSortState] = useState<{
    chronological: 'off' | 'desc' | 'asc';
    alphabetical: 'off' | 'desc' | 'asc';
  }>({
    chronological: 'desc', // Default to most recent first
    alphabetical: 'off'
  });

  // Get authenticated user information
  const { user } = useAuthenticator((context) => [context.user]);
  
  // Get 12-hour format setting from store
  const use12HourFormat = useAppStore((state) => state.use12HourFormat);

  // Listen for add custom item trigger from tab bar
  const addCustomItemTriggeredAt = useAppStore((state) => state.addCustomItemTriggeredAt);
  const setCategories = useAppStore((state) => state.setCategories);
  const lastTriggeredAtRef = useRef<number | null>(null);

  // Load categories from local database into store so useCatalogItems can use them
  useEffect(() => {
    const loadCategories = async () => {
      try {
        const categoriesFromDb = await modernDb.getAllCategories();
        const formattedCategories = categoriesFromDb.map(cat => ({
          id: cat.id,
          name: cat.name,
          color: '#007AFF',
          isActive: true,
          createdAt: '',
          updatedAt: ''
        }));
        setCategories(formattedCategories);
        logger.info(TAG, `Loaded ${categoriesFromDb.length} categories into store for category name resolution`);
      } catch (error) {
        logger.error(TAG, 'Failed to load categories', { error });
      }
    };
    loadCategories();
  }, [setCategories]);
  
  useEffect(() => {
    if (addCustomItemTriggeredAt && addCustomItemTriggeredAt !== lastTriggeredAtRef.current) {
      lastTriggeredAtRef.current = addCustomItemTriggeredAt;
      handleAddCustomItem();
    }
  }, [addCustomItemTriggeredAt]);

  const { performSearch, isSearching, searchError } = useCatalogItems();

  // Scanner ref no longer needed for fluid scanning
  
  // Audio/Haptic feedback for scan results
  const playSuccessSound = useCallback(() => {
    console.log('🔊 SUCCESS - Item found!');
    logger.info(TAG, 'Playing success feedback');
    // Single short vibration for success
    Vibration.vibrate(100);
  }, []);

  const playErrorSound = useCallback(() => {
    console.log('🔊 ERROR - Scan failed!');  
    logger.info(TAG, 'Playing error feedback');
    // Double vibration pattern for error
    Vibration.vibrate([0, 200, 100, 200]);
  }, []);

  // Handle barcode scan - new fluid scanning logic
  const handleBarcodeScan = useCallback(async (barcode: string) => {
    logger.info(TAG, `🔍 FLUID SCAN: "${barcode}"`);
    
    // If error modal is open, dismiss it with any new scan
    if (showErrorModal) {
      setShowErrorModal(false);
      setErrorMessage('');
    }
    
    // Search for items with matching barcode (including case UPC)
    try {
      const searchFilters = {
        name: false,
        sku: false,
        barcode: true, // Search by regular barcode AND case UPC
        category: false
      };

      const matchingItems = await performSearch(barcode, searchFilters);

    if (matchingItems.length === 0) {
        // ERROR CASE: No item found in database - play error sound & show modal
        playErrorSound();
        setErrorMessage(`No item found with barcode: ${barcode}\n\nPlease create the item in the main scan page first.`);
        setShowErrorModal(true);
      return;
    }

    if (matchingItems.length === 1) {
        // Single item found - implement additive scanning logic
        const foundItem = matchingItems[0];
        
        // Convert SearchResultItem to ConvertedItem
        const convertedItem: ConvertedItem = {
          id: foundItem.id,
          name: foundItem.name || '',
          sku: foundItem.sku,
          barcode: foundItem.barcode,
          price: foundItem.price,
          category: foundItem.category,
          categoryId: foundItem.categoryId,
          reporting_category_id: foundItem.categoryId || foundItem.reporting_category_id,
          description: foundItem.description,
          isActive: true,
          images: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        
        // Check if item already exists in reorder list
        const existingItem = reorderItems.find(item => item.itemId === convertedItem.id);

        if (existingItem) {
          // SMART SCANNING LOGIC: Check if item is at top of CHRONOLOGICAL order (behind the scenes)
          // Sort items chronologically to determine actual position regardless of GUI filters
          const chronologicalItems = [...reorderItems].sort((a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
          const chronologicalIndex = chronologicalItems.findIndex(item => item.itemId === convertedItem.id);
          const isAtTopChronologically = chronologicalIndex === 0;

          if (isAtTopChronologically && existingItem.status === 'incomplete') {
            // CASE 1: Item at chronological top scanned again - increment quantity by 1
            logger.info(TAG, `📈 CHRONOLOGICAL TOP REPEAT SCAN: ${convertedItem.name} (${existingItem.quantity} → ${existingItem.quantity + 1})`);

            try {
              let teamData: any = undefined;
              try {
                teamData = await reorderService.fetchTeamData(convertedItem.id);
              } catch (teamDataError) {
                logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
              }

              const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
              const newQuantity = existingItem.quantity + 1;

              // Use overwrite mode with incremented quantity
              const success = await reorderService.addItem(convertedItem, newQuantity, teamData, userName, true);

              if (success) {
                playSuccessSound();
                setLastScannedItemId(convertedItem.id);
                logger.info(TAG, `✅ Incremented chronologically top item: ${convertedItem.name} to qty ${newQuantity}`);
              } else {
                throw new Error('Failed to increment item');
              }
            } catch (error) {
              logger.error(TAG, 'Error incrementing item', { error });
              playErrorSound();
              setErrorMessage('Failed to increment item quantity. Please try again.');
              setShowErrorModal(true);
            }
          } else if (existingItem.status === 'complete') {
            // CASE 2: Completed item scanned - mark as "Received" and create new incomplete entry
            logger.info(TAG, `📦 COMPLETED ITEM RESCAN: ${convertedItem.name} - marking as Received and creating new entry`);

            try {
              let teamData: any = undefined;
              try {
                teamData = await reorderService.fetchTeamData(convertedItem.id);
              } catch (teamDataError) {
                logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
              }

              const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';

              // Step 1: Mark the existing completed item as "Received"
              const receivedSuccess = await reorderService.markAsReceived(existingItem.id, userName);

              if (!receivedSuccess) {
                throw new Error('Failed to mark item as received');
              }

              // Step 2: Create a new incomplete entry at the top with fresh timestamp
              const newEntrySuccess = await reorderService.addItem(convertedItem, 1, teamData, userName, true);

              if (newEntrySuccess) {
                playSuccessSound();
                setLastScannedItemId(convertedItem.id);
                logger.info(TAG, `✅ Completed → Received workflow: ${convertedItem.name} (marked as Received, new incomplete entry created)`);
              } else {
                throw new Error('Failed to create new incomplete entry');
              }
            } catch (error) {
              logger.error(TAG, 'Error in completed → received workflow', { error });
              playErrorSound();
              setErrorMessage('Failed to process completed item. Please try again.');
              setShowErrorModal(true);
            }
          } else {
            // CASE 3: Existing incomplete item (not at chronological top) - move to chronological top
            logger.info(TAG, `⬆️ MOVE TO CHRONOLOGICAL TOP: ${convertedItem.name} - updating timestamp (qty: ${existingItem.quantity})`);

            try {
              let teamData: any = undefined;
              try {
                teamData = await reorderService.fetchTeamData(convertedItem.id);
              } catch (teamDataError) {
                logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
              }

              const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';

              // Move item to chronological top by updating timestamp (quantity stays the same)
              const success = await reorderService.moveItemToTop(existingItem.id, teamData, userName);

              if (success) {
                playSuccessSound();
                setLastScannedItemId(convertedItem.id);
                logger.info(TAG, `✅ Moved item to chronological top: ${convertedItem.name} (qty: ${existingItem.quantity})`);
              } else {
                throw new Error('Failed to move item to chronological top');
              }
            } catch (error) {
              logger.error(TAG, 'Error moving item to chronological top', { error });
              playErrorSound();
              setErrorMessage('Failed to move item to chronological top. Please try again.');
              setShowErrorModal(true);
            }
          }
        } else {
          // NEW ITEM: Add with default quantity of 1
          logger.info(TAG, `🆕 NEW ITEM SCAN: ${convertedItem.name} (qty: 1)`);
          
          try {
            let teamData: any = undefined;
            try {
              teamData = await reorderService.fetchTeamData(convertedItem.id);
            } catch (teamDataError) {
              logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
            }
            
            const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
            
            const success = await reorderService.addItem(convertedItem, 1, teamData, userName, true);
            
            if (success) {
              playSuccessSound();
              logger.info(TAG, `✅ Added new item: ${convertedItem.name} (qty: 1)`);
            } else {
              throw new Error('Failed to add new item');
            }
          } catch (error) {
            logger.error(TAG, 'Error adding new item', { error });
            playErrorSound();
            setErrorMessage('Failed to add item to reorder list. Please try again.');
            setShowErrorModal(true);
          }
        }
      } else {
        // Multiple items found - show selection modal
        const convertedItems: ConvertedItem[] = matchingItems.map(item => ({
          id: item.id,
          name: item.name || '',
          sku: item.sku,
          barcode: item.barcode,
          price: item.price,
          category: item.category,
          categoryId: item.categoryId,
          reporting_category_id: item.categoryId || item.reporting_category_id,
          description: item.description,
          isActive: true,
          images: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        
        setMultipleItems(convertedItems);
        setShowSelectionModal(true);
      }
    } catch (error) {
      logger.error(TAG, 'Error searching for barcode', { barcode, error });
      playErrorSound();
      setErrorMessage(`Search failed for barcode: ${barcode}\n\nPlease try again.`);
      setShowErrorModal(true);
    }
  }, [performSearch, showErrorModal, playSuccessSound, playErrorSound, reorderItems, user]);

  // Handle scan errors (ERROR CASE 2: Invalid GTIN format - play error sound & show modal)
  const handleScanError = useCallback((error: string) => {
    logger.warn(TAG, `Scan error: ${error}`);
    playErrorSound();
    setErrorMessage(`Scan failed: ${error}`);
    setShowErrorModal(true);
  }, [playErrorSound]);

  // Handle manual quantity edit submission
  const handleQuantitySubmit = useCallback(async (quantity: number) => {
    if (!currentEditingItem) return;

    // Handle quantity 0 as deletion
    if (quantity === 0) {
      logger.info(TAG, `Quantity 0 specified - deleting item: ${currentEditingItem.itemName}`);
      
      try {
        await reorderService.removeItem(currentEditingItem.id);
        playSuccessSound();
        logger.info(TAG, `Deleted reorder item: ${currentEditingItem.itemName}`);
      } catch (error) {
        logger.error(TAG, 'Error deleting item', { error });
        playErrorSound();
        setErrorMessage('Failed to delete item from reorder list');
        setShowErrorModal(true);
      }
      
              setShowQuantityModal(false);
        setCurrentEditingItem(null);
        setModalQuantity('1');
      return;
    }

    try {
      // Convert DisplayReorderItem (with cross-referenced data) back to ConvertedItem format
      const convertedItem: ConvertedItem = {
        id: currentEditingItem.itemId,
        name: currentEditingItem.itemName,        // Cross-referenced from Square catalog
        sku: '', // Not stored in reorder data
        barcode: currentEditingItem.itemBarcode || '',  // Cross-referenced from Square catalog
        price: currentEditingItem.itemPrice || 0,       // Cross-referenced from Square catalog
        category: currentEditingItem.itemCategory || '', // Cross-referenced from Square catalog
        categoryId: '', // Not stored in reorder data
        reporting_category_id: '', // Not stored in reorder data
        description: '', // Not stored in reorder data
        isActive: true,
        images: [],
        createdAt: currentEditingItem.createdAt,
        updatedAt: currentEditingItem.updatedAt,
      };
      
      let teamData: any = currentEditingItem.teamData;
      if (!teamData) {
        try {
          teamData = await reorderService.fetchTeamData(currentEditingItem.itemId);
        } catch (teamDataError) {
          logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
        }
      }
      
      const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
      
      const success = await reorderService.addItem(convertedItem, quantity, teamData, userName, true);
      
      if (success) {
        playSuccessSound();
        setShowQuantityModal(false);
        setCurrentEditingItem(null);
        logger.info(TAG, `Updated reorder item: ${currentEditingItem.itemName} to qty ${quantity}`);
        
        // Check sync status to inform user if saved locally
        const syncStatus = reorderService.getSyncStatus();
        if (!syncStatus.isAuthenticated || !syncStatus.isOnline) {
          logger.info(TAG, 'Item updated locally - will sync when connected');
        }
      } else {
        playErrorSound();
        setErrorMessage('Failed to update item quantity. Please try again.');
        setShowErrorModal(true);
      }
    } catch (error) {
      logger.error(TAG, 'Error updating reorder item', { error });
      playErrorSound();
      setErrorMessage('Failed to update item quantity. The change has been saved locally and will sync when you\'re connected.');
      setShowErrorModal(true);
      setShowQuantityModal(false);
      setCurrentEditingItem(null);
    }
      }, [currentEditingItem, user, playSuccessSound, playErrorSound]);

  // Handle item selection from multiple items - implement additive logic
  const handleItemSelection = useCallback(async (item: ConvertedItem) => {
    setShowSelectionModal(false);
    setMultipleItems([]);
    
    // Implement the same additive logic as single item scan
    const existingItem = reorderItems.find(reorderItem => reorderItem.itemId === item.id);
    
    if (existingItem) {
      // ADDITIVE SCANNING: Increment existing item quantity by 1
      logger.info(TAG, `📈 ADDITIVE SELECTION: ${item.name} (${existingItem.quantity} → ${existingItem.quantity + 1})`);
      
      try {
        let teamData: any = undefined;
        try {
          teamData = await reorderService.fetchTeamData(item.id);
        } catch (teamDataError) {
          logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
        }
        
        const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
        const newQuantity = existingItem.quantity + 1;
        
        const success = await reorderService.addItem(item, newQuantity, teamData, userName, true);
        
        if (success) {
          playSuccessSound();
          logger.info(TAG, `✅ Incremented selected item: ${item.name} to qty ${newQuantity}`);
        } else {
          throw new Error('Failed to increment selected item');
        }
      } catch (error) {
        logger.error(TAG, 'Error incrementing selected item', { error });
        playErrorSound();
        setErrorMessage('Failed to increment item quantity. Please try again.');
        setShowErrorModal(true);
      }
    } else {
      // NEW ITEM: Add with default quantity of 1
      logger.info(TAG, `🆕 NEW ITEM SELECTION: ${item.name} (qty: 1)`);
      
      try {
        let teamData: any = undefined;
        try {
          teamData = await reorderService.fetchTeamData(item.id);
        } catch (teamDataError) {
          logger.warn(TAG, 'Failed to fetch team data, proceeding without it', { teamDataError });
        }
        
        const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
        
        const success = await reorderService.addItem(item, 1, teamData, userName, true);
        
        if (success) {
          playSuccessSound();
          logger.info(TAG, `✅ Added selected item: ${item.name} (qty: 1)`);
        } else {
          throw new Error('Failed to add selected item');
        }
      } catch (error) {
        logger.error(TAG, 'Error adding selected item', { error });
        playErrorSound();
        setErrorMessage('Failed to add item to reorder list. Please try again.');
        setShowErrorModal(true);
      }
    }
  }, [reorderItems, user, playSuccessSound, playErrorSound]);

  // Handle item deletion
  const handleDeleteItem = async (itemId: string) => {
    try {
      await reorderService.removeItem(itemId);
    } catch (error) {
      console.error('Error deleting item:', error);
    }
  };

  // Handle mark as received (swipe left)
  const handleMarkAsReceived = async (itemId: string) => {
    try {
      const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
      await reorderService.markAsReceived(itemId, userName);
    } catch (error) {
      console.error('Error marking item as received:', error);
    }
  };

  // Handle manual refresh
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await reorderService.refresh();
      // Update sync status after refresh
      const status = reorderService.getSyncStatus();
      setSyncStatus(status);
      logger.info(TAG, 'Manual refresh completed');
    } catch (error) {
      logger.error(TAG, 'Manual refresh failed', { error });
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  // List maintenance functions
  const handleMarkCompletedAsReceived = useCallback(async () => {
    const completedItems = reorderItems.filter(item => item.status === 'complete');
    if (completedItems.length === 0) {
      Alert.alert('No Completed Items', 'There are no completed items to mark as received.');
      return;
    }

    Alert.alert(
      'Mark Completed as Received',
      `This will mark ${completedItems.length} completed item(s) as received and remove them from the list. This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Mark as Received',
          style: 'destructive',
          onPress: async () => {
            try {
              const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';

              // Mark all completed items as received
              for (const item of completedItems) {
                await reorderService.markAsReceived(item.id, userName);
              }

              logger.info(TAG, `✅ Marked ${completedItems.length} completed items as received`);
              setShowMaintenanceButtons(false);
            } catch (error) {
              logger.error(TAG, 'Error marking completed items as received', { error });
              Alert.alert('Error', 'Failed to mark items as received. Please try again.');
            }
          }
        }
      ]
    );
  }, [reorderItems, user]);

  const handleClearAll = useCallback(async () => {
    if (reorderItems.length === 0) {
      Alert.alert('No Items', 'There are no items to clear.');
      return;
    }

    Alert.alert(
      'Clear All Items',
      `This will remove all ${reorderItems.length} item(s) from the reorder list. This action cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear All',
          style: 'destructive',
          onPress: async () => {
            try {
              await reorderService.clear();
              logger.info(TAG, '✅ Cleared all reorder items');
              setShowMaintenanceButtons(false);
            } catch (error) {
              logger.error(TAG, 'Error clearing all items', { error });
              Alert.alert('Error', 'Failed to clear all items. Please try again.');
            }
          }
        }
      ]
    );
  }, [reorderItems]);

  const handleShareExportPDF = useCallback(() => {
    Alert.alert('Export PDF', 'PDF export functionality coming soon!');
    setShowMaintenanceButtons(false);
  }, []);

  const handlePrintList = useCallback(() => {
    Alert.alert('Print List', 'Print functionality coming soon!');
    setShowMaintenanceButtons(false);
  }, []);

  // Debug cross-referencing
  const handleDebugCrossReference = useCallback(() => {
    if (reorderItems.length === 0) {
      Alert.alert('No Items', 'Add some items to the reorder list first to test cross-referencing.');
      return;
    }

    const firstItem = reorderItems[0];
    Alert.alert(
      'Debug Cross-Reference',
      `Testing cross-reference for item: ${firstItem.itemId}\n\nCheck the logs for detailed results.`,
      [
        {
          text: 'Cancel',
          style: 'cancel'
        },
        {
          text: 'Test',
          onPress: async () => {
            try {
              await crossReferenceService.debugCrossReference(firstItem.itemId);
              Alert.alert('Debug Complete', 'Check the logs for cross-reference results.');
            } catch (error) {
              Alert.alert('Debug Failed', `Error: ${error}`);
            }
          }
        }
      ]
    );
    setShowMaintenanceButtons(false);
  }, [reorderItems]);

  // Handle custom item creation
  const handleAddCustomItem = useCallback(() => {
    const newCustomItem: CustomItemEdit = {
      id: `custom-${Date.now()}`,
      itemName: '',
      itemCategory: '',
      vendor: '',
      quantity: 1,
      notes: ''
    };
    setCustomItemEdit(newCustomItem);
    setEditingCustomItem(newCustomItem.id);
    setShowAddCustomItem(true);
  }, []);

  // Handle custom item save
  const handleSaveCustomItem = useCallback(async () => {
    if (!customItemEdit || !customItemEdit.itemName.trim()) return;

    try {
      const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
      
      const success = await reorderService.addCustomItem({
        itemName: customItemEdit.itemName.trim(),
        itemCategory: customItemEdit.itemCategory || 'Custom',
        quantity: customItemEdit.quantity,
        addedBy: userName,
        vendor: customItemEdit.vendor || undefined,
        notes: customItemEdit.notes || undefined
      });
      
      if (success) {
        // Reset states
        setShowAddCustomItem(false);
        setEditingCustomItem(null);
        setCustomItemEdit(null);
        
        logger.info(TAG, `Added custom item: ${customItemEdit.itemName}`);
      } else {
        Alert.alert('Error', 'Failed to add custom item');
      }
    } catch (error) {
      logger.error(TAG, 'Error adding custom item', { error });
      Alert.alert('Error', 'Failed to add custom item');
    }
  }, [customItemEdit, user]);

  // Handle custom item edit
  const handleEditCustomItem = useCallback((item: DisplayReorderItem) => {
    if (!item.isCustom) return;
    
    const editItem: CustomItemEdit = {
      id: item.id,
      itemName: item.itemName,
      itemCategory: item.itemCategory || '',
      vendor: item.teamData?.vendor || '',
      quantity: item.quantity,
      notes: item.teamData?.notes || ''
    };
    
    setCustomItemEdit(editItem);
    setEditingCustomItem(item.id);
  }, []);

  // Handle custom item cancel
  const handleCancelCustomItem = useCallback(() => {
    setShowAddCustomItem(false);
    setEditingCustomItem(null);
    setCustomItemEdit(null);
  }, []);

  // Handle image thumbnail tap
  const handleImageTap = useCallback((imageUrl: string, item: DisplayReorderItem) => {
    setSelectedImageUrl(imageUrl);
    setSelectedItemInfo({
      itemName: item.itemName,
      itemCategory: item.itemCategory,
      itemBarcode: item.itemBarcode,
      itemPrice: item.itemPrice,
      vendorCost: item.teamData?.vendorCost,
      vendor: item.teamData?.vendor,
      discontinued: item.teamData?.discontinued,
      missingSquareData: item.missingSquareData,
      missingTeamData: item.missingTeamData,
    });
    setShowImageOverlay(true);
  }, []);

  // Handle long press to open item modal
  const handleItemLongPress = useCallback((item: DisplayReorderItem) => {
    if (item.isCustom) {
      // For custom items, just edit them inline
      handleEditCustomItem(item);
    } else {
      // For catalog items, navigate to the item detail page
      router.push(`/item/${item.itemId}`);
    }
  }, [router]);

  // Track screen focus to disable barcode scanner when navigating to item detail page
  useFocusEffect(
    useCallback(() => {
      // Screen is focused
      setIsScreenFocused(true);

      return () => {
        // Screen is losing focus (navigating away)
        setIsScreenFocused(false);
      };
    }, [])
  );

  // Monitor sync status with stability
  useEffect(() => {
    const updateSyncStatus = () => {
      const serviceStatus = reorderService.getSyncStatus();

      // Override authentication status with actual Cognito state
      // The reorderService might have stale authentication info
      const isActuallyAuthenticated = user !== undefined && user !== null;

      const correctedStatus = {
        ...serviceStatus,
        isAuthenticated: isActuallyAuthenticated,
        // STABILITY FIX: If authenticated, assume online to prevent flickering
        isOnline: isActuallyAuthenticated ? true : serviceStatus.isOnline
      };

      // Only update if status actually changed to prevent unnecessary re-renders
      setSyncStatus(prevStatus => {
        if (JSON.stringify(prevStatus) !== JSON.stringify(correctedStatus)) {
          return correctedStatus;
        }
        return prevStatus;
      });

      // Log discrepancies for debugging
      if (serviceStatus.isAuthenticated !== isActuallyAuthenticated) {
        logger.warn('ReorderPage', 'Authentication state mismatch detected', {
          serviceAuth: serviceStatus.isAuthenticated,
          cognitoAuth: isActuallyAuthenticated,
          userId: user?.userId || 'none',
          serviceUserId: serviceStatus.currentUserId
        });
      }
    };

    // Update immediately
    updateSyncStatus();

    // STABILITY FIX: Reduce update frequency to prevent flickering
    const interval = setInterval(updateSyncStatus, 10000); // 10 seconds instead of 5

    return () => clearInterval(interval);
  }, [user]); // Add user dependency to update when auth state changes

  // Track previous authentication state to detect sign-out
  const wasAuthenticatedRef = useRef<boolean>(false);

  // Immediate update when user authentication state changes
  useEffect(() => {
    const serviceStatus = reorderService.getSyncStatus();
    const isActuallyAuthenticated = user !== undefined && user !== null;

    // Check if user just signed out (was authenticated, now not)
    if (wasAuthenticatedRef.current && !isActuallyAuthenticated) {
      logger.info('ReorderPage', 'User signed out - ensuring data preservation', {
        itemCount: reorderItems.length,
        previousUserId: 'user-signed-out'
      });

      // Force save current reorder items to local storage before losing authentication
      // This ensures data is preserved even if the service doesn't handle sign-out properly
      reorderService.forceSaveOfflineData().catch((error: any) => {
        logger.error('ReorderPage', 'Failed to preserve data on sign-out', { error });
      });
    }

    // Check if user just signed in (was not authenticated, now is)
    if (!wasAuthenticatedRef.current && isActuallyAuthenticated) {
      logger.info('ReorderPage', 'User signed in - refreshing service authentication status', {
        userId: user?.signInDetails?.loginId || 'unknown',
        itemCount: reorderItems.length
      });

      // Refresh the service authentication status to transition from offline to online
      reorderService.refreshAuthenticationStatus().catch((error: any) => {
        logger.error('ReorderPage', 'Failed to refresh authentication status on sign-in', { error });
      });
    }

    // Update the ref for next comparison
    wasAuthenticatedRef.current = isActuallyAuthenticated;

    const correctedStatus = {
      ...serviceStatus,
      isAuthenticated: isActuallyAuthenticated
    };

    setSyncStatus(correctedStatus);

    logger.info('ReorderPage', 'Authentication state changed', {
      isAuthenticated: isActuallyAuthenticated,
      userId: user?.signInDetails?.loginId || 'none',
      itemCount: reorderItems.length,
      serviceOnline: serviceStatus.isOnline
    });
  }, [user, reorderItems.length]);

  // Additional safeguard: Save data when component unmounts or app goes to background
  useEffect(() => {
    const handleAppStateChange = (nextAppState: string) => {
      if (nextAppState === 'background' || nextAppState === 'inactive') {
        logger.info('ReorderPage', 'App going to background - preserving data', {
          itemCount: reorderItems.length
        });

        // Save data when app goes to background
        reorderService.forceSaveOfflineData().catch((error: any) => {
          logger.error('ReorderPage', 'Failed to preserve data on background', { error });
        });
      }
    };

    // Import AppState dynamically to avoid issues
    const { AppState } = require('react-native');
    const subscription = AppState.addEventListener('change', handleAppStateChange);

    // Cleanup function to save data when component unmounts
    return () => {
      logger.info('ReorderPage', 'Component unmounting - preserving data', {
        itemCount: reorderItems.length
      });

      // Save data when component unmounts
      reorderService.forceSaveOfflineData().catch((error: any) => {
        logger.error('ReorderPage', 'Failed to preserve data on unmount', { error });
      });

      // Remove app state listener
      subscription?.remove();
    };
  }, [reorderItems.length]);

  // Set up reorder service listener and cleanup
  useEffect(() => {
    const unsubscribe = reorderService.addListener((displayItems: DisplayReorderItem[]) => {
      setReorderItems(displayItems);
    });

    // 🔧 CRITICAL FIX: Force initial data load in case we missed the initial notification
    const loadInitialData = async () => {
      try {
        const initialItems = await reorderService.getItems();
        setReorderItems(initialItems);
      } catch (error) {
        logger.error(TAG, 'Failed to load initial reorder items', { error });
      }
    };

    // Load initial data immediately
    loadInitialData();

    return () => {
      unsubscribe();
      // Cleanup subscriptions when component unmounts
      reorderService.cleanup();
    };
  }, []);

  // Initialize service with user ID when user changes
  useEffect(() => {
    if (user?.signInDetails?.loginId) {
      const userId = user.signInDetails.loginId;
      reorderService.initialize(userId);
    }
  }, [user?.signInDetails?.loginId]);



  // Generate dynamic filter data with counts - optimized
  const filterData = useMemo(() => {
    const incompleteItems = reorderItems.filter(item => item.status === 'incomplete');
    
    // Category counts with better handling
    const categoryMap = new Map<string, number>();
    const vendorMap = new Map<string, number>();
    
    // Single loop for both category and vendor counting (cross-referenced data)
    incompleteItems.forEach(item => {
      // Category processing (from cross-referenced Square catalog)
      let category = item.itemCategory;
      if (item.missingSquareData || !category || category.trim() === '' || category === 'N/A') {
        category = item.missingSquareData ? 'Missing Catalog' : 'Uncategorized';
      }
      categoryMap.set(category, (categoryMap.get(category) || 0) + 1);

      // Vendor processing (from cross-referenced team data)
      let vendor = item.teamData?.vendor;
      if (item.missingTeamData || !vendor || vendor.trim() === '' || vendor === 'N/A' || vendor === 'Unknown Vendor') {
        vendor = item.missingTeamData ? 'Missing Team Data' : 'No Vendor';
      }
      vendorMap.set(vendor, (vendorMap.get(vendor) || 0) + 1);
    });
    
    const categories = Array.from(categoryMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
      
    const vendors = Array.from(vendorMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    
    return { categories, vendors };
  }, [reorderItems]);

  // Filter and sort items based on current filter - optimized
  const filteredAndSortedItems = useMemo(() => {
    let filtered = reorderItems;

    // Apply all filters in a single pass for better performance
    filtered = reorderItems.filter(item => {
      // Completion filter
      if (currentFilter === 'completed' && item.status !== 'complete') return false;
      if (currentFilter === 'incomplete' && item.status !== 'incomplete') return false;
      
      // Category filter (cross-referenced data)
      if (selectedCategories.length > 0) {
        let itemCategory = item.itemCategory;
        if (item.missingSquareData || !itemCategory || itemCategory.trim() === '' || itemCategory === 'N/A') {
          itemCategory = item.missingSquareData ? 'Missing Catalog' : 'Uncategorized';
        }
        if (!selectedCategories.includes(itemCategory)) return false;
      }

      // Vendor filter (cross-referenced team data)
      if (selectedVendor) {
        let itemVendor = item.teamData?.vendor;
        if (item.missingTeamData || !itemVendor || itemVendor.trim() === '' || itemVendor === 'N/A' || itemVendor === 'Unknown Vendor') {
          itemVendor = item.missingTeamData ? 'Missing Team Data' : 'No Vendor';
        }
        if (itemVendor !== selectedVendor) return false;
      }
      
      return true;
    });

    // Apply sorting based on sortState - always sort for consistent ordering
    if (sortState.alphabetical !== 'off') {
      filtered.sort((a, b) => {
        const comparison = (a.itemName || '').localeCompare(b.itemName || '');
        return sortState.alphabetical === 'asc' ? comparison : -comparison;
      });
    } else {
      // Default to chronological sorting (most recent first)
      filtered.sort((a, b) => {
        const aTime = a.timestamp ? a.timestamp.getTime() : new Date(a.createdAt).getTime();
        const bTime = b.timestamp ? b.timestamp.getTime() : new Date(b.createdAt).getTime();
        const comparison = bTime - aTime; // Most recent first
        return sortState.chronological === 'desc' ? comparison : -comparison;
      });
    }

    return filtered;
  }, [reorderItems, currentFilter, selectedCategories, selectedVendor, sortState]);

  // Calculate stats including missing data detection
  const stats = useMemo(() => {
    const total = reorderItems.length;
    const completed = reorderItems.filter(item => item.status === 'complete').length;
    const incomplete = total - completed;
    const totalQuantity = reorderItems.reduce((sum, item) => sum + item.quantity, 0);

    // Missing data detection
    const missingSquareData = reorderItems.filter(item => item.missingSquareData).length;
    const missingTeamData = reorderItems.filter(item => item.missingTeamData).length;
    const customItems = reorderItems.filter(item => item.isCustom).length;

    return {
      total,
      completed,
      incomplete,
      totalQuantity,
      missingSquareData,
      missingTeamData,
      customItems
    };
  }, [reorderItems]);

  // Render sort button (3-state cycle) - memoized for performance
  const renderSortButton = useCallback((sortType: 'chronological' | 'alphabetical', label: string, icon: string) => {
    const state = sortState[sortType];
    const isActive = state !== 'off';
    
    return (
      <Pressable
        style={[
          reorderStyles.filterButton,
          isActive && reorderStyles.filterButtonActive
        ]}
        onPress={() => handleSortClick(sortType)}
      >
        <Ionicons 
          name={icon as any} 
          size={16} 
          color={isActive ? '#fff' : '#333'} 
        />
        <Text style={[
          reorderStyles.filterButtonText,
          isActive && reorderStyles.filterButtonTextActive
        ]}>
          {label}{state === 'asc' ? ' ↑' : state === 'desc' ? ' ↓' : ''}
        </Text>
      </Pressable>
    );
  }, [sortState]);

  // Render filter button - memoized for performance  
  const renderFilterButton = useCallback((filter: FilterType, label: string, icon: string) => {
    if (filter === 'category') {
      return (
        <Pressable
          style={[
            reorderStyles.filterButton,
            (selectedCategories.length > 0 || showCategoryDropdown) && reorderStyles.filterButtonActive
          ]}
          onPress={() => handleFilterClick(filter)}
        >
          <Ionicons 
            name={icon as any} 
            size={16} 
            color={(selectedCategories.length > 0 || showCategoryDropdown) ? '#fff' : '#333'} 
          />
          <Text style={[
            reorderStyles.filterButtonText,
            (selectedCategories.length > 0 || showCategoryDropdown) && reorderStyles.filterButtonTextActive
          ]}>
            {selectedCategories.length > 0 ? `Categories (${selectedCategories.length})` : `Categories (${filterData.categories.length})`}
          </Text>
          <Ionicons 
            name={showCategoryDropdown ? "chevron-up" : "chevron-down"} 
            size={14} 
            color={(selectedCategories.length > 0 || showCategoryDropdown) ? '#fff' : '#333'} 
            style={{ marginLeft: 4 }}
          />
        </Pressable>
      );
    }

    if (filter === 'vendor') {
      return (
        <Pressable
          style={[
            reorderStyles.filterButton,
            (selectedVendor || showVendorDropdown) && reorderStyles.filterButtonActive
          ]}
          onPress={() => handleFilterClick(filter)}
        >
          <Ionicons 
            name={icon as any} 
            size={16} 
            color={(selectedVendor || showVendorDropdown) ? '#fff' : '#333'} 
          />
          <Text style={[
            reorderStyles.filterButtonText,
            (selectedVendor || showVendorDropdown) && reorderStyles.filterButtonTextActive
          ]}>
            {selectedVendor ? `${selectedVendor} (${filterData.vendors.find(v => v.name === selectedVendor)?.count || 0})` : `Vendors (${filterData.vendors.length})`}
          </Text>
          <Ionicons 
            name={showVendorDropdown ? "chevron-up" : "chevron-down"} 
            size={14} 
            color={(selectedVendor || showVendorDropdown) ? '#fff' : '#333'} 
            style={{ marginLeft: 4 }}
          />
        </Pressable>
      );
    }

    // Regular filter button (completed, incomplete, sortConfig)
    const isActive = currentFilter === filter;
    return (
      <Pressable
        style={[
          reorderStyles.filterButton,
          isActive && reorderStyles.filterButtonActive
        ]}
        onPress={() => handleFilterClick(filter)}
      >
        <Ionicons 
          name={icon as any} 
          size={16} 
          color={isActive ? '#fff' : '#333'} 
        />
        <Text style={[
          reorderStyles.filterButtonText,
          isActive && reorderStyles.filterButtonTextActive
        ]}        >
          {label}
        </Text>
      </Pressable>
    );
  }, [filterData, selectedCategories, selectedVendor, showCategoryDropdown, showVendorDropdown, currentFilter]);

  // Handle sort button clicks (3-state cycle for chronological/alphabetical)
  const handleSortClick = (sortType: 'chronological' | 'alphabetical') => {
    setSortState(prev => {
      const currentState = prev[sortType];
      let newState: 'off' | 'desc' | 'asc';
      
      if (currentState === 'off') {
        newState = 'desc'; // First click: most recent/A-Z
      } else if (currentState === 'desc') {
        newState = 'asc'; // Second click: oldest/Z-A
      } else {
        newState = 'off'; // Third click: turn off
      }
      
      return {
        ...prev,
        [sortType]: newState,
        // Turn off the other sort when one is activated
        [sortType === 'chronological' ? 'alphabetical' : 'chronological']: newState === 'off' ? prev[sortType === 'chronological' ? 'alphabetical' : 'chronological'] : 'off'
      };
    });
  };

  // Handle filter button clicks (toggle on/off)
  const handleFilterClick = (filter: FilterType) => {
    // Close all dropdowns first
    setShowCategoryDropdown(false);
    setShowVendorDropdown(false);
    setShowConfigDropdown(false);
    setShowSyncStatusPopover(false);
    
    if (filter === 'completed') {
      setCurrentFilter(currentFilter === 'completed' ? null : 'completed');
    } else if (filter === 'incomplete') {
      setCurrentFilter(currentFilter === 'incomplete' ? null : 'incomplete');
    } else if (filter === 'category') {
      setShowCategoryDropdown(true);
    } else if (filter === 'vendor') {
      setShowVendorDropdown(true);
    } else if (filter === 'sortConfig') {
      setShowConfigDropdown(true);
    }
  };

  // Render reorder item - memoized for performance
  const renderReorderItem = useCallback(({ item }: { item: DisplayReorderItem }) => {
    return (
      <Swipeable
        friction={2}
        leftThreshold={120}
        rightThreshold={120}
        overshootLeft={false}
        overshootRight={false}
        onSwipeableWillOpen={() => {
          // Track that this item is being swiped
          setSwipingItemId(item.id);
        }}
        onSwipeableClose={() => {
          // Clear swipe state when swipe ends
          setSwipingItemId(null);
        }}
        renderLeftActions={(progress, dragX) => {
          const opacity = progress.interpolate({
            inputRange: [0, 0.7, 0.8],
            outputRange: [1, 1, 0],
            extrapolate: 'clamp',
          });

          return (
            <View style={staticStyles.swipeReceivedContainer}>
              <Animated.View style={[
                reorderStyles.receivedButton,
                { opacity }
              ]}>
                <Pressable
                  style={reorderStyles.receivedButtonInner}
                  onPress={() => handleMarkAsReceived(item.id)}
                >
                  <Ionicons name="checkmark-done" size={24} color="#fff" />
                </Pressable>
              </Animated.View>
            </View>
          );
        }}
        renderRightActions={(progress, dragX) => {
          const opacity = progress.interpolate({
            inputRange: [0, 0.7, 0.8],
            outputRange: [1, 1, 0],
            extrapolate: 'clamp',
          });

          return (
            <View style={staticStyles.swipeDeleteContainer}>
              <Animated.View style={[
                reorderStyles.deleteButton,
                { opacity }
              ]}>
                <Pressable
                  style={reorderStyles.deleteButtonInner}
                  onPress={() => handleDeleteItem(item.id)}
                >
                  <Ionicons name="trash-outline" size={24} color="#fff" />
                </Pressable>
              </Animated.View>
            </View>
          );
        }}
        onSwipeableLeftOpen={() => {
          // Auto-mark-as-received on full left swipe
          handleMarkAsReceived(item.id);
        }}
        onSwipeableRightOpen={() => {
          // Auto-delete on full right swipe
          handleDeleteItem(item.id);
        }}
      >
        <View style={[
          reorderStyles.reorderItem,
          item.status === 'complete' && reorderStyles.reorderItemCompleted,
          item.isCustom && { borderLeftWidth: 4, borderLeftColor: '#007AFF' }
        ]}>
          {/* Index number - tappable for completion toggle */}
          <Pressable
            style={[
              {
                // Proper tap target and spacing
                width: 30,
                height: 30,
                borderRadius: 22,
                backgroundColor: 'transparent',
                justifyContent: 'center',
                alignItems: 'center',
                marginRight: 5,
              }
            ]}
            onPress={() => {
              // Prevent tap action if item is currently being swiped
              if (swipingItemId === item.id) {
                return;
              }

              const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
              reorderService.toggleCompletion(item.id, userName);
            }}
          >
            {item.status === 'complete' ? (
              <View style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: '#4CD964',
                backgroundColor: '#4CD964',
                justifyContent: 'center',
                alignItems: 'center'
              }}>
                <Ionicons name="checkmark" size={12} color="#fff" />
              </View>
            ) : (
              <View style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: 2,
                borderColor: '#007AFF',
                backgroundColor: 'transparent'
              }} />
            )}
          </Pressable>

          {/* Item Image Thumbnail - Tappable for overlay */}
          <Pressable
            style={{
              width: 64,
              height: 64,
              marginRight: 10,
              marginLeft: -4,
              borderRadius: 6,
              overflow: 'hidden',
            }}
            onPress={() => {
              // Only show overlay if there's an image
              if (item.item?.images && item.item.images.length > 0 && item.item.images[0]?.url) {
                handleImageTap(item.item.images[0].url, item);
              }
            }}
          >
            {item.item?.images && item.item.images.length > 0 && item.item.images[0]?.url ? (
              <CachedImage
                source={{ uri: item.item.images[0].url }}
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 6,
                }}
                fallbackStyle={{
                  width: 64,
                  height: 64,
                  backgroundColor: '#f5f5f5',
                  borderRadius: 6,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 1,
                  borderColor: '#e0e0e0',
                }}
                fallbackText={item.itemName ? item.itemName.substring(0, 2).toUpperCase() : '📦'}
                showLoadingIndicator={false}
              />
            ) : (
              <View style={{
                width: 64,
                height: 64,
                backgroundColor: '#f5f5f5',
                borderRadius: 6,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: '#e0e0e0',
              }}>
                <Text style={{
                  fontSize: 16,
                  fontWeight: '600',
                  color: '#666',
                }}>
                  {item.itemName ? item.itemName.substring(0, 2).toUpperCase() : '📦'}
                </Text>
              </View>
            )}
          </Pressable>

          {/* Item content - tappable for quantity editing, long press for item details */}
          <Pressable
            style={reorderStyles.itemContent}
            onPress={() => {
              // Prevent tap action if item is currently being swiped
              if (swipingItemId === item.id) {
                return;
              }

              if (item.isCustom) {
                handleEditCustomItem(item);
              } else {
                // Open quantity modal for manual editing
                setCurrentEditingItem(item);
                setShowQuantityModal(true);
              }
            }}
            onLongPress={() => {
              // Prevent long press action if item is currently being swiped
              if (swipingItemId === item.id) {
                return;
              }

              handleItemLongPress(item);
            }}
          >
            <View style={reorderStyles.itemHeader}>
              <View style={reorderStyles.itemNameContainer}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Text style={[
                    reorderStyles.itemName,
                    item.status === 'complete' && reorderStyles.itemNameCompleted
                  ]}>
                    {item.itemName}
                  </Text>
                  {/* Missing data indicators */}
                  {item.missingSquareData && (
                    <View style={{
                      backgroundColor: '#FF6B6B',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginLeft: 8,
                    }}>
                      <Text style={{ color: 'white', fontSize: 10, fontWeight: 'bold' }}>
                        NO CATALOG
                      </Text>
                    </View>
                  )}
                  {item.missingTeamData && (
                    <View style={{
                      backgroundColor: '#FFA726',
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                      borderRadius: 4,
                      marginLeft: 8,
                    }}>
                      <Text style={{ color: 'white', fontSize: 10, fontWeight: 'bold' }}>
                        NO TEAM DATA
                      </Text>
                    </View>
                  )}
                </View>
                <View style={staticStyles.itemDetailsContainer}>
                  <Text style={reorderStyles.compactDetails}>
                    {/* Build data line efficiently with only available data */}
                    {[
                      // Category (if available)
                      item.itemCategory,
                      // UPC (if catalog data available)
                      item.missingSquareData ? 'Missing Catalog' : (item.itemBarcode || 'N/A'),
                      // Price (if catalog data available)
                      item.missingSquareData ? 'Unknown' : (item.itemPrice ? `$${item.itemPrice.toFixed(2)}` : 'Variable'),
                      // Vendor Cost (only if team data available and cost exists)
                      (!item.missingTeamData && item.teamData?.vendorCost) ? `$${item.teamData.vendorCost.toFixed(2)}/unit` : null,
                      // Vendor (only if team data available and vendor exists)
                      (!item.missingTeamData && item.teamData?.vendor) ? item.teamData.vendor : null,
                      // Discontinued flag (only if team data available and item is discontinued)
                      (!item.missingTeamData && item.teamData?.discontinued) ? 'DISCONTINUED' : null
                    ].filter(Boolean).join(' • ')}
                  </Text>
                </View>
              </View>
              <View style={{
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: 60,
                paddingHorizontal: 4,
              }}>
                {/* CRITICAL: Show DISCONTINUED indicator instead of quantity for discontinued items */}
                {item.teamData?.discontinued ? (
                  <View style={{
                    backgroundColor: '#FF3B30',
                    paddingHorizontal: 8,
                    paddingVertical: 6,
                    borderRadius: 6,
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 60,
                    minHeight: 50,
                  }}>
                    <Text style={{
                      color: 'white',
                      fontSize: 10,
                      fontWeight: 'bold',
                      textAlign: 'center',
                      lineHeight: 12,
                    }}>
                      DISCONTINUED
                    </Text>
                    <Text style={{
                      color: 'white',
                      fontSize: 8,
                      marginTop: 2,
                      textAlign: 'center',
                      opacity: 0.9,
                    }}>
                      DO NOT BUY
                    </Text>
                  </View>
                ) : (
                  <>
                    <Text style={reorderStyles.qtyLabel}>Qty</Text>
                    <Text style={reorderStyles.qtyNumber}>{item.quantity}</Text>
                    <Text style={{
                      fontSize: 9,
                      color: '#999',
                      marginTop: 2,
                      textAlign: 'center'
                    }}>
                      {(() => {
                        const date = item.timestamp || new Date(item.createdAt);
                        const dateStr = `${(date.getMonth() + 1).toString().padStart(2, '0')}/${date.getDate().toString().padStart(2, '0')}/${date.getFullYear().toString().slice(-2)}`;

                        let timeStr: string;
                        if (use12HourFormat) {
                          const hours = date.getHours();
                          const minutes = date.getMinutes();
                          const ampm = hours >= 12 ? 'PM' : 'AM';
                          const displayHours = hours % 12 || 12;
                          timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${ampm}`;
                        } else {
                          timeStr = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                        }

                        return `${dateStr}\n${timeStr}`;
                      })()}
                    </Text>
                  </>
                )}
              </View>
            </View>
          </Pressable>
        </View>
      </Swipeable>
    );
  }, [user, use12HourFormat]);

  // Render empty state - memoized
  const renderEmptyState = useCallback(() => (
    <View style={reorderStyles.emptyContainer}>
      <Ionicons name="scan-outline" size={64} color="#ccc" style={reorderStyles.emptyIcon} />
      <Text style={reorderStyles.emptyTitle}>No Reorders Yet</Text>
      <Text style={reorderStyles.emptySubtitle}>
        Scanner is ready! Start scanning items to add them to your reorder list.
      </Text>
    </View>
  ), []);

  // Create sectioned data for rendering
  const sectionedData = useMemo(() => {
    let baseData = filteredAndSortedItems;
    
    if (!sectionByCategory && !sectionByVendor) {
      // Add custom item entry at the top if it's being added
      if (showAddCustomItem) {
        return [{ type: 'customEntry' }, ...baseData];
      }
      return baseData;
    }

    const groupBy = sectionByVendor ? 'vendor' : 'category'; // Vendor takes precedence
    const sections: { [key: string]: ReorderItem[] } = {};

    baseData.forEach(item => {
      let key: string;
      if (groupBy === 'vendor') {
        // Group by vendor (cross-referenced team data)
        let vendor = item.teamData?.vendor;
        if (item.missingTeamData || !vendor || vendor.trim() === '' || vendor === 'N/A' || vendor === 'Unknown Vendor') {
          key = item.missingTeamData ? 'Missing Team Data' : 'No Vendor';
        } else {
          key = vendor;
        }
      } else {
        // Group by category (cross-referenced Square catalog)
        let category = item.itemCategory;
        if (item.missingSquareData || !category || category.trim() === '' || category === 'N/A') {
          key = item.missingSquareData ? 'Missing Catalog' : 'Uncategorized';
        } else {
          key = category;
        }
      }

      if (!sections[key]) {
        sections[key] = [];
      }
      sections[key].push(item);
    });

    // Convert to flat array with section headers
    const flatData: (ReorderItem | { type: 'header'; title: string; count: number } | { type: 'customEntry' })[] = [];
    
    // Add custom item entry at the very top if it's being added
    if (showAddCustomItem) {
      flatData.push({ type: 'customEntry' });
    }
    
    Object.keys(sections)
      .sort()
      .forEach(sectionKey => {
        flatData.push({
          type: 'header',
          title: sectionKey,
          count: sections[sectionKey].length
        });
        flatData.push(...sections[sectionKey]);
      });

    return flatData;
  }, [filteredAndSortedItems, sectionByCategory, sectionByVendor, showAddCustomItem]);

  // Render section header - memoized
  const renderSectionHeader = useCallback((title: string, count: number) => (
    <View style={reorderStyles.sectionHeader}>
      <Text style={reorderStyles.sectionHeaderText}>
        {title}
        <Text style={reorderStyles.sectionHeaderCount}>({count})</Text>
      </Text>
    </View>
  ), []);

  // Render grid item - memoized for performance
  const renderGridItem = useCallback(({ item }: { item: DisplayReorderItem }) => {
    const gridSize = viewMode === 'large-grid' ? 'large' : viewMode === 'medium-grid' ? 'medium' : 'small';

    return (
      <ReorderGridItem
        item={item}
        size={gridSize}
        onImageTap={handleImageTap}
        onItemPress={() => {
          if (item.isCustom) {
            handleEditCustomItem(item);
          } else {
            setCurrentEditingItem(item);
            setShowQuantityModal(true);
          }
        }}
        onItemLongPress={() => handleItemLongPress(item)}
        onToggleComplete={() => {
          const userName = user?.signInDetails?.loginId?.split('@')[0] || 'Unknown User';
          reorderService.toggleCompletion(item.id, userName);
        }}
      />
    );
  }, [viewMode, handleImageTap, handleItemLongPress, user]);

  // Updated render item function to handle both items and headers - memoized
  const renderListItem = useCallback(({ item }: { item: any }) => {
    if (item.type === 'header') {
      return renderSectionHeader(item.title, item.count);
    }
    if (item.type === 'customEntry') {
      return renderCustomItemEntry();
    }
    return renderReorderItem({ item });
  }, [renderSectionHeader, renderReorderItem]);

  // Memoized keyExtractor for performance
  const keyExtractor = useCallback((item: any) => {
    if ('type' in item) {
      if (item.type === 'header' && 'title' in item) {
        return `header-${item.title}`;
      }
      if (item.type === 'customEntry') {
        return 'custom-entry';
      }
    }
    return (item as ReorderItem).id;
  }, []);

  // Render custom item entry (inline at top of list) - memoized
  const renderCustomItemEntry = useCallback(() => {
    if (!showAddCustomItem || !customItemEdit) return null;

    return (
      <View style={[reorderStyles.reorderItem, staticStyles.customItemContainer]}>
        <View style={[reorderStyles.indexContainer, staticStyles.customItemIndexContainer]}>
          <Ionicons name="add" size={18} color="#fff" />
        </View>

        <View style={reorderStyles.itemContent}>
          <View style={reorderStyles.itemHeader}>
            <View style={reorderStyles.itemNameContainer}>
              <TextInput
                style={[reorderStyles.itemName, staticStyles.customItemNameInput]}
                value={customItemEdit.itemName}
                onChangeText={(text) => setCustomItemEdit(prev => prev ? { ...prev, itemName: text } : null)}
                placeholder="Enter item name..."
                autoFocus
                returnKeyType="next"
              />
              <View style={staticStyles.customItemRowContainer}>
                <TextInput
                  style={[reorderStyles.compactDetails, staticStyles.customItemFieldInput]}
                  value={customItemEdit.itemCategory}
                  onChangeText={(text) => setCustomItemEdit(prev => prev ? { ...prev, itemCategory: text } : null)}
                  placeholder="Category..."
                />
                <TextInput
                  style={[reorderStyles.compactDetails, staticStyles.customItemFieldInput]}
                  value={customItemEdit.vendor}
                  onChangeText={(text) => setCustomItemEdit(prev => prev ? { ...prev, vendor: text } : null)}
                  placeholder="Vendor..."
                />
              </View>
            </View>
            <View style={reorderStyles.qtyContainer}>
              <Text style={reorderStyles.qtyLabel}>Qty</Text>
              <TextInput
                style={[reorderStyles.qtyNumber, staticStyles.customItemQtyInput]}
                value={customItemEdit.quantity.toString()}
                onChangeText={(text) => {
                  const qty = parseInt(text) || 1;
                  setCustomItemEdit(prev => prev ? { ...prev, quantity: qty } : null);
                }}
                keyboardType="numeric"
              />
            </View>
          </View>

          <View style={[reorderStyles.timestampContainer, staticStyles.customItemActionsContainer]}>
            <Pressable
              style={staticStyles.customItemCancelButton}
              onPress={handleCancelCustomItem}
            >
              <Text style={staticStyles.customItemButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                staticStyles.customItemSaveButton,
                { backgroundColor: customItemEdit.itemName.trim() ? '#007AFF' : '#ccc' }
              ]}
              onPress={handleSaveCustomItem}
              disabled={!customItemEdit.itemName.trim()}
            >
              <Text style={staticStyles.customItemButtonText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }, [showAddCustomItem, customItemEdit, handleCancelCustomItem, handleSaveCustomItem]);

  // Get sync status explanation
  const getSyncStatusExplanation = () => {
    const { isAuthenticated, isOnline, pendingCount } = syncStatus;
    
    let title = '';
    let description = '';
    let color = '';
    
    if (isAuthenticated && isOnline && pendingCount === 0) {
      title = '✅ Fully Synced';
      description = 'You are signed in and all items are synced with the server. Changes will appear on all your devices in real-time.';
      color = '#4CD964';
    } else if (isAuthenticated && isOnline && pendingCount > 0) {
      title = '🔄 Syncing';
      description = `You are signed in but ${pendingCount} item${pendingCount > 1 ? 's' : ''} are waiting to sync. Tap refresh to sync now.`;
      color = '#FF9500';
    } else if (isAuthenticated && !isOnline) {
      title = '📱 Offline Mode';
      description = 'You are signed in but currently offline. Items are saved locally and will sync when connection is restored.';
      color = '#FF3B30';
    } else if (!isAuthenticated && isOnline) {
      title = '🔐 Not Signed In';
      description = 'You are not signed in. Items are saved locally on this device only. Sign in to sync across devices.';
      color = '#FF9500';
    } else {
      title = '📱 Local Only';
      description = 'You are not signed in and offline. Items are saved locally on this device only.';
      color = '#FF3B30';
    }
    
    return { title, description, color };
  };

  if (loading) {
    return (
      <SafeAreaView style={reorderStyles.container}>
        <Stack.Screen options={{ headerShown: true, title: 'Reorders' }} />
        <View style={reorderStyles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
          <Text style={reorderStyles.loadingText}>Loading catalog...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={reorderStyles.container}>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Reorders',
          headerLeft: () => (
            <Pressable 
              style={staticStyles.headerLeftContainer}
              onPress={() => setShowSyncStatusPopover(true)}
            >
              <Ionicons 
                name={syncStatus.isAuthenticated ? "person" : "person-outline"} 
                size={20} 
                color={syncStatus.isAuthenticated ? "#4CD964" : "#FF9500"} 
              />
              <Ionicons 
                name={syncStatus.isOnline ? "cloud" : "cloud-offline"} 
                size={20} 
                color={syncStatus.isOnline ? "#4CD964" : "#FF3B30"} 
                style={{ marginLeft: 4 }}
              />
              {syncStatus.pendingCount > 0 && (
                <View style={staticStyles.pendingBadge}>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>
                    {syncStatus.pendingCount}
                  </Text>
                </View>
              )}
            </Pressable>
          ),
          headerRight: () => (
            <View style={staticStyles.headerRightContainer}>
              <Pressable 
                onPress={handleAddCustomItem}
                style={{ marginRight: 16 }}
              >
                <Ionicons name="add" size={24} color="#007AFF" />
              </Pressable>
              <Pressable 
                onPress={handleRefresh}
                style={{ marginRight: 16 }}
                disabled={isRefreshing}
              >
                <Ionicons 
                  name={isRefreshing ? "sync" : "refresh"} 
                  size={24} 
                  color={isRefreshing ? "#999" : "#007AFF"} 
                />
              </Pressable>
              <View style={{ alignItems: 'center', marginRight: 8 }}>
                <Ionicons 
                  name="scan" 
                  size={24} 
                  color="#007AFF" 
                />
                <Text style={{ 
                  fontSize: 10, 
                  color: "#007AFF",
                  marginTop: 2
                }}>
                  Ready
                </Text>
              </View>
            </View>
          ),
        }}
      />

      {/* Barcode Scanner Component */}
      <BarcodeScanner
        onScan={handleBarcodeScan}
        onError={handleScanError}
        enabled={isScreenFocused && !showQuantityModal && !showSelectionModal && !showErrorModal && !showAddCustomItem && !showImageOverlay}
        minLength={8}
        maxLength={50}
        timeout={150}
      />

      {/* Header with stats and filters */}
      <View style={reorderStyles.headerSection}>
        {/* Stats / Maintenance Toggle - 5x1 Layout */}
        {!showMaintenanceButtons ? (
          // Show Stats with Cog Icon
          <View style={reorderStyles.statsContainer}>
            <View style={reorderStyles.statItem}>
              <View style={reorderStyles.statIconContainer}>
                <Text style={reorderStyles.statNumber}>{stats.total}</Text>
              </View>
              <Text style={reorderStyles.statLabel}>Total</Text>
            </View>
            <View style={reorderStyles.statItem}>
              <View style={reorderStyles.statIconContainer}>
                <Text style={reorderStyles.statNumber}>{stats.completed}</Text>
              </View>
              <Text style={reorderStyles.statLabel}>Completed</Text>
            </View>
            <View style={reorderStyles.statItem}>
              <View style={reorderStyles.statIconContainer}>
                <Text style={reorderStyles.statNumber}>{stats.incomplete}</Text>
              </View>
              <Text style={reorderStyles.statLabel}>Remaining</Text>
            </View>
            <View style={reorderStyles.statItem}>
              <View style={reorderStyles.statIconContainer}>
                <Text style={reorderStyles.statNumber}>{stats.totalQuantity}</Text>
              </View>
              <Text style={reorderStyles.statLabel}>Qty</Text>
            </View>
            {/* Cog Icon for Maintenance */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={() => setShowMaintenanceButtons(true)}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons name="cog" size={20} color="#666" />
              </View>
              <Text style={reorderStyles.statLabel}>Options</Text>
            </TouchableOpacity>
          </View>
        ) : (
          // Show Maintenance Buttons in same 5x1 layout
          <View style={reorderStyles.statsContainer}>
            {/* Mark Completed as Received */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={handleMarkCompletedAsReceived}
              disabled={stats.completed === 0}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons
                  name="checkmark-done"
                  size={20}
                  color={stats.completed === 0 ? '#ccc' : '#34C759'}
                />
              </View>
              <Text style={[
                reorderStyles.statLabel,
                { color: stats.completed === 0 ? '#ccc' : '#34C759' }
              ]}>
                Received
              </Text>
            </TouchableOpacity>

            {/* Clear All */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={handleClearAll}
              disabled={stats.total === 0}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons
                  name="trash"
                  size={20}
                  color={stats.total === 0 ? '#ccc' : '#FF3B30'}
                />
              </View>
              <Text style={[
                reorderStyles.statLabel,
                { color: stats.total === 0 ? '#ccc' : '#FF3B30' }
              ]}>
                Clear
              </Text>
            </TouchableOpacity>

            {/* Share/Export PDF */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={handleShareExportPDF}
              disabled={stats.total === 0}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons
                  name="share"
                  size={20}
                  color={stats.total === 0 ? '#ccc' : '#007AFF'}
                />
              </View>
              <Text style={[
                reorderStyles.statLabel,
                { color: stats.total === 0 ? '#ccc' : '#007AFF' }
              ]}>
                Export
              </Text>
            </TouchableOpacity>

            {/* Debug Cross-Reference */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={handleDebugCrossReference}
              disabled={stats.total === 0}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons
                  name="bug"
                  size={20}
                  color={stats.total === 0 ? '#ccc' : '#FF9500'}
                />
              </View>
              <Text style={[
                reorderStyles.statLabel,
                { color: stats.total === 0 ? '#ccc' : '#FF9500' }
              ]}>
                Debug
              </Text>
            </TouchableOpacity>

            {/* Close Button (X) */}
            <TouchableOpacity
              style={reorderStyles.statItem}
              onPress={() => setShowMaintenanceButtons(false)}
            >
              <View style={reorderStyles.statIconContainer}>
                <Ionicons name="close" size={20} color="#666" />
              </View>
              <Text style={reorderStyles.statLabel}>Close</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Filter Row */}
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={staticStyles.filterScrollContainer}
          style={staticStyles.filterScrollStyle}
        >
          {renderFilterButton('sortConfig', '', 'options')}
          {renderSortButton('chronological', 'Recent', 'time')}
          {renderSortButton('alphabetical', 'A-Z', 'text')}
          {renderFilterButton('incomplete', 'Incomplete', 'ellipse-outline')}
          {renderFilterButton('completed', 'Completed', 'checkmark-circle')}
          {renderFilterButton('category', 'Categories', 'folder')}
          {renderFilterButton('vendor', 'Vendors', 'business')}
        </ScrollView>
      </View>

      {/* Inline Dropdown Overlays */}
      {(showCategoryDropdown || showVendorDropdown || showConfigDropdown) && (
        <Pressable
          style={staticStyles.dropdownOverlay}
          onPress={() => {
            setShowCategoryDropdown(false);
            setShowVendorDropdown(false);
            setShowConfigDropdown(false);
          }}
        />
      )}

      {showCategoryDropdown && (
        <View style={staticStyles.dropdownContainer}>
          <View style={staticStyles.dropdownHeader}>
            <Text style={staticStyles.dropdownHeaderText}>
              Select Categories
            </Text>
            <Pressable
              style={{ position: 'absolute', right: 14, top: 14 }}
              onPress={() => setShowCategoryDropdown(false)}
            >
              <Ionicons name="close" size={20} color="#666" />
            </Pressable>
          </View>
          {renderCategoryDropdown(
            filterData.categories,
            selectedCategories,
            (categories) => {
              setSelectedCategories(categories);
            },
            'Categories'
          )}
        </View>
      )}

      {showVendorDropdown && (
        <View style={staticStyles.dropdownContainer}>
          <View style={staticStyles.dropdownHeader}>
            <Text style={staticStyles.dropdownHeaderText}>
              Select Vendor
            </Text>
          </View>
          {renderDropdown(
            filterData.vendors,
            selectedVendor,
            (value) => {
              setSelectedVendor(value);
              setShowVendorDropdown(false);
            },
            'Vendors'
          )}
        </View>
      )}

      {showConfigDropdown && (
        <View style={staticStyles.dropdownContainer}>
          <View style={staticStyles.dropdownHeader}>
            <Text style={staticStyles.dropdownHeaderText}>
              List Organization
            </Text>
          </View>
          
          <View style={staticStyles.configDropdownContent}>
            <Pressable
              style={staticStyles.configToggleButton}
              onPress={() => setSectionByCategory(!sectionByCategory)}
            >
              <Text style={staticStyles.configToggleText}>
                Group by Categories
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: sectionByCategory ? '#007AFF' : '#e0e0e0' }
              ]}>
                {sectionByCategory && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>
            
            <Pressable
              style={staticStyles.configToggleButtonLast}
              onPress={() => setSectionByVendor(!sectionByVendor)}
            >
              <Text style={staticStyles.configToggleText}>
                Group by Vendors
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: sectionByVendor ? '#007AFF' : '#e0e0e0' }
              ]}>
                {sectionByVendor && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>
            
            {sectionByVendor && sectionByCategory && (
              <Text style={staticStyles.configHelpText}>
                Vendor grouping takes precedence when both are enabled
              </Text>
            )}
          </View>

          {/* View Options Section */}
          <View style={staticStyles.dropdownHeader}>
            <Text style={staticStyles.dropdownHeaderText}>
              View Options
            </Text>
          </View>

          <View style={staticStyles.configDropdownContent}>
            <Pressable
              style={staticStyles.configToggleButton}
              onPress={() => setViewMode('list')}
            >
              <Text style={staticStyles.configToggleText}>
                List View
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: viewMode === 'list' ? '#007AFF' : '#e0e0e0' }
              ]}>
                {viewMode === 'list' && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>

            <Pressable
              style={staticStyles.configToggleButton}
              onPress={() => setViewMode('large-grid')}
            >
              <Text style={staticStyles.configToggleText}>
                Large Grid (1 per row)
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: viewMode === 'large-grid' ? '#007AFF' : '#e0e0e0' }
              ]}>
                {viewMode === 'large-grid' && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>

            <Pressable
              style={staticStyles.configToggleButton}
              onPress={() => setViewMode('medium-grid')}
            >
              <Text style={staticStyles.configToggleText}>
                Medium Grid (2 per row)
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: viewMode === 'medium-grid' ? '#007AFF' : '#e0e0e0' }
              ]}>
                {viewMode === 'medium-grid' && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>

            <Pressable
              style={staticStyles.configToggleButtonLast}
              onPress={() => setViewMode('small-grid')}
            >
              <Text style={staticStyles.configToggleText}>
                Small Grid (3 per row)
              </Text>
              <View style={[
                staticStyles.configToggleIcon,
                { backgroundColor: viewMode === 'small-grid' ? '#007AFF' : '#e0e0e0' }
              ]}>
                {viewMode === 'small-grid' && (
                  <Ionicons name="checkmark" size={16} color="#fff" />
                )}
              </View>
            </Pressable>
          </View>
        </View>
      )}

      {/* Reorder List */}
      <Pressable 
        style={reorderStyles.listContainer}
        onPress={() => {
          // Close dropdowns when tapping on the list area
          setShowCategoryDropdown(false);
          setShowVendorDropdown(false);
          setShowConfigDropdown(false);
          setShowSyncStatusPopover(false);
        }}
      >
        {sectionedData.length === 0 ? (
          renderEmptyState()
        ) : viewMode === 'list' ? (
          <FlatList
            data={sectionedData}
            renderItem={renderListItem}
            keyExtractor={keyExtractor}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={staticStyles.listContainerPadding}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor="#007AFF"
                title="Pull to refresh"
                titleColor="#666"
              />
            }
            // ENHANCED Performance optimizations for 1000+ items
            removeClippedSubviews={true}
            maxToRenderPerBatch={10}        // Increased for better performance
            updateCellsBatchingPeriod={50}  // Faster updates
            initialNumToRender={15}         // Show more items initially
            windowSize={10}                 // Larger window for smoother scrolling
            // Optimize memory usage
            disableVirtualization={false}
            legacyImplementation={false}
            // Performance boost for large lists
            getItemLayout={sectionedData.length > 100 ? undefined : (data, index) => ({
              length: 80, // Approximate item height
              offset: 80 * index,
              index,
            })}
            // Additional optimizations
            keyboardShouldPersistTaps="handled"
            maintainVisibleContentPosition={{
              minIndexForVisible: 0,
              autoscrollToTopThreshold: 10
            }}
          />
        ) : (
          <FlatList
            data={sectionedData.filter(item =>
              !('type' in item) || (item.type !== 'header' && item.type !== 'customEntry')
            ) as DisplayReorderItem[]}
            renderItem={renderGridItem}
            keyExtractor={keyExtractor}
            numColumns={viewMode === 'large-grid' ? 1 : viewMode === 'medium-grid' ? 2 : 3}
            key={viewMode} // Force re-render when view mode changes
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[staticStyles.listContainerPadding, { paddingHorizontal: 16 }]}
            columnWrapperStyle={viewMode !== 'large-grid' ? { justifyContent: 'space-between' } : undefined}
            refreshControl={
              <RefreshControl
                refreshing={isRefreshing}
                onRefresh={handleRefresh}
                tintColor="#007AFF"
                title="Pull to refresh"
                titleColor="#666"
              />
            }
            // Performance optimizations for grid
            removeClippedSubviews={true}
            maxToRenderPerBatch={viewMode === 'large-grid' ? 10 : viewMode === 'medium-grid' ? 8 : 6}
            initialNumToRender={viewMode === 'large-grid' ? 15 : viewMode === 'medium-grid' ? 12 : 9}
            windowSize={8}
            keyboardShouldPersistTaps="handled"
          />
        )}
      </Pressable>

      {/* Modals */}
      <QuantityModal
        visible={showQuantityModal}
        item={currentEditingItem}
        quantity={modalQuantity}
        setQuantity={setModalQuantity}
        onSubmit={handleQuantitySubmit}
        onCancel={() => {
          setShowQuantityModal(false);
          setCurrentEditingItem(null);
          setModalQuantity('1'); // Reset quantity on cancel
        }}
      />

      <ItemSelectionModal
        visible={showSelectionModal}
        items={multipleItems}
        onSelect={handleItemSelection}
        onCancel={() => {
          setShowSelectionModal(false);
          setMultipleItems([]);
        }}
      />

      {/* Error Modal */}
      <Modal visible={showErrorModal} transparent animationType="fade">
            <Pressable 
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20,
          }}
          onPress={() => {
            setShowErrorModal(false);
          }}
        >
          <View
            style={{
              backgroundColor: '#fff',
              borderRadius: 12,
              padding: 24,
              minWidth: 280,
              maxWidth: '90%',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 8,
              elevation: 8,
            }}
          >
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <Ionicons name="alert-circle" size={48} color="#FF6B6B" />
              <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#333', marginTop: 8 }}>
                Scan Failed
              </Text>
          </View>
            
            <Text style={{ 
              fontSize: 16, 
              color: '#666', 
              textAlign: 'center', 
              lineHeight: 24,
              marginBottom: 20
            }}>
              {errorMessage}
            </Text>
            
            <View style={{ alignItems: 'center' }}>
              <Text style={{ 
                fontSize: 14, 
                color: '#999', 
                textAlign: 'center',
                fontStyle: 'italic'
              }}>
                Scan another item to dismiss
              </Text>
      </View>
          </View>
        </Pressable>
      </Modal>

      {/* Sync Status Popover */}
      <Modal visible={showSyncStatusPopover} transparent animationType="fade">
        <Pressable 
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.5)',
            justifyContent: 'center',
            alignItems: 'center',
            padding: 20
          }}
          onPress={() => setShowSyncStatusPopover(false)}
        >
          <Pressable 
            style={{
              backgroundColor: '#fff',
              borderRadius: 16,
              padding: 24,
              maxWidth: 320,
              width: '100%',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.25,
              shadowRadius: 12,
              elevation: 8,
            }}
            onPress={(e) => e.stopPropagation()}
          >
            <View style={{ alignItems: 'center', marginBottom: 16 }}>
              <Text style={{
                fontSize: 18,
                fontWeight: '600',
                color: getSyncStatusExplanation().color,
                textAlign: 'center'
              }}>
                {getSyncStatusExplanation().title}
              </Text>
            </View>
            
            <Text style={{
              fontSize: 15,
              color: '#333',
              lineHeight: 22,
              textAlign: 'center',
              marginBottom: 20
            }}>
              {getSyncStatusExplanation().description}
            </Text>

            {/* Missing Data Status - Only show catalog issues for now */}
            {(stats.missingSquareData > 0 || stats.customItems > 0) && (
              <View style={{
                backgroundColor: '#f8f9fa',
                borderRadius: 8,
                padding: 12,
                marginBottom: 16
              }}>
                <Text style={{
                  fontSize: 14,
                  fontWeight: '600',
                  color: '#333',
                  marginBottom: 8,
                  textAlign: 'center'
                }}>
                  Data Status
                </Text>

                <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                  {stats.missingSquareData > 0 && (
                    <View style={{ alignItems: 'center' }}>
                      <View style={{
                        backgroundColor: '#FF6B6B',
                        borderRadius: 12,
                        minWidth: 24,
                        height: 24,
                        justifyContent: 'center',
                        alignItems: 'center'
                      }}>
                        <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>
                          {stats.missingSquareData}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 10, color: '#666', marginTop: 4, textAlign: 'center' }}>
                        Missing{'\n'}Catalog
                      </Text>
                    </View>
                  )}

                  {/* Team data status removed - not showing missing team data for now */}

                  {stats.customItems > 0 && (
                    <View style={{ alignItems: 'center' }}>
                      <View style={{
                        backgroundColor: '#007AFF',
                        borderRadius: 12,
                        minWidth: 24,
                        height: 24,
                        justifyContent: 'center',
                        alignItems: 'center'
                      }}>
                        <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>
                          {stats.customItems}
                        </Text>
                      </View>
                      <Text style={{ fontSize: 10, color: '#666', marginTop: 4, textAlign: 'center' }}>
                        Custom{'\n'}Items
                      </Text>
                    </View>
                  )}
                </View>
              </View>
            )}
            
            <View style={{
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: 20,
              paddingVertical: 12,
              paddingHorizontal: 16,
              backgroundColor: '#f8f9fa',
              borderRadius: 8
            }}>
              <View style={{ alignItems: 'center', marginRight: 20 }}>
                <Ionicons 
                  name={syncStatus.isAuthenticated ? "person" : "person-outline"} 
                  size={24} 
                  color={syncStatus.isAuthenticated ? "#4CD964" : "#FF9500"} 
                />
                <Text style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  {syncStatus.isAuthenticated ? 'Signed In' : 'Not Signed In'}
                </Text>
              </View>
              
              <View style={{ alignItems: 'center', marginRight: 20 }}>
                <Ionicons 
                  name={syncStatus.isOnline ? "cloud" : "cloud-offline"} 
                  size={24} 
                  color={syncStatus.isOnline ? "#4CD964" : "#FF3B30"} 
                />
                <Text style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                  {syncStatus.isOnline ? 'Online' : 'Offline'}
                </Text>
              </View>
              
              {syncStatus.pendingCount > 0 && (
                <View style={{ alignItems: 'center' }}>
                  <View style={{
                    backgroundColor: '#FF9500',
                    borderRadius: 12,
                    minWidth: 24,
                    height: 24,
                    justifyContent: 'center',
                    alignItems: 'center'
                  }}>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>
                      {syncStatus.pendingCount}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                    Pending
                  </Text>
                </View>
              )}
            </View>
            
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {syncStatus.pendingCount > 0 && (
                <Pressable
                  style={{
                    flex: 1,
                    backgroundColor: '#007AFF',
                    paddingVertical: 12,
                    paddingHorizontal: 16,
                    borderRadius: 8,
                    alignItems: 'center'
                  }}
                  onPress={() => {
                    setShowSyncStatusPopover(false);
                    handleRefresh();
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                    Sync Now
                  </Text>
                </Pressable>
              )}
              
              <Pressable
                style={{
                  flex: syncStatus.pendingCount > 0 ? 1 : 2,
                  backgroundColor: '#f0f0f0',
                  paddingVertical: 12,
                  paddingHorizontal: 16,
                  borderRadius: 8,
                  alignItems: 'center'
                }}
                onPress={() => setShowSyncStatusPopover(false)}
              >
                <Text style={{ color: '#333', fontSize: 16, fontWeight: '600' }}>
                  Close
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Image Overlay */}
      <ImageOverlay
        visible={showImageOverlay}
        imageUrl={selectedImageUrl}
        itemInfo={selectedItemInfo}
        onClose={() => {
          setShowImageOverlay(false);
          setSelectedItemInfo(null);
        }}
      />
    </SafeAreaView>
  );
});

export default ReordersScreen;