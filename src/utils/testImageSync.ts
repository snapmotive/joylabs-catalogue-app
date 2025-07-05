import logger from './logger';
import * as modernDb from '../database/modernDb';
import { imageService } from '../services/imageService';

/**
 * Test utility to verify image sync functionality
 * This can be called from debug menus to test image syncing
 */
/**
 * Test specific item for image sync issues
 */
export async function testSpecificItemImageSync(itemId: string): Promise<{
  success: boolean;
  itemFound: boolean;
  itemData: any;
  imageIds: string[];
  imagesInDb: any[];
  error?: string;
}> {
  try {
    logger.info('TestImageSync', `Testing specific item: ${itemId}`);

    const db = await modernDb.getDatabase();

    // 1. Get the item from database
    const item = await db.getFirstAsync<{
      id: string;
      name: string;
      data_json: string;
    }>(`
      SELECT id, name, data_json
      FROM catalog_items
      WHERE id = ? AND is_deleted = 0
    `, [itemId]);

    if (!item) {
      return {
        success: false,
        itemFound: false,
        itemData: null,
        imageIds: [],
        imagesInDb: [],
        error: `Item ${itemId} not found in database`
      };
    }

    // 2. Parse item data and check for image_ids
    const itemData = JSON.parse(item.data_json);
    const imageIds = itemData.item_data?.image_ids || [];

    logger.info('TestImageSync', `Item ${item.name} analysis:`, {
      hasItemData: !!itemData.item_data,
      hasImageIds: !!itemData.item_data?.image_ids,
      imageIdsLength: imageIds.length,
      imageIds: imageIds,
      fullItemData: itemData
    });

    // 3. Check if these image IDs exist in images table
    let imagesInDb = [];
    if (imageIds.length > 0) {
      const placeholders = imageIds.map(() => '?').join(',');
      imagesInDb = await db.getAllAsync<{
        id: string;
        name: string;
        url: string;
        caption: string;
      }>(`
        SELECT id, name, url, caption
        FROM images
        WHERE id IN (${placeholders}) AND is_deleted = 0
      `, imageIds);

      logger.info('TestImageSync', `Found ${imagesInDb.length} images in database for item ${item.name}:`, imagesInDb);
    }

    return {
      success: true,
      itemFound: true,
      itemData: itemData,
      imageIds: imageIds,
      imagesInDb: imagesInDb
    };

  } catch (error) {
    logger.error('TestImageSync', 'Specific item test failed', error);
    return {
      success: false,
      itemFound: false,
      itemData: null,
      imageIds: [],
      imagesInDb: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * EMERGENCY FIX: Force database reinitialization
 */
export async function forceDbInit(): Promise<void> {
  try {
    logger.info('ForceDbInit', 'Force reinitializing database...');

    // Force close existing connection
    await modernDb.closeDatabase();

    // Force reinitialize
    await modernDb.initDatabase();

    logger.info('ForceDbInit', 'Database reinitialized successfully');
  } catch (error) {
    logger.error('ForceDbInit', 'Failed to reinitialize database', error);
    throw error;
  }
}

/**
 * SIMPLE FIX: Manually link images to items based on name matching
 */
export async function fixImageLinking(): Promise<void> {
  try {
    const db = await modernDb.getDatabase();

    // Get all images that contain item names
    const images = await db.getAllAsync<{
      id: string;
      name: string;
      url: string;
    }>(`
      SELECT id, name, url
      FROM images
      WHERE is_deleted = 0
      AND name LIKE '%Beyoglu%'
    `);

    logger.info('FixImageLinking', `Found ${images.length} Beyoglu images`);

    for (const image of images) {
      // Extract item name from image name: "Item Name_timestamp.jpg" -> "Item Name"
      const match = image.name.match(/^(.+?)_\d+\.(jpg|jpeg|png)$/i);
      if (match) {
        const itemName = match[1];

        // Find the item
        const item = await db.getFirstAsync<{
          id: string;
          name: string;
          data_json: string;
        }>(`
          SELECT id, name, data_json
          FROM catalog_items
          WHERE name = ? AND is_deleted = 0
        `, [itemName]);

        if (item) {
          // Parse item data
          const itemData = JSON.parse(item.data_json || '{}');
          if (!itemData.item_data) itemData.item_data = {};
          if (!itemData.item_data.image_ids) itemData.item_data.image_ids = [];

          // Add image ID if not present
          if (!itemData.item_data.image_ids.includes(image.id)) {
            itemData.item_data.image_ids.push(image.id);

            // Update item
            await db.runAsync(
              'UPDATE catalog_items SET data_json = ? WHERE id = ?',
              [JSON.stringify(itemData), item.id]
            );

            logger.info('FixImageLinking', `Linked image ${image.id} to item ${item.name}`);
          }
        }
      }
    }

    logger.info('FixImageLinking', 'Image linking complete');

    // CRITICAL: Clear store cache so items are refetched from database
    try {
      const { useAppStore } = await import('../store');
      const store = useAppStore.getState();
      store.clearProducts(); // Clear cached items so they're refetched with images
      logger.info('FixImageLinking', 'Cleared store cache - items will be refetched with images');
    } catch (storeError) {
      logger.warn('FixImageLinking', 'Failed to clear store cache', storeError);
    }

  } catch (error) {
    logger.error('FixImageLinking', 'Failed to fix image linking', error);
  }
}

export async function testImageSync(): Promise<{
  success: boolean;
  imageCount: number;
  sampleImages: Array<{ id: string; url: string; name: string }>;
  error?: string;
}> {
  try {
    logger.info('TestImageSync', 'Starting image sync test...');

    // 1. Check how many images are in the database
    const db = await modernDb.getDatabase();
    const imageCountResult = await db.getFirstAsync<{ count: number }>(`
      SELECT COUNT(*) as count FROM images WHERE is_deleted = 0 AND url IS NOT NULL AND url != ''
    `);
    
    const imageCount = imageCountResult?.count || 0;
    logger.info('TestImageSync', `Found ${imageCount} images in database`);

    // 2. Get a sample of images to test
    const sampleImages = await db.getAllAsync<{
      id: string;
      name: string;
      url: string;
      caption: string;
    }>(`
      SELECT id, name, url, caption 
      FROM images 
      WHERE is_deleted = 0 AND url IS NOT NULL AND url != ''
      LIMIT 5
    `);

    logger.info('TestImageSync', `Sample images:`, sampleImages);

    // 3. Test the image service with these sample images
    if (sampleImages.length > 0) {
      const imageIds = sampleImages.map(img => img.id);
      const imageData = await imageService.getImagesByIds(imageIds);
      
      logger.info('TestImageSync', `Image service returned data for ${imageData.size} images`);
      
      // Log cache stats
      const cacheStats = imageService.getCacheStats();
      logger.info('TestImageSync', 'Image service cache stats:', cacheStats);
    }

    // 4. Check if any items have image_ids
    const itemsWithImages = await db.getAllAsync<{
      id: string;
      name: string;
      data_json: string;
    }>(`
      SELECT id, name, data_json 
      FROM catalog_items 
      WHERE is_deleted = 0 
      AND data_json LIKE '%image_ids%'
      LIMIT 5
    `);

    logger.info('TestImageSync', `Found ${itemsWithImages.length} items with image_ids`);

    for (const item of itemsWithImages) {
      try {
        const itemData = JSON.parse(item.data_json);
        const imageIds = itemData.item_data?.image_ids || [];
        logger.info('TestImageSync', `Item ${item.name} has image_ids:`, imageIds);
      } catch (parseError) {
        logger.warn('TestImageSync', `Failed to parse item data for ${item.id}`, parseError);
      }
    }

    // 5. CRITICAL DIAGNOSTIC: Check if images have URLs
    const imagesWithoutUrls = await db.getAllAsync<{
      id: string;
      name: string;
      url: string;
    }>(`
      SELECT id, name, url
      FROM images
      WHERE is_deleted = 0
      AND (url IS NULL OR url = '')
      LIMIT 10
    `);

    logger.warn('TestImageSync', `Found ${imagesWithoutUrls.length} images WITHOUT URLs:`, imagesWithoutUrls);

    // 6. Check if any items reference these images
    if (imagesWithoutUrls.length > 0) {
      const imageIdsWithoutUrls = imagesWithoutUrls.map(img => img.id);
      const itemsReferencingBrokenImages = await db.getAllAsync<{
        id: string;
        name: string;
        data_json: string;
      }>(`
        SELECT id, name, data_json
        FROM catalog_items
        WHERE is_deleted = 0
        AND data_json LIKE '%${imageIdsWithoutUrls[0]}%'
        LIMIT 3
      `);

      logger.warn('TestImageSync', `Items referencing images without URLs:`,
        itemsReferencingBrokenImages.map(item => ({
          id: item.id,
          name: item.name,
          imageIds: JSON.parse(item.data_json).item_data?.image_ids || []
        }))
      );
    }

    return {
      success: true,
      imageCount,
      sampleImages: sampleImages.map(img => ({
        id: img.id,
        url: img.url,
        name: img.name || ''
      })),
      imagesWithoutUrls: imagesWithoutUrls.length,
      itemsWithImageIds: itemsWithImages.length
    };

  } catch (error) {
    logger.error('TestImageSync', 'Image sync test failed', error);
    return {
      success: false,
      imageCount: 0,
      sampleImages: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Test image population for a specific item
 */
export async function testItemImagePopulation(itemId: string): Promise<{
  success: boolean;
  originalImages: Array<{ id: string; url: string; name: string }>;
  populatedImages: Array<{ id: string; url: string; name: string }>;
  error?: string;
}> {
  try {
    logger.info('TestImageSync', `Testing image population for item ${itemId}`);

    // Get the item from database
    const db = await modernDb.getDatabase();
    const item = await db.getFirstAsync<{
      id: string;
      name: string;
      data_json: string;
    }>(`
      SELECT id, name, data_json 
      FROM catalog_items 
      WHERE id = ? AND is_deleted = 0
    `, [itemId]);

    if (!item) {
      throw new Error(`Item ${itemId} not found`);
    }

    const itemData = JSON.parse(item.data_json);
    const imageIds = itemData.item_data?.image_ids || [];
    
    logger.info('TestImageSync', `Item ${item.name} has ${imageIds.length} image_ids:`, imageIds);

    // Create a mock ConvertedItem with placeholder images
    const mockItem = {
      id: item.id,
      name: item.name,
      images: imageIds.map((imageId: string) => ({
        id: imageId,
        url: '',
        name: ''
      }))
    };

    const originalImages = [...mockItem.images];

    // Test image population
    const populatedItem = await imageService.populateImageUrls(mockItem as any);

    logger.info('TestImageSync', 'Image population result:', {
      originalCount: originalImages.length,
      populatedCount: populatedItem.images.length,
      populatedImages: populatedItem.images
    });

    return {
      success: true,
      originalImages,
      populatedImages: populatedItem.images
    };

  } catch (error) {
    logger.error('TestImageSync', 'Item image population test failed', error);
    return {
      success: false,
      originalImages: [],
      populatedImages: [],
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
