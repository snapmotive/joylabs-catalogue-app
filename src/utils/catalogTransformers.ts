import {
  CatalogObject,
  CatalogItemData,
  CatalogCategoryData,
  ConvertedItem,
  ConvertedCategory,
  CatalogImage
} from '../types/api';
import logger from './logger';
import { imageService } from '../services/imageService';

/**
 * Transforms a raw Square CatalogObject (ITEM type) into a frontend ConvertedItem.
 * Handles variations, pricing, and basic field mapping.
 */
export function transformCatalogItemToItem(
  catalogObject: CatalogObject | null | undefined
): ConvertedItem | null {
  if (!catalogObject || catalogObject.type !== 'ITEM' || !catalogObject.item_data) {
    // logger.warn('CatalogTransformer', 'Attempted to transform invalid CatalogObject item', { id: catalogObject?.id });
    return null;
  }

  const itemData = catalogObject.item_data;
  const variations = itemData.variations || [];

  // Extract modifier list IDs
  const modifierListInfo = itemData.modifier_list_info || [];
  const modifierListIds = modifierListInfo
    .filter((info: any) => info.enabled) // Only include enabled modifier lists
    .map((info: any) => info.modifier_list_id)
    .filter((id: any): id is string => typeof id === 'string'); // Ensure IDs are strings

  // Map variations to the structure expected by ConvertedItem
  const mappedVariations: Array<{
    id?: string;
    version?: number;
    name: string;
    sku: string | null;
    price?: number;
    barcode?: string;
    locationOverrides?: Array<{
      locationId: string;
      locationName?: string;
      price?: number;
    }>;
  }> = variations
    .map((variation: any) => {
      if (!variation.item_variation_data) return null;
      const varData = variation.item_variation_data;
      const price = varData.price_money ? varData.price_money.amount / 100 : undefined;

      // Extract location overrides if they exist
      const locationOverrides = varData.location_overrides?.map((override: any) => {
        // Only include overrides with price data
        if (!override.price_money) return null;
        
        return {
          locationId: override.location_id,
          // We don't have location name here, it will be filled by the component
          price: override.price_money.amount / 100 // Convert cents to dollars
        };
      }).filter(Boolean) || [];

      return {
        id: variation.id,
        version: variation.version,
        name: varData.name || '', // Default to empty string if name is missing
        sku: varData.sku || null, // Match ConvertedItem type (string | null)
        barcode: varData.upc || undefined, // Map upc to barcode
        price: price,
        locationOverrides: locationOverrides.length > 0 ? locationOverrides : undefined
      };
    })
    .filter((v: any): v is {
      id?: string;
      version?: number;
      name: string;
      sku: string | null;
      price?: number;
      barcode?: string;
      locationOverrides?: Array<{
        locationId: string;
        locationName?: string;
        price?: number;
      }>;
    } => v !== null);

  // Find the first variation to pull top-level price/sku/barcode (for backward compatibility/simplicity)
  // Prefer the one named 'Regular' or the first one if 'Regular' doesn't exist.
  const primaryVariation = 
    mappedVariations.find(v => v.name?.toLowerCase() === 'regular') || 
    mappedVariations[0] || 
    null;
  
  // Extract Image Data matching the ConvertedItem structure
  // CRITICAL FIX: image_ids are in item_data.image_ids according to Square's API
  // Note: Image URLs will be populated by the image cross-referencing service
  const images: { id: string; url: string; name: string }[] = (itemData.image_ids || []).map((imageId: string) => ({
    id: imageId,
    url: '', // Will be populated by imageService.populateImageUrls()
    name: '', // Will be populated by imageService.populateImageUrls()
  }));



  const transformed: ConvertedItem = {
    id: catalogObject.id,
    version: catalogObject.version, // Include top-level version
    name: itemData.name || '',
    description: itemData.description || '',
    isActive: !catalogObject.is_deleted, // Determine active status
    // Pull price/sku/barcode from primary variation for top-level convenience
    price: primaryVariation?.price,
    sku: primaryVariation?.sku || null, // Ensure sku matches ConvertedItem type (string | null)
    barcode: primaryVariation?.barcode,
    // --- Fields specifically from item_data ---
    taxIds: itemData.tax_ids || [], // Ensure it's an array
    modifierListIds: modifierListIds, // Assign extracted modifier IDs
    abbreviation: itemData.abbreviation || '',
    reporting_category_id: itemData.reporting_category?.id, // Directly use the ID
    categoryId: itemData.category_id, // Legacy single category for backward compatibility
    categories: itemData.categories ? itemData.categories.map((cat: { id: string; ordinal?: number }) => ({
      id: cat.id,
      ordinal: cat.ordinal
    })) : undefined, // Extract categories array from Square
    // --- Variations --- 
    variations: mappedVariations, // Assign the full list of mapped variations
    // --- Images --- 
    images: images, // Assign extracted/placeholder images
    // --- Timestamps & other optional ConvertedItem fields ---
    createdAt: catalogObject.created_at,
    updatedAt: catalogObject.updated_at,
    // variationId, variationVersion, variationName might need specific logic if required
    // category name lookup might be needed elsewhere
    // stock information not directly available here
  };

  // logger.debug('CatalogTransformer', 'Transformed item', { inputId: catalogObject.id, outputId: transformed.id, variationCount: transformed.variations.length });
  return transformed;
}

