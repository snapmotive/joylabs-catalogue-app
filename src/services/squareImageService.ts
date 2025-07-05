import logger from '../utils/logger';
import { directSquareApi } from '../api';
import * as FileSystem from 'expo-file-system';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { v4 as uuidv4 } from 'uuid';
import { getDatabase } from '../database/modernDb';
import tokenService from '../services/tokenService';
import { imageService } from '../services/imageService';

export interface SquareImageUploadResult {
  success: boolean;
  imageId?: string;
  imageUrl?: string;
  error?: string;
}

export interface SquareImageDeleteResult {
  success: boolean;
  error?: string;
}

/**
 * Service for managing Square catalog images
 * Handles upload, update, and delete operations with Square API
 */
interface ImageData {
  id: string;
  name: string;
  url: string;
  squareUrl?: string;
  caption?: string;
  itemId: string;
}

class SquareImageService {

  /**
   * Convert image to JPEG format if needed for Square API compatibility
   */
  private async convertToJpegIfNeeded(imageUri: string, imageName: string): Promise<{ uri: string; name: string }> {
    try {
      // Validate inputs
      if (!imageUri || !imageName) {
        logger.warn('SquareImageService', 'Invalid inputs for image conversion', { imageUri, imageName });
        return { uri: imageUri, name: imageName };
      }

      // Check if the image is HEIC format
      const isHeic = imageName.toLowerCase().includes('.heic') ||
                     imageName.toLowerCase().includes('.heif') ||
                     imageUri.toLowerCase().includes('.heic') ||
                     imageUri.toLowerCase().includes('.heif');

      if (!isHeic) {
        // Already in a supported format
        logger.debug('SquareImageService', 'Image already in supported format, no conversion needed', {
          imageName,
          format: imageName.split('.').pop()?.toLowerCase()
        });
        return { uri: imageUri, name: imageName };
      }

      logger.info('SquareImageService', 'Converting HEIC image to JPEG for Square compatibility', {
        originalUri: imageUri,
        originalName: imageName
      });

      // Verify file exists before conversion
      const fileInfo = await FileSystem.getInfoAsync(imageUri);
      if (!fileInfo.exists) {
        throw new Error(`Image file does not exist: ${imageUri}`);
      }

      // Convert HEIC to JPEG
      const result = await manipulateAsync(
        imageUri,
        [], // No transformations, just format conversion
        {
          compress: 0.8, // Good quality compression
          format: SaveFormat.JPEG,
        }
      );

      // Validate conversion result
      if (!result || !result.uri) {
        throw new Error('Image conversion returned invalid result');
      }

      // Generate new name with .jpg extension
      const newName = imageName.replace(/\.(heic|heif)$/i, '.jpg');

      logger.info('SquareImageService', 'HEIC to JPEG conversion successful', {
        originalUri: imageUri,
        convertedUri: result.uri,
        originalName: imageName,
        convertedName: newName,
        originalSize: await this.getFileSize(imageUri),
        convertedSize: await this.getFileSize(result.uri)
      });

      return { uri: result.uri, name: newName };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown conversion error';
      logger.error('SquareImageService', 'Failed to convert image format', {
        error: errorMessage,
        imageUri,
        imageName,
        fullError: error
      });
      // Return original if conversion fails - let Square API handle the error
      return { uri: imageUri, name: imageName };
    }
  }

