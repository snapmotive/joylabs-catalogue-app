import logger from '../utils/logger';
import * as modernDb from '../database/modernDb';
import { ConvertedItem } from '../types/api';

/**
 * Service for managing image cross-referencing and URL lookups
 * Maintains local-first architecture by caching image data from SQLite
 */
class ImageService {
  private imageCache = new Map<string, { url: string; name: string; caption?: string }>();
  private cacheTimestamp = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_CACHE_SIZE = 1000;

  constructor() {
    this.setupRealTimeUpdates();
  }

  /**
   * Get image data by image ID from local SQLite database
   */
  async getImageById(imageId: string): Promise<{ url: string; name: string; caption?: string } | null> {
    try {
      // Check cache first
      const cached = this.imageCache.get(imageId);
      if (cached && (Date.now() - this.cacheTimestamp) < this.CACHE_DURATION) {
        return cached;
      }

      // Query from database
      const db = await modernDb.getDatabase();
      const result = await db.getFirstAsync<{
        id: string;
        name: string;
        url: string;
        caption: string;
        is_deleted: number;
      }>(`
        SELECT id, name, url, caption, is_deleted
        FROM images 
        WHERE id = ? AND is_deleted = 0
      `, [imageId]);

      if (!result || !result.url) {
        return null;
      }

      const imageData = {
        url: result.url,
        name: result.name || '',
        caption: result.caption || undefined
      };

      // Cache the result
      this.cacheImage(imageId, imageData);
      
      return imageData;
    } catch (error) {
      logger.error('ImageService', 'Failed to get image by ID', { imageId, error });
      return null;
    }
  }

  /**
   * Get multiple images by their IDs efficiently
   */
  async getImagesByIds(imageIds: string[]): Promise<Map<string, { url: string; name: string; caption?: string }>> {
    const results = new Map<string, { url: string; name: string; caption?: string }>();
    
    if (!imageIds || imageIds.length === 0) {
      return results;
    }

    try {
      // Check cache for all IDs first
      const uncachedIds: string[] = [];
      const cacheValid = (Date.now() - this.cacheTimestamp) < this.CACHE_DURATION;
      
      for (const imageId of imageIds) {
        if (cacheValid && this.imageCache.has(imageId)) {
          const cached = this.imageCache.get(imageId)!;
          results.set(imageId, cached);
        } else {
          uncachedIds.push(imageId);
        }
      }

      // Query database for uncached IDs
      if (uncachedIds.length > 0) {
        const db = await modernDb.getDatabase();
        const placeholders = uncachedIds.map(() => '?').join(',');
        const dbResults = await db.getAllAsync<{
          id: string;
          name: string;
          url: string;
          caption: string;
          is_deleted: number;
        }>(`
          SELECT id, name, url, caption, is_deleted
          FROM images
          WHERE id IN (${placeholders}) AND is_deleted = 0
        `, uncachedIds); // This is correct - uncachedIds is already an array

        // Process database results
        for (const row of dbResults) {
          if (row.url) {
            const imageData = {
              url: row.url,
              name: row.name || '',
              caption: row.caption || undefined
            };
            results.set(row.id, imageData);
            this.cacheImage(row.id, imageData);


          }
        }
      }

      return results;
    } catch (error) {
      logger.error('ImageService', 'Failed to get images by IDs', { imageIds, error });
      return results;
    }
  }

  /**
   * Populate image URLs and names for a ConvertedItem
   */
  async populateImageUrls(item: ConvertedItem): Promise<ConvertedItem> {
    if (!item.images || item.images.length === 0) {
      return item;
    }

    try {
      const imageIds = item.images.map(img => img.id);
      const imageData = await this.getImagesByIds(imageIds);

      // Update the item's images with actual URLs and names
      const updatedImages = item.images.map(img => {
        const data = imageData.get(img.id);
        return {
          id: img.id,
          url: data?.url || '',
          name: data?.name || ''
        };
      }).filter(img => img.url); // Remove images without URLs

      return {
        ...item,
        images: updatedImages
      };
    } catch (error) {
      logger.error('ImageService', 'Failed to populate image URLs for item', { itemId: item.id, error });
      return item;
    }
  }

  /**
   * Populate image URLs for multiple ConvertedItems efficiently
   */
  async populateImageUrlsForItems(items: ConvertedItem[]): Promise<ConvertedItem[]> {
    if (!items || items.length === 0) {
      return items;
    }

    try {
      // Collect all unique image IDs
      const allImageIds = new Set<string>();
      for (const item of items) {
        if (item.images) {
          for (const img of item.images) {
            allImageIds.add(img.id);
          }
        }
      }

      // Get all image data in one batch
      const imageData = await this.getImagesByIds(Array.from(allImageIds));

      // Update all items
      return items.map(item => {
        if (!item.images || item.images.length === 0) {
          return item;
        }

        const updatedImages = item.images.map(img => {
          const data = imageData.get(img.id);
          return {
            id: img.id,
            url: data?.url || '',
            name: data?.name || ''
          };
        }).filter(img => img.url);

        return {
          ...item,
          images: updatedImages
        };
      });
    } catch (error) {
      logger.error('ImageService', 'Failed to populate image URLs for items', { itemCount: items.length, error });
      return items;
    }
  }

  /**
   * Cache an image data entry
   */
  private cacheImage(imageId: string, imageData: { url: string; name: string; caption?: string }) {
    // Implement simple LRU by clearing cache when it gets too large
    if (this.imageCache.size >= this.MAX_CACHE_SIZE) {
      this.clearCache();
    }

    this.imageCache.set(imageId, imageData);
    this.cacheTimestamp = Date.now();
  }

  /**
   * Clear the image cache
   */
  clearCache() {
    this.imageCache.clear();
    this.cacheTimestamp = 0;
    logger.debug('ImageService', 'Image cache cleared');
  }

  /**
   * Set up real-time updates for image cache invalidation using event-driven approach
   */
  private setupRealTimeUpdates(): void {
    try {
      // Import data change notifier dynamically to avoid circular dependencies
      import('./dataChangeNotifier').then(({ dataChangeNotifier }) => {
        // Listen for data changes and invalidate image caches
        dataChangeNotifier.addListener((event) => {
          if (event.table === 'images') {
            // Clear entire image cache when images change
            // This is simpler than tracking individual image IDs
            this.imageCache.clear();
            this.cacheTimestamp = 0;
            logger.debug('[ImageService]', 'Invalidated image cache due to image updates', {
              operation: event.operation,
              itemId: event.itemId
            });
          } else if (event.table === 'catalog_items') {
            // When catalog items change, their image associations might change
            // Clear cache to ensure fresh image data
            this.imageCache.clear();
            this.cacheTimestamp = 0;
            logger.debug('[ImageService]', 'Invalidated image cache due to catalog item updates', {
              operation: event.operation,
              itemId: event.itemId
            });
          }
        });

        logger.info('[ImageService]', 'Event-driven image cache invalidation set up');
      }).catch((error) => {
        logger.warn('[ImageService]', 'Failed to set up real-time updates', { error });
      });
    } catch (error) {
      logger.warn('[ImageService]', 'Failed to set up real-time updates', { error });
    }
  }

  /**
   * Get cache statistics for debugging
   */
  getCacheStats() {
    return {
      size: this.imageCache.size,
      maxSize: this.MAX_CACHE_SIZE,
      age: Date.now() - this.cacheTimestamp,
      maxAge: this.CACHE_DURATION
    };
  }
}

// Export singleton instance
export const imageService = new ImageService();
export default imageService;