/**
 * Transforms a Square CatalogObject with type CATEGORY to our frontend Category model
 */
export const transformCatalogCategoryToCategory = (
  catalogObject: CatalogObject
): ConvertedCategory | null => {
  if (!catalogObject || catalogObject.type !== 'CATEGORY' || !catalogObject.category_data) {
    return null;
  }

  const categoryData = catalogObject.category_data as CatalogCategoryData;
  
  // Use a default color if none is specified
  const getRandomColor = () => {
    const colors = ['#4CD964', '#5AC8FA', '#FF9500', '#FF2D55', '#5856D6'];
    return colors[Math.floor(Math.random() * colors.length)];
  };
  
  return {
    id: catalogObject.id,
    name: categoryData.name,
    description: '',
    color: getRandomColor(), // Square doesn't have color in categories, so we assign one
    isActive: !catalogObject.is_deleted,
    createdAt: catalogObject.created_at,
    updatedAt: catalogObject.updated_at
  };
};

/**
 * Populate image URLs for a transformed ConvertedItem
 * This should be called after transformCatalogItemToItem to fill in actual image URLs
 */
export async function populateItemImages(item: ConvertedItem): Promise<ConvertedItem> {
  return await imageService.populateImageUrls(item);
}

/**
 * Populate image URLs for multiple ConvertedItems efficiently
 */
export async function populateItemImagesForItems(items: ConvertedItem[]): Promise<ConvertedItem[]> {
  return await imageService.populateImageUrlsForItems(items);
}

/**
 * Transforms a frontend Item model to a Square CatalogObject
 */
export const transformItemToCatalogItem = (
  item: ConvertedItem
): Partial<CatalogObject> => {
  // Convert dollars to cents for price
  const priceMoney = item.price !== undefined
    ? { amount: Math.round(item.price * 100), currency: 'USD' }
    : undefined;

  // Always create a default variation object
  const defaultVariation = {
    type: 'ITEM_VARIATION',
    id: `#variation-${item.id}`, // Note: This ID generation might need adjustment for updates vs creates
    present_at_all_locations: true,
    item_variation_data: {
      name: 'Regular', // Default variation name
      pricing_type: item.price !== undefined ? 'FIXED_PRICING' : 'VARIABLE_PRICING',
      price_money: priceMoney, // Include price_money only if defined (it's undefined otherwise)
      sku: item.sku, // Include SKU
      upc: item.barcode // Include barcode/UPC
    }
  };

  // If price is variable, explicitly remove the price_money field as required by Square API
  if (defaultVariation.item_variation_data.pricing_type === 'VARIABLE_PRICING') {
    delete defaultVariation.item_variation_data.price_money;
  }

  const variations = [defaultVariation];

  return {
    type: 'ITEM',
    id: item.id.startsWith('#') ? item.id : `#${item.id}`, // Square expects new item IDs to start with #
    present_at_all_locations: true,
    item_data: {
      name: item.name,
      description: item.description,
      category_id: item.categoryId,
      variations
    }
  };
};

/**
 * Transforms a frontend Category model to a Square CatalogObject
 */
export const transformCategoryToCatalogCategory = (
  category: ConvertedCategory
): Partial<CatalogObject> => {
  return {
    type: 'CATEGORY',
    id: category.id.startsWith('#') ? category.id : `#${category.id}`, // Square expects new item IDs to start with #
    present_at_all_locations: true,
    category_data: {
      name: category.name
    }
  };
}; 