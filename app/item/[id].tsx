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
  Dimensions,
  StatusBar as RNStatusBar,
  Animated
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { CatalogueItem } from '../../src/types';
import { useCategories } from '../../src/hooks';

// Mock item for testing
const EMPTY_ITEM: CatalogueItem = {
  id: '',
  name: '',
  gtin: '',
  sku: '',
  reporting_category: '',
  price: null,
  tax: false,
  crv: false,
  description: ''
};

// Mock categories for testing
const MOCK_CATEGORIES = [
  { value: 'beverages', label: 'Beverages' },
  { value: 'bakery', label: 'Bakery' },
  { value: 'canned_goods', label: 'Canned Goods' },
  { value: 'dairy', label: 'Dairy' },
  { value: 'dry_goods', label: 'Dry Goods & Pasta' },
  { value: 'frozen_foods', label: 'Frozen Foods' },
  { value: 'meat', label: 'Meat & Seafood' },
  { value: 'produce', label: 'Produce' },
  { value: 'cleaners', label: 'Cleaners' },
  { value: 'paper_goods', label: 'Paper Goods' },
  { value: 'personal_care', label: 'Personal Care' },
  { value: 'other', label: 'Other' },
];

export default function ItemDetails() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const isNewItem = id === 'new';
  const priceInputRef = useRef<TextInput>(null);
  const scrollViewRef = useRef<ScrollView>(null);
  const descriptionRef = useRef<TextInput>(null);
  
  // Get categories or use mock data if none available
  const categoriesResult = useCategories();
  // Ensure we always have categories available
  const dropdownItems = categoriesResult?.dropdownItems?.length 
    ? categoriesResult.dropdownItems 
    : MOCK_CATEGORIES;
  
  // Log categories for debugging
  useEffect(() => {
    console.log("Available categories:", dropdownItems.length);
  }, [dropdownItems]);
  
  // State for form fields
  const [item, setItem] = useState<CatalogueItem>(EMPTY_ITEM);
  const [hasChanges, setHasChanges] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [priceText, setPriceText] = useState<string>('');
  
  // Tax states
  const [toggleAllTaxes, setToggleAllTaxes] = useState(false);
  const [southBayTax, setSouthBayTax] = useState(false);
  const [torranceTax, setTorranceTax] = useState(false);
  
  // Modifiers states
  const [crv5, setCrv5] = useState(false);
  const [crv10, setCrv10] = useState(false);
  
  // Additional state to maintain dropdown anchor position
  const [dropdownAnchorMode, setDropdownAnchorMode] = useState<'top' | 'bottom'>('bottom');
  
  // Category field states
  const [categorySearch, setCategorySearch] = useState('');
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [isCategoryFocused, setIsCategoryFocused] = useState(false);
  const categoryInputRef = useRef<TextInput>(null);
  
  // Memoized category search index for O(1) lookups
  const categorySearchIndex = useMemo(() => {
    const index: { [key: string]: string[] } = {};
    dropdownItems.forEach(item => {
      // Split the label into words and index each word
      const words = item.label.toLowerCase().split(/\s+/);
      words.forEach(word => {
        if (!index[word]) {
          index[word] = [];
        }
        index[word].push(item.label);
      });
    });
    return index;
  }, [dropdownItems]);

  // Memoized filtered categories based on search
  const filteredCategories = useMemo(() => {
    const searchTerm = categorySearch.toLowerCase().trim();
    if (!searchTerm) return dropdownItems;

    // Split search into words
    const searchWords = searchTerm.split(/\s+/);
    
    // Find categories that match all search words
    return dropdownItems.filter(item => {
      const itemWords = item.label.toLowerCase().split(/\s+/);
      return searchWords.every(searchWord => 
        itemWords.some(itemWord => itemWord.includes(searchWord))
      );
    }).slice(0, 30); // Limit to 30 results for performance
  }, [categorySearch, dropdownItems]);

  // Handle category selection
  const handleCategorySelect = useCallback((categoryValue: string, categoryLabel: string) => {
    // Batch state updates in a single animation frame
    requestAnimationFrame(() => {
      Keyboard.dismiss();
      setCategorySearch(categoryLabel);
      setShowCategoryModal(false);
      setIsCategoryFocused(false);
      
      setItem(prev => ({
        ...prev,
        reporting_category: categoryValue
      }));
    });
  }, []);

  // Handle category input changes
  const handleCategoryInputChange = useCallback((text: string) => {
    setCategorySearch(text);
    
    // Find exact match
    const category = dropdownItems.find(
      item => item.label.toLowerCase() === text.toLowerCase()
    );
    
    if (category) {
      // Batch state updates
      requestAnimationFrame(() => {
        setItem(prev => ({
          ...prev,
          reporting_category: category.value
        }));
      });
    }
  }, [dropdownItems]);

  // Handle keyboard dismiss
  const handleKeyboardDismiss = useCallback(() => {
    // Only run if we're actually focused
    if (!isCategoryFocused) return;
    
    Keyboard.dismiss();
    setIsCategoryFocused(false);
    
    // Batch state updates
    const exactMatch = dropdownItems.find(item => 
      item.label.toLowerCase() === categorySearch.toLowerCase()
    );
    
    if (!exactMatch) {
      // Batch the state updates together
      requestAnimationFrame(() => {
        setCategorySearch('');
        setItem(prev => ({
          ...prev,
          reporting_category: ''
        }));
      });
    }
  }, [categorySearch, dropdownItems, isCategoryFocused]);

  // Handlers for updating form values
  const updateItem = (key: keyof CatalogueItem, value: any) => {
    setItem(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  // Check if all fields are empty to determine if confirmation is needed
  const isEmpty = (item: CatalogueItem): boolean => {
    return (
      !item.name &&
      !item.gtin &&
      !item.sku &&
      !item.reporting_category &&
      (!item.price || item.price === 0) &&
      !item.tax &&
      !item.crv &&
      !item.description
    );
  };

  // Optimize input focus handling with useCallback
  const handleInputFocus = useCallback(() => {
    // No-op for now
  }, []);

  // Optimize scroll behavior for description field
  const handleDescriptionFocus = useCallback(() => {
    // Use requestAnimationFrame for smoother scrolling
    requestAnimationFrame(() => {
      if (scrollViewRef.current) {
        scrollViewRef.current.scrollTo({ y: 350, animated: true });
      }
    });
  }, []);

  // Listen for save events from the bottom tab bar
  useEffect(() => {
    const handleSaveEvent = () => {
      handleSave();
    };
    
    // For React Native we need a different approach since document is not available
    // This is a simplified example - in a real app, you'd use a state management 
    // library or context to communicate between components
    if (Platform.OS === 'web') {
      document.addEventListener('item:save', handleSaveEvent);
      return () => {
        document.removeEventListener('item:save', handleSaveEvent);
      };
    }
    
    // For native, we'll rely on the direct save button press
    return () => {};
  }, []);
  
  // Initialize item state from scan history or use empty item
  useEffect(() => {
    if (!isNewItem && id) {
      // This would normally fetch from API or local storage
      // For now, just use mock data if available
      const mockItem: CatalogueItem = {
        id: id as string,
        name: 'Example Item 1',
        gtin: '78432786234',
        sku: 'ASBD123',
        reporting_category: 'Drinks',
        price: 14.99,
        tax: true,
        crv: 5,
        description: ''
      };
      
      setItem(mockItem);
      if (typeof mockItem.price === 'number') {
        setPriceText(mockItem.price.toFixed(2));
      }
      
      // Set corresponding tax states
      setToggleAllTaxes(mockItem.tax === true);
      setSouthBayTax(mockItem.tax === true);
      setTorranceTax(mockItem.tax === true);
      
      // Set CRV modifiers
      if (mockItem.crv === 5) {
        setCrv5(true);
      } else if (mockItem.crv === 10) {
        setCrv10(true);
      }
    }
  }, [id, isNewItem]);

  const handleToggleAllTaxes = (value: boolean) => {
    setToggleAllTaxes(value);
    setSouthBayTax(value);
    setTorranceTax(value);
    updateItem('tax', value);
  };
  
  const handleCrv = (type: 'crv5' | 'crv10', value: boolean) => {
    if (type === 'crv5') {
      setCrv5(value);
      if (value) {
        setCrv10(false);
        updateItem('crv', 5);
      } else if (!crv10) {
        updateItem('crv', false);
      }
    } else {
      setCrv10(value);
      if (value) {
        setCrv5(false);
        updateItem('crv', 10);
      } else if (!crv5) {
        updateItem('crv', false);
      }
    }
  };
  
  const handleCancel = () => {
    if (hasChanges && !isEmpty(item)) {
      setShowConfirmation(true);
    } else {
      router.back();
    }
  };
  
  const handleConfirmCancel = () => {
    setShowConfirmation(false);
    router.back();
  };
  
  const handleSave = () => {
    console.log('Saving item:', item);
    // Here you would save to API or local storage
    router.back();
  };
  
  // Handle price input changes
  const handlePriceChange = useCallback((value: string) => {
    // Remove any non-numeric characters
    const numericValue = value.replace(/[^0-9]/g, '');
    
    if (!numericValue) {
      setPriceText('');
      setItem(prev => ({
        ...prev,
        price: null
      }));
      return;
    }
    
    // Convert to dollars with 2 decimal places
    const dollars = (parseInt(numericValue) / 100).toFixed(2);
    setPriceText(dollars);
    
    // Update item state with numeric value
    setItem(prev => ({
      ...prev,
      price: parseFloat(dollars)
    }));
  }, []);
  
  // Format price for display in preview
  const formattedPrice = useMemo(() => {
    if (typeof item.price === 'number' && !isNaN(item.price)) {
      return `$${item.price.toFixed(2)}`;
    }
    return '';  // Return empty string for variable pricing
  }, [item.price]);
  
  // Updated logic: show tax if any tax option is selected
  const showTax = southBayTax || torranceTax;
  const showCrv = item.crv !== false;
  const crvText = typeof item.crv === 'number' ? `+CRV${item.crv}` : '';

  // Add this helper function before the styles
  const highlightMatchingText = (text: string, query: string) => {
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return parts.map((part, index) => 
      part.toLowerCase() === query.toLowerCase() ? (
        <Text key={index} style={styles.highlightedText}>{part}</Text>
      ) : (
        <Text key={index}>{part}</Text>
      )
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Item Details</Text>
        <TouchableOpacity 
          style={styles.deleteButton}
          onPress={() => Alert.alert('Delete', 'Are you sure you want to delete this item?')}
        >
          <Text style={styles.deleteButtonText}>Delete</Text>
        </TouchableOpacity>
      </View>
      
      {/* Content Container */}
      <View style={styles.contentContainer}>
        {/* Preview section */}
        <View style={styles.previewContainer}>
          <View style={styles.previewInfo}>
            <Text style={styles.previewName}>{item.name || 'Enter Item Name'}</Text>
            <View style={styles.previewPriceContainer}>
              <Text style={styles.previewPrice}>{formattedPrice}</Text>
              <View style={styles.previewTags}>
                {showTax && <Text style={styles.previewTag}>+TAX</Text>}
                {showCrv && <Text style={styles.previewTag}>{crvText}</Text>}
              </View>
            </View>
          </View>
          
          <TouchableOpacity style={styles.imageContainer}>
            {/* Placeholder image area */}
            <View style={styles.imagePlaceholder}>
              <Ionicons name="image-outline" size={40} color="#888" />
              <Text style={styles.imagePlaceholderText}>Tap to add image</Text>
            </View>
          </TouchableOpacity>
        </View>
        
        {/* Scrollable container for form */}
        <ScrollView 
          ref={scrollViewRef}
          style={styles.scrollView}
          contentContainerStyle={styles.scrollViewContent}
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={true}
          scrollEventThrottle={16}
          onScrollBeginDrag={Keyboard.dismiss}
        >
          {/* Form section */}
          <TouchableWithoutFeedback onPress={handleKeyboardDismiss}>
            <View style={styles.formContainer}>
              {/* GTIN / SKU row */}
              <View style={styles.formRow}>
                <View style={styles.formColumn}>
                  <Text style={styles.label}>GTIN</Text>
                  <TextInput
                    style={styles.input}
                    value={item.gtin}
                    onChangeText={(value) => updateItem('gtin', value)}
                    onFocus={handleInputFocus}
                    placeholder="Enter GTIN"
                    keyboardType="numeric"
                    returnKeyType="next"
                    enablesReturnKeyAutomatically={true}
                  />
                </View>
                
                <View style={styles.formColumn}>
                  <Text style={styles.label}>SKU</Text>
                  <TextInput
                    style={styles.input}
                    value={item.sku}
                    onChangeText={(value) => updateItem('sku', value)}
                    onFocus={handleInputFocus}
                    placeholder="Enter SKU"
                    returnKeyType="next"
                    enablesReturnKeyAutomatically={true}
                  />
                </View>
              </View>
              
              {/* Item Name */}
              <Text style={styles.label}>Item Name</Text>
              <TextInput
                style={[styles.input, styles.marginBottom16]}
                value={item.name}
                onChangeText={(value) => updateItem('name', value)}
                onFocus={handleInputFocus}
                placeholder="Enter item name"
                returnKeyType="next"
                enablesReturnKeyAutomatically={true}
              />
              
              {/* Price / Category row */}
              <View style={styles.formRow}>
                <View style={styles.formColumn}>
                  <Text style={styles.label}>Selling Price</Text>
                  <View style={styles.priceInputContainer}>
                    <Text style={styles.dollarSign}>$</Text>
                    <TextInput
                      ref={priceInputRef}
                      style={styles.priceInput}
                      value={priceText}
                      onChangeText={handlePriceChange}
                      placeholder="Variable"
                      keyboardType="number-pad"
                      textAlign="right"
                      selectTextOnFocus={true}
                      returnKeyType="done"
                      enablesReturnKeyAutomatically={true}
                    />
                  </View>
                </View>
                
                <View style={styles.formColumn}>
                  <Text style={styles.label}>Category</Text>
                  <View style={styles.categoryContainer}>
                    <View style={styles.categoryInputContainer}>
                      <TextInput
                        ref={categoryInputRef}
                        style={styles.categoryInput}
                        value={categorySearch}
                        onChangeText={handleCategoryInputChange}
                        placeholder="Type to search categories"
                        onFocus={() => setIsCategoryFocused(true)}
                        onBlur={() => setIsCategoryFocused(false)}
                        numberOfLines={1}
                        multiline={false}
                        maxLength={100}
                        returnKeyType="done"
                        enablesReturnKeyAutomatically={true}
                      />
                      
                      <View style={styles.categoryInputButtons}>
                        {categorySearch ? (
                          <TouchableOpacity
                            style={styles.clearInputButton}
                            onPress={() => {
                              setCategorySearch('');
                              setItem(prev => ({
                                ...prev,
                                reporting_category: ''
                              }));
                              if (categoryInputRef.current) {
                                categoryInputRef.current.focus();
                              }
                            }}
                          >
                            <Ionicons name="close-circle" size={18} color="#999" />
                          </TouchableOpacity>
                        ) : null}
                        
                        <TouchableOpacity
                          style={styles.categoryBrowseButton}
                          onPress={() => setShowCategoryModal(true)}
                        >
                          <Ionicons name="list" size={20} color="#666" />
                        </TouchableOpacity>
                      </View>
                    </View>

                    {/* Category dropdown */}
                    {isCategoryFocused && filteredCategories.length > 0 && (
                      <View style={styles.categoryDropdown}>
                        <ScrollView 
                          style={styles.categoryDropdownScroll}
                          keyboardShouldPersistTaps="handled"
                          showsVerticalScrollIndicator={true}
                        >
                          {filteredCategories.map((category) => (
                            <TouchableOpacity
                              key={category.value}
                              style={styles.categoryDropdownItem}
                              onPress={() => handleCategorySelect(category.value, category.label)}
                            >
                              <Text style={styles.categoryDropdownText}>
                                {categorySearch ? (
                                  highlightMatchingText(category.label, categorySearch)
                                ) : (
                                  category.label
                                )}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </ScrollView>
                      </View>
                    )}
                  </View>
                </View>
              </View>
              
              {/* Taxes & Modifiers section */}
              <View style={styles.formRow}>
                <View style={styles.formColumn}>
                  <Text style={styles.label}>Taxes</Text>
                  <View style={styles.checkboxContainer}>
                    <View style={styles.checkboxRow}>
                      <TouchableOpacity
                        style={styles.checkbox}
                        onPress={() => handleToggleAllTaxes(!toggleAllTaxes)}
                      >
                        {toggleAllTaxes && <Ionicons name="checkmark" size={20} color="#000" />}
                      </TouchableOpacity>
                      <Text style={styles.checkboxLabel}>Toggle All</Text>
                    </View>
                    
                    <View style={styles.checkboxRow}>
                      <TouchableOpacity
                        style={styles.checkbox}
                        onPress={() => {
                          const newValue = !southBayTax;
                          setSouthBayTax(newValue);
                          // Update the main tax flag if any tax is selected
                          updateItem('tax', newValue || torranceTax);
                        }}
                      >
                        {southBayTax && <Ionicons name="checkmark" size={20} color="#000" />}
                      </TouchableOpacity>
                      <Text style={styles.checkboxLabel}>SOUTH BAY (9.5%)</Text>
                    </View>
                    
                    <View style={styles.checkboxRow}>
                      <TouchableOpacity
                        style={styles.checkbox}
                        onPress={() => {
                          const newValue = !torranceTax;
                          setTorranceTax(newValue);
                          // Update the main tax flag if any tax is selected
                          updateItem('tax', southBayTax || newValue);
                        }}
                      >
                        {torranceTax && <Ionicons name="checkmark" size={20} color="#000" />}
                      </TouchableOpacity>
                      <Text style={styles.checkboxLabel}>TORRANCE (10%)</Text>
                    </View>
                  </View>
                </View>
                
                <View style={styles.formColumn}>
                  <Text style={styles.label}>Modifiers</Text>
                  <View style={styles.checkboxContainer}>
                    <View style={styles.checkboxRow}>
                      <TouchableOpacity
                        style={styles.checkbox}
                        onPress={() => handleCrv('crv5', !crv5)}
                      >
                        {crv5 && <Ionicons name="checkmark" size={20} color="#000" />}
                      </TouchableOpacity>
                      <Text style={styles.checkboxLabel}>CRV5</Text>
                    </View>
                    
                    <View style={styles.checkboxRow}>
                      <TouchableOpacity
                        style={styles.checkbox}
                        onPress={() => handleCrv('crv10', !crv10)}
                      >
                        {crv10 && <Ionicons name="checkmark" size={20} color="#000" />}
                      </TouchableOpacity>
                      <Text style={styles.checkboxLabel}>CRV10</Text>
                    </View>
                  </View>
                </View>
              </View>
              
              {/* Description */}
              <Text style={styles.label} id="description-label">Description</Text>
              <TextInput
                ref={descriptionRef}
                style={[styles.input, styles.multilineInput]}
                value={item.description}
                onChangeText={(value) => updateItem('description', value)}
                onFocus={handleDescriptionFocus}
                placeholder="Enter item description"
                multiline
                numberOfLines={4}
                returnKeyType="done"
                blurOnSubmit={true}
              />
              
              {/* Add extra padding at the bottom to account for the tab bar and floating buttons */}
              <View style={styles.bottomPadding} />
            </View>
          </TouchableWithoutFeedback>
        </ScrollView>
      </View>
      
      {/* Floating Action Buttons Container */}
      <View style={styles.floatingButtonsContainer}>
        <TouchableOpacity 
          style={[styles.actionButton, styles.cancelButton]}
          onPress={handleCancel}
        >
          <Ionicons name="close" size={24} color="#fff" />
          <Text style={styles.actionButtonText}>
            {showConfirmation ? 'Confirm?' : 'Cancel'}
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.actionButton, styles.printButton]}
          onPress={() => console.log('Print functionality to be implemented')}
        >
          <Ionicons name="print" size={24} color="#fff" />
          <Text style={styles.actionButtonText}>Print</Text>
        </TouchableOpacity>
      </View>
      
      {/* Completely rebuild the category modal */}
      <Modal
        visible={showCategoryModal}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setShowCategoryModal(false)}
        statusBarTranslucent={true}
      >
        <TouchableWithoutFeedback onPress={() => setShowCategoryModal(false)}>
          <View style={styles.categoryModalContainer}>
            <TouchableWithoutFeedback onPress={(e) => e.stopPropagation()}>
              <View style={styles.categoryModalContent}>
                {/* Modal Header */}
                <View style={styles.categoryModalHeader}>
                  <Text style={styles.categoryModalTitle}>Select a Category</Text>
                  <TouchableOpacity 
                    onPress={() => setShowCategoryModal(false)}
                    style={styles.categoryModalCloseButton}
                    hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                  >
                    <Ionicons name="close" size={24} color="#333" />
                  </TouchableOpacity>
                </View>
                
                {/* Category List - implemented with ScrollView for better performance */}
                <ScrollView 
                  style={styles.categoryModalListScroll}
                  contentContainerStyle={styles.categoryModalListContainer}
                  showsVerticalScrollIndicator={true}
                  keyboardShouldPersistTaps="handled"
                >
                  {dropdownItems.map((category) => (
                    <TouchableOpacity
                      key={category.value}
                      style={styles.categoryModalItem}
                      onPress={() => handleCategorySelect(category.value, category.label)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.categoryModalItemText}>{category.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  contentContainer: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 60,
    paddingBottom: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
  },
  deleteButton: {
    backgroundColor: '#ff3b30',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 25,
  },
  deleteButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  scrollView: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollViewContent: {
    paddingBottom: 200, // Extra padding to ensure content is visible above bottom tab and floating buttons
  },
  previewContainer: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  previewInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  previewName: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  previewPriceContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
  previewPrice: {
    fontSize: 38,
    fontWeight: 'bold',
    marginRight: 10,
  },
  previewTags: {
    marginBottom: 8,
  },
  previewTag: {
    fontSize: 12, // Smaller tag text
    color: '#666',
  },
  imageContainer: {
    width: 140,
    height: 140,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
    overflow: 'hidden',
  },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f0f0f0',
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 8,
  },
  imagePlaceholderText: {
    marginTop: 8,
    color: '#888',
    fontSize: 12,
    textAlign: 'center',
  },
  formContainer: {
    padding: 16,
  },
  formRow: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  formColumn: {
    flex: 1,
    marginRight: 10,
  },
  label: {
    fontSize: 16,
    marginBottom: 8,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  marginBottom16: {
    marginBottom: 16,
  },
  multilineInput: {
    minHeight: 120,
    textAlignVertical: 'top',
    marginBottom: 16,
  },
  priceInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    marginBottom: 16,
  },
  dollarSign: {
    paddingLeft: 12,
    fontSize: 16,
  },
  priceInput: {
    flex: 1,
    padding: 12,
    fontSize: 16,
  },
  categoryContainer: {
    position: 'relative',
    zIndex: 1000,
  },
  categoryInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    backgroundColor: '#fff',
    marginBottom: 16,
  },
  categoryInput: {
    flex: 1,
    padding: 12,
    fontSize: 16,
    minWidth: 0,
  },
  categoryInputButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 'auto',
  },
  clearInputButton: {
    padding: 8,
  },
  categoryBrowseButton: {
    padding: 8,
    marginLeft: 4,
    borderLeftWidth: 1,
    borderLeftColor: '#ddd',
  },
  categoryDropdown: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    marginTop: -12,
    maxHeight: 200,
    zIndex: 1000,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  categoryDropdownScroll: {
    maxHeight: 200,
  },
  categoryDropdownItem: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  categoryDropdownText: {
    fontSize: 16,
    color: '#333',
  },
  highlightedText: {
    backgroundColor: '#fff3cd',
    fontWeight: '600',
  },
  checkboxContainer: {
    marginBottom: 16,
  },
  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderWidth: 1,
    borderColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  checkboxLabel: {
    fontSize: 16,
  },
  floatingButtonsContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    backgroundColor: '#fff',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    zIndex: 1000,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
  },
  cancelButton: {
    backgroundColor: '#ff3b30',
  },
  printButton: {
    backgroundColor: '#007aff',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginLeft: 8,
  },
  bottomPadding: {
    height: 100, // Extra padding to ensure content is visible above floating buttons and tab bar
  },
  categoryModalContainer: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  categoryModalContent: {
    backgroundColor: 'white',
    borderRadius: 16,
    width: '100%',
    maxWidth: 400,
    maxHeight: 500,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 10,
  },
  categoryModalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    backgroundColor: '#f9f9f9',
  },
  categoryModalTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#333',
  },
  categoryModalCloseButton: {
    padding: 6,
    borderRadius: 20,
  },
  categoryModalListScroll: {
    maxHeight: 400,
  },
  categoryModalListContainer: {
    paddingVertical: 8,
  },
  categoryModalItem: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  categoryModalItemText: {
    fontSize: 16,
    color: '#333',
  },
}); 