  /**
   * Get file size for logging purposes
   */
  private async getFileSize(uri: string): Promise<string> {
    try {
      const info = await FileSystem.getInfoAsync(uri);
      if (info.exists && 'size' in info) {
        return `${Math.round(info.size / 1024)}KB`;
      }
      return 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  /**
   * Upload a new image with different behavior for existing vs new items
   * - Existing items: Complete CRUD operation immediately
   * - New items: Just return image data for React state (save on item save)
   */
  async uploadImage(
    imageUri: string,
    imageName: string,
    itemId: string
  ): Promise<SquareImageUploadResult> {
    try {
      // Convert image to JPEG if needed for Square API compatibility
      const { uri: convertedUri, name: convertedName } = await this.convertToJpegIfNeeded(imageUri, imageName);

      const isNewItem = itemId === 'new-item-temp' || !itemId;

      logger.info('SquareImageService', 'Starting image upload', {
        originalName: imageName,
        convertedName,
        itemId,
        isNewItem,
        strategy: isNewItem ? 'defer-until-save' : 'immediate-crud'
      });

      // Generate image ID and placeholder URL
      const imageId = `placeholder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const squareImageUrl = `https://placeholder-images.example.com/${imageId}.jpg`;

      if (isNewItem) {
        // NEW ITEMS: Just return image data for React state
        // Actual upload will happen when item is saved
        logger.info('SquareImageService', 'New item - deferring upload until item save', {
          imageId,
          itemId
        });

        return {
          success: true,
          imageId,
          imageUrl: convertedUri // Return converted URI for immediate display
        };

      } else {
        // EXISTING ITEMS: Complete CRUD operation immediately
        logger.info('SquareImageService', 'Existing item - performing immediate CRUD', {
          imageId,
          itemId
        });

        // Step 1: Create image in Square (upload file)
        logger.info('SquareImageService', 'Step 1: Creating image in Square', {
          imageId,
          itemId
        });

        const squareUploadResult = await this.uploadImageToSquare(convertedUri, convertedName, imageId, itemId);
        if (!squareUploadResult.success) {
          throw new Error(`Square image creation failed: ${squareUploadResult.error}`);
        }

        const actualSquareImageId = squareUploadResult.imageId!;
        const actualSquareImageUrl = squareUploadResult.imageUrl!;
        logger.info('SquareImageService', 'Step 1 completed: Image created in Square', {
          actualSquareImageId,
          squareImageUrl: actualSquareImageUrl,
          originalUri: imageUri
        });

        // Step 2: Save to local database
        // Note: Image is already attached to item via object_id + is_primary in CreateCatalogImage
        await this.saveImageToDatabase(actualSquareImageId, {
          id: actualSquareImageId,
          name: convertedName, // Use converted name
          url: actualSquareImageUrl, // Use Square URL for persistence
          squareUrl: actualSquareImageUrl, // Store actual Square URL
          caption: `Image for item ${itemId}`,
          itemId: itemId
        });

        // Step 3: Associate with item in local database
        await this.associateImageWithItem(actualSquareImageId, itemId);

        // Step 4: Clear image service cache to ensure fresh data is loaded
        imageService.clearCache();
        logger.info('SquareImageService', 'Image service cache cleared');

        // Step 5: Notify data change listeners for real-time updates
        try {
          const { dataChangeNotifier } = await import('./dataChangeNotifier');
          dataChangeNotifier.notifyImageChange('CREATE', actualSquareImageId, {
            id: actualSquareImageId,
            name: convertedName, // Use converted name
            url: actualSquareImageUrl,
            itemId: itemId
          });
          dataChangeNotifier.notifyCatalogItemChange('UPDATE', itemId, { imageAdded: true });
          logger.info('SquareImageService', 'Real-time update notifications sent');
        } catch (notificationError) {
          logger.warn('SquareImageService', 'Failed to send real-time notifications', { notificationError });
        }

        logger.info('SquareImageService', 'Complete CRUD operation successful', {
          actualSquareImageId,
          itemId,
          localUri: imageUri,
          squareUrl: actualSquareImageUrl
        });

        return {
          success: true,
          imageId: actualSquareImageId,
          imageUrl: actualSquareImageUrl // Return Square URL for persistence
        };
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('SquareImageService', 'Image upload failed', {
        error: errorMessage,
        imageName,
        itemId,
        fullError: error
      });
      return {
        success: false,
        error: errorMessage
      };
    }
  }

  /**
   * Update an existing image in Square
   */
  async updateImage(
    imageId: string,
    newImageUri: string,
    newImageName: string
  ): Promise<SquareImageUploadResult> {
    try {
      logger.info('SquareImageService', 'Starting image update', { imageId, newImageName });

      // 1. Upload the new image file to replace the existing one
      const uploadResult = await this.uploadImageFile(imageId, newImageUri);
      
      if (!uploadResult.success) {
        throw new Error(`Failed to upload new image file: ${uploadResult.error}`);
      }

      // 2. Update the image metadata if name changed
      if (newImageName) {
        await this.updateImageMetadata(imageId, newImageName);
      }

      logger.info('SquareImageService', 'Image update completed successfully', {
        imageId,
        imageUrl: uploadResult.imageUrl
      });

      return {
        success: true,
        imageId,
        imageUrl: uploadResult.imageUrl
      };

    } catch (error) {
      logger.error('SquareImageService', 'Image update failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Delete an image from Square and remove it from the item
   */
  async deleteImage(imageId: string, itemId?: string): Promise<SquareImageDeleteResult> {
    try {
      logger.info('SquareImageService', 'Starting image deletion', { imageId, itemId });

      // 1. Remove image from item if itemId provided
      if (itemId) {
        await this.removeImageFromItem(itemId, imageId);
      }

      // 2. Check if this is a placeholder ID (from failed uploads)
      const isPlaceholder = imageId.startsWith('placeholder-');

      if (isPlaceholder) {
        logger.info('SquareImageService', 'Skipping Square deletion for placeholder ID', { imageId });
      } else {
        // 3. Delete the image object from Square (only for real Square IDs)
        logger.info('SquareImageService', 'Deleting real Square image', { imageId });
        const deleteResponse = await directSquareApi.deleteCatalogObject(imageId);

        if (!deleteResponse.success) {
          throw new Error(`Failed to delete image from Square: ${deleteResponse.error?.message || 'Unknown error'}`);
        }

        logger.info('SquareImageService', 'Square image deletion successful', { imageId });
      }

      // 4. Delete from local database (always, regardless of placeholder status)
      await this.deleteImageFromDatabase(imageId);

      // 5. Clear image service cache to ensure fresh data is loaded
      imageService.clearCache();
      logger.info('SquareImageService', 'Image service cache cleared after deletion');

      // 6. Notify data change listeners for real-time updates
      try {
        const { dataChangeNotifier } = await import('./dataChangeNotifier');
        dataChangeNotifier.notifyImageChange('DELETE', imageId, { imageId });
        if (itemId) {
          dataChangeNotifier.notifyCatalogItemChange('UPDATE', itemId, { imageDeleted: true });
        }
        logger.info('SquareImageService', 'Real-time deletion notifications sent');
      } catch (notificationError) {
        logger.warn('SquareImageService', 'Failed to send real-time deletion notifications', { notificationError });
      }

      logger.info('SquareImageService', 'Image deletion completed successfully', {
        imageId,
        wasPlaceholder: isPlaceholder,
        deletedFromSquare: !isPlaceholder
      });

      return { success: true };

    } catch (error) {
      logger.error('SquareImageService', 'Image deletion failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Upload image file to Square using the CreateCatalogImage endpoint
   */
  private async uploadImageToSquare(imageUri: string, imageName: string, imageId: string, itemId: string): Promise<{ success: boolean; imageId?: string; imageUrl?: string; error?: string }> {
    try {
      logger.info('SquareImageService', 'Starting Square CreateCatalogImage API call', { imageId, imageUri });

      // Read the image file
      const fileInfo = await FileSystem.getInfoAsync(imageUri);
      if (!fileInfo.exists) {
        throw new Error('Image file does not exist');
      }

      // Use FileSystem.uploadAsync for proper multipart upload
      const authHeaders = await tokenService.getAuthHeaders();

      // JSON part with image metadata - Upload AND attach in one call
      const imageRequest = {
        idempotency_key: uuidv4(),
        object_id: itemId, // Attach to item immediately
        image: {
          id: "#TEMP_ID", // Square expects this for new images
          type: 'IMAGE',
          image_data: {
            name: imageName,
            caption: `Uploaded via JoyLabs app`
          }
        }
        // Note: NOT setting is_primary - let Square add to end of image_ids array
      };

      logger.info('SquareImageService', 'Using FileSystem.uploadAsync for multipart upload', {
        imageUri,
        imageName,
        requestData: imageRequest
      });

      const squareResponse = await FileSystem.uploadAsync(
        'https://connect.squareup.com/v2/catalog/images',
        imageUri,
        {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          headers: {
            ...authHeaders,
            'Square-Version': '2025-04-16',
          },
          parameters: {
            request: JSON.stringify(imageRequest)
          }
        }
      );

      if (squareResponse.status !== 200) {
        throw new Error(`Square API error: ${squareResponse.status} ${squareResponse.body}`);
      }

      const result = JSON.parse(squareResponse.body);

      if (!result.image || !result.image.image_data) {
        throw new Error('Invalid response from Square CreateCatalogImage API');
      }

      const actualImageId = result.image.id;
      const squareImageUrl = result.image.image_data.url;

      logger.info('SquareImageService', 'Square CreateCatalogImage successful', {
        actualImageId,
        squareImageUrl,
        placeholderImageId: imageId
      });

      // CRITICAL FIX: Manually add image to item's image_ids array
      // Square doesn't automatically do this even with object_id set
      try {
        await this.addImageToSquareItem(actualImageId, itemId);
        logger.info('SquareImageService', 'Successfully linked image to item', {
          actualImageId,
          itemId
        });
      } catch (linkError) {
        logger.error('SquareImageService', 'Failed to link image to item', {
          actualImageId,
          itemId,
          error: linkError
        });
        // Don't fail the whole operation - image was created successfully
      }

      return {
        success: true,
        imageId: actualImageId, // Return the actual Square-generated image ID
        imageUrl: squareImageUrl
      };

    } catch (error) {
      logger.error('SquareImageService', 'Square CreateCatalogImage failed', { error, imageId });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Add an image to a Square item's image_ids array
   */
  async addImageToSquareItem(imageId: string, itemId: string): Promise<void> {
    try {
      // 1. Retrieve the current item
      const itemResponse = await directSquareApi.retrieveCatalogObject(itemId, false);
      
      if (!itemResponse.success || !itemResponse.data?.object) {
        throw new Error('Failed to retrieve item for image association');
      }

      const item = itemResponse.data.object;
      const currentImageIds = item.item_data?.image_ids || [];
      
      // 2. Add the new image ID if not already present
      if (!currentImageIds.includes(imageId)) {
        const updatedItem = {
          ...item,
          item_data: {
            ...item.item_data,
            image_ids: [...currentImageIds, imageId]
          }
        };

        // 3. Update the item
        const updateResponse = await directSquareApi.upsertCatalogObject(
          updatedItem,
          uuidv4() // idempotency key
        );

        if (!updateResponse.success) {
          throw new Error('Failed to update item with new image');
        }

        logger.info('SquareImageService', 'Successfully added image to Square item', {
          itemId,
          imageId,
          totalImages: updatedItem.item_data.image_ids.length
        });
      }

    } catch (error) {
      logger.error('SquareImageService', 'Failed to add image to Square item', { error, itemId, imageId });
      throw error;
    }
  }

  /**
   * Remove an image from an item's image_ids array
   */
  private async removeImageFromItem(itemId: string, imageId: string): Promise<void> {
    try {
      // 1. Retrieve the current item
      const itemResponse = await directSquareApi.retrieveCatalogObject(itemId, false);
      
      if (!itemResponse.success || !itemResponse.data?.object) {
        throw new Error('Failed to retrieve item for image removal');
      }

      const item = itemResponse.data.object;
      const currentImageIds = item.item_data?.image_ids || [];
      
      // 2. Remove the image ID
      const updatedImageIds = currentImageIds.filter((id: string) => id !== imageId);
      
      if (updatedImageIds.length !== currentImageIds.length) {
        const updatedItem = {
          ...item,
          item_data: {
            ...item.item_data,
            image_ids: updatedImageIds
          }
        };

        // 3. Update the item
        const updateResponse = await directSquareApi.upsertCatalogObject(
          updatedItem,
          uuidv4() // idempotency key
        );

        if (!updateResponse.success) {
          throw new Error('Failed to update item after image removal');
        }

        logger.info('SquareImageService', 'Successfully removed image from item', { itemId, imageId });
      }

    } catch (error) {
      logger.error('SquareImageService', 'Failed to remove image from item', error);
      throw error;
    }
  }

  /**
   * Update image metadata (name, caption)
   */
  private async updateImageMetadata(imageId: string, newName: string): Promise<void> {
    try {
      // 1. Retrieve the current image object
      const imageResponse = await directSquareApi.retrieveCatalogObject(imageId, false);
      
      if (!imageResponse.success || !imageResponse.data?.object) {
        throw new Error('Failed to retrieve image for metadata update');
      }

      const image = imageResponse.data.object;
      
      // 2. Update the metadata
      const updatedImage = {
        ...image,
        image_data: {
          ...image.image_data,
          name: newName,
          caption: `Image for ${newName}`
        }
      };

      // 3. Update the image object
      const updateResponse = await directSquareApi.upsertCatalogObject(
        updatedImage,
        uuidv4() // idempotency key
      );

      if (!updateResponse.success) {
        throw new Error('Failed to update image metadata');
      }

      logger.info('SquareImageService', 'Successfully updated image metadata', { imageId, newName });

    } catch (error) {
      logger.error('SquareImageService', 'Failed to update image metadata', error);
      throw error;
    }
  }

  /**
   * Save image data to local database
   */
  private async saveImageToDatabase(imageId: string, imageData: ImageData): Promise<void> {
    try {
      logger.info('SquareImageService', 'Saving image to local database', { imageId, itemId: imageData.itemId });

      const db = await getDatabase();

      // Save to images table
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
            squareUrl: imageData.squareUrl,
            caption: imageData.caption,
            itemId: imageData.itemId
          })
        ]
      );

      logger.info('SquareImageService', 'Image saved to database successfully', { imageId });

      // Verify the save by reading it back
      const verifyResult = await db.getFirstAsync<{ id: string; url: string; name: string }>(
        `SELECT id, url, name FROM images WHERE id = ?`, [imageId]
      );
      logger.info('SquareImageService', 'Database save verification', {
        imageId,
        found: !!verifyResult,
        url: verifyResult?.url,
        name: verifyResult?.name
      });
    } catch (error) {
      logger.error('SquareImageService', 'Failed to save image to database', { error, imageId });
      throw error;
    }
  }

  /**
   * Associate image with item in database
   */
  private async associateImageWithItem(imageId: string, itemId: string): Promise<void> {
    try {
      logger.info('SquareImageService', 'Associating image with item', { imageId, itemId });

      const db = await getDatabase();

      // Get current item data
      const itemResult = await db.getFirstAsync<{
        id: string;
        data_json: string;
      }>(`SELECT id, data_json FROM catalog_items WHERE id = ?`, [itemId]);

      if (itemResult) {
        const currentData = itemResult.data_json ? JSON.parse(itemResult.data_json) : {};
        const currentImageIds = currentData.image_ids || [];

        // Add the new image ID if not already present
        if (!currentImageIds.includes(imageId)) {
          const updatedData = {
            ...currentData,
            image_ids: [...currentImageIds, imageId]
          };

          // Update the item with new image_ids
          await db.runAsync(
            `UPDATE catalog_items SET data_json = ?, updated_at = ? WHERE id = ?`,
            [JSON.stringify(updatedData), new Date().toISOString(), itemId]
          );

          logger.info('SquareImageService', 'Image associated with item successfully', {
            itemId,
            imageId,
            totalImages: updatedData.image_ids.length
          });

          // Verify the association by reading it back
          const verifyResult = await db.getFirstAsync<{ id: string; data_json: string }>(
            `SELECT id, data_json FROM catalog_items WHERE id = ?`, [itemId]
          );
          if (verifyResult) {
            const verifyData = JSON.parse(verifyResult.data_json || '{}');
            logger.info('SquareImageService', 'Item association verification', {
              itemId,
              imageId,
              currentImageIds: verifyData.image_ids || [],
              imageFound: (verifyData.image_ids || []).includes(imageId)
            });
          }
        } else {
          logger.info('SquareImageService', 'Image already associated with item', { itemId, imageId });
        }
      } else {
        logger.warn('SquareImageService', 'Item not found in database', { itemId });
        throw new Error(`Item ${itemId} not found in database`);
      }
    } catch (error) {
      logger.error('SquareImageService', 'Failed to associate image with item', { error, imageId, itemId });
      throw error;
    }
  }

  /**
   * Reorder images for an item (used for making an image primary)
   * According to Square's API: the first image in image_ids array is the primary image
   */
  async reorderImages(itemId: string, newImageIds: string[]): Promise<SquareImageUploadResult> {
    try {
      logger.info('SquareImageService', 'Starting image reorder to make image primary', { itemId, newImageIds });

      // 1. First get the current item from Square to get the real image_ids order
      const itemResponse = await directSquareApi.retrieveCatalogObject(itemId, false);

      if (!itemResponse.success || !itemResponse.data?.object) {
        throw new Error('Failed to retrieve current item from Square');
      }

      const currentSquareItem = itemResponse.data.object;
      const currentSquareImageIds = currentSquareItem.item_data?.image_ids || [];

      logger.info('SquareImageService', 'Current Square image order vs requested order', {
        currentSquareImageIds,
        requestedNewOrder: newImageIds
      });

      // 2. Filter out placeholder IDs for Square (but keep them for local database)
      const realSquareImageIds = newImageIds.filter(id => !id.startsWith('placeholder-'));

      logger.info('SquareImageService', 'Updating image order in Square', {
        itemId,
        allImageIds: newImageIds,
        realSquareImageIds,
        filteredOutPlaceholders: newImageIds.filter(id => id.startsWith('placeholder-'))
      });

      // 3. Update Square with the new image order (only real Square IDs)
      const updatePayload = {
        type: 'ITEM',
        id: itemId,
        version: currentSquareItem.version,
        item_data: {
          ...currentSquareItem.item_data,
          image_ids: realSquareImageIds // Only send real Square IDs in new order
        }
      };

      const squareResponse = await directSquareApi.upsertCatalogObject(updatePayload, uuidv4());

      if (!squareResponse.success) {
        throw new Error(`Failed to update image order in Square: ${squareResponse.error?.message || 'Unknown error'}`);
      }

      logger.info('SquareImageService', 'Square image order update successful', {
        itemId,
        newSquareOrder: realSquareImageIds
      });

      // 4. Update the local database to match the new order (including placeholders)
      const db = await getDatabase();
      const currentLocalItem = await db.getFirstAsync<{ data_json: string }>(
        `SELECT data_json FROM catalog_items WHERE id = ? AND is_deleted = 0`,
        [itemId]
      );

      if (!currentLocalItem) {
        throw new Error(`Item ${itemId} not found in local database`);
      }

      const localItemData = JSON.parse(currentLocalItem.data_json || '{}');
      localItemData.image_ids = newImageIds; // Store ALL image IDs including placeholders

      await db.runAsync(
        `UPDATE catalog_items SET data_json = ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(localItemData), new Date().toISOString(), itemId]
      );

      // 5. Skip data change notification for image reordering to prevent reload loops
      // The UI is already updated optimistically in the calling component
      logger.info('SquareImageService', 'Skipping data change notification for image reorder to prevent reload loops');

      logger.info('SquareImageService', 'Image reorder completed successfully', {
        itemId,
        newLocalOrder: newImageIds,
        newSquareOrder: realSquareImageIds,
        primaryImageId: newImageIds[0]
      });

      return { success: true };

    } catch (error) {
      logger.error('SquareImageService', 'Failed to reorder images', { itemId, imageIds, error });
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  }

  /**
   * Delete an image from the local database
   */
  private async deleteImageFromDatabase(imageId: string): Promise<void> {
    try {
      logger.info('SquareImageService', 'Deleting image from local database', { imageId });

      const db = await getDatabase();

      // Mark image as deleted (soft delete)
      await db.runAsync(
        `UPDATE images SET is_deleted = 1, updated_at = ? WHERE id = ?`,
        [new Date().toISOString(), imageId]
      );

      logger.info('SquareImageService', 'Image deleted from local database successfully', { imageId });

    } catch (error) {
      logger.error('SquareImageService', 'Failed to delete image from database', { imageId, error });
      throw error;
    }
  }

}

// Export singleton instance
export const squareImageService = new SquareImageService();
export default squareImageService;
