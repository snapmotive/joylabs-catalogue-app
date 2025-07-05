import * as Network from 'expo-network';
import { SQLiteDatabase } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import logger from '../utils/logger';
import * as modernDb from './modernDb';
import * as SecureStore from 'expo-secure-store';
import { directSquareApi } from '../api';
import tokenService from '../services/tokenService';
import NotificationService from '../services/notificationService';

// Constants for token storage to check validity
const SQUARE_ACCESS_TOKEN_KEY = 'square_access_token';
const TOKEN_EXPIRY_KEY = 'square_token_expiry';
const MIN_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const AUTO_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour

// Constants for sync operations
const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SYNC_ATTEMPTS = 3;
const INITIAL_SYNC_ITEMS_PER_BATCH = 100;

// Sync status interface
export interface SyncStatus {
  lastSyncTime: string | null;
  isSyncing: boolean;
  syncError: string | null;
  syncProgress: number;
  syncTotal: number;
  syncType: string | null;
  lastSyncAttempt: string | null;
  syncAttemptCount: number;
  last_page_cursor?: string | null;
  // Legacy properties for backwards compatibility
  syncedItems?: number;
  totalItems?: number;
}

// --- Define CatalogObjectFromApi locally ---
type CatalogObjectFromApi = {
    type: string;
    id: string;
    updated_at: string;
    version: number | string;
    is_deleted?: boolean;
    present_at_all_locations?: boolean;
    item_data?: any;
    category_data?: any;
    tax_data?: any;
    discount_data?: any;
    modifier_list_data?: any;
    modifier_data?: any;
    item_variation_data?: any;
    image_data?: any;
};
// --- Remove incorrect import ---
// import { CatalogObjectFromApi } from './modernDb';

/**
 * Service for catalog synchronization operations
 */
export class CatalogSyncService {
  private static instance: CatalogSyncService;
  private db: SQLiteDatabase | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private autoSyncEnabled: boolean = false; // Default to no automatic syncing
  private listeners: Map<string, (status: SyncStatus) => void> = new Map();
  
  /**
   * Get the singleton instance of the CatalogSyncService
   */
  public static getInstance(): CatalogSyncService {
    if (!CatalogSyncService.instance) {
      CatalogSyncService.instance = new CatalogSyncService();
    }
    return CatalogSyncService.instance;
  }
  
  /**
   * Initialize the sync service
   */
  public async initialize(): Promise<void> {
    try {
      logger.info('CatalogSync', 'Initializing sync service');
      this.db = await modernDb.getDatabase();
      
      // Check sync status
      const status = await this.getSyncStatus();
      
      // If syncing was interrupted, reset status
      if (status.isSyncing) {
        logger.warn('CatalogSync', 'Previous sync was interrupted - resetting status');
        await this.updateSyncStatus({
          isSyncing: false,
          syncError: 'Previous sync was interrupted',
          syncProgress: 0,
          syncTotal: 0
        });
      }
      
      // Don't schedule automatic syncs by default
      // this.scheduleNextSync();
      
      logger.info('CatalogSync', 'Sync service initialized successfully');
    } catch (error) {
      logger.error('CatalogSync', 'Failed to initialize sync service', { error });
      throw new Error(`Failed to initialize sync service: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Enable or disable automatic sync scheduling
   */
  public setAutoSync(enabled: boolean): void {
    this.autoSyncEnabled = enabled;
    logger.info('CatalogSync', `Auto sync ${enabled ? 'enabled' : 'disabled'}`);
    
    // Clear any existing timers
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    
    // If enabling, schedule the next sync
    if (enabled) {
      this.scheduleNextSync();
    }
  }
  
  /**
   * Schedule the next sync based on last sync time
   */
  public scheduleNextSync(): void {
    // If auto sync is disabled, don't schedule anything
    if (!this.autoSyncEnabled) {
      logger.info('CatalogSync', 'Automatic sync is disabled - not scheduling next sync');
      return;
    }
    
    // Clear any existing timer
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    
    // Calculate next sync time
    this.getSyncStatus().then(status => {
      if (!status.lastSyncTime) {
        // If never synced, schedule for a future time rather than immediately
        logger.info('CatalogSync', 'Never synced - scheduling sync in 1 hour');
        this.syncTimer = setTimeout(() => this.startBackgroundSync(), 60 * 60 * 1000); // 1 hour
        return;
      }
      
      const lastSync = new Date(status.lastSyncTime).getTime();
      const now = Date.now();
      const elapsed = now - lastSync;
      
      if (elapsed >= SYNC_INTERVAL) {
        // If interval passed, schedule for a reasonable future time
        logger.info('CatalogSync', 'Sync interval passed - scheduling sync in 10 minutes');
        this.syncTimer = setTimeout(() => this.startBackgroundSync(), 10 * 60 * 1000); // 10 minutes
      } else {
        // Schedule for next interval
        const timeUntilNextSync = SYNC_INTERVAL - elapsed;
        logger.info('CatalogSync', `Scheduling next sync in ${Math.round(timeUntilNextSync / (60 * 1000))} minutes`);
        this.syncTimer = setTimeout(() => this.startBackgroundSync(), timeUntilNextSync);
      }
    }).catch(error => {
      logger.error('CatalogSync', 'Failed to schedule next sync', { error });
      // Schedule retry in 30 minutes
      this.syncTimer = setTimeout(() => this.scheduleNextSync(), 30 * 60 * 1000);
    });
  }
  
  /**
   * Get the current sync status
   */
  public async getSyncStatus(): Promise<SyncStatus> {
    try {
      // Don't do any API refreshes or extra work here - purely get the status from database
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      // Try to get sync status
      try {
        const result = await this.db.getFirstAsync<{
          last_sync_time: string | null;
          is_syncing: number;
          sync_error: string | null;
          sync_progress: number;
          sync_total: number;
          sync_type: string | null;
          last_sync_attempt: string | null;
          sync_attempt_count: number;
          last_page_cursor?: string | null;
        }>('SELECT * FROM sync_status WHERE id = 1');
        
        if (!result) {
          throw new Error('No sync status record found');
        }
        
        return {
          lastSyncTime: result.last_sync_time,
          isSyncing: result.is_syncing === 1,
          syncError: result.sync_error,
          syncProgress: result.sync_progress,
          syncTotal: result.sync_total,
          syncType: result.sync_type,
          lastSyncAttempt: result.last_sync_attempt,
          syncAttemptCount: result.sync_attempt_count,
          last_page_cursor: result.last_page_cursor,
        };
      } catch (dbError) {
        // If there's an error, it might be a schema issue - reset the database
        logger.warn('CatalogSync', 'Failed to get sync status, resetting database', { error: dbError });
        await modernDb.resetDatabase();
        this.db = await modernDb.getDatabase();
        
        // Return default status
        return {
          lastSyncTime: null,
          isSyncing: false,
          syncError: 'Database was reset due to errors',
          syncProgress: 0,
          syncTotal: 0,
          syncType: null,
          lastSyncAttempt: null,
          syncAttemptCount: 0,
          last_page_cursor: undefined,
        };
      }
    } catch (error) {
      logger.error('CatalogSync', 'Failed to get sync status', { error });
      
      // Return default status on error
      return {
        lastSyncTime: null,
        isSyncing: false,
        syncError: `Failed to get sync status: ${error instanceof Error ? error.message : String(error)}`,
        syncProgress: 0,
        syncTotal: 0,
        syncType: null,
        lastSyncAttempt: null,
        syncAttemptCount: 0,
        last_page_cursor: undefined,
      };
    }
  }
  
  /**
   * Update the sync status
   */
  public async updateSyncStatus(updates: Partial<SyncStatus>): Promise<void> {
    try {
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      const setValues: string[] = [];
      const params: any[] = [];
      
      if (updates.lastSyncTime !== undefined) {
        setValues.push('last_sync_time = ?');
        params.push(updates.lastSyncTime);
      }
      
      if (updates.isSyncing !== undefined) {
        setValues.push('is_syncing = ?');
        params.push(updates.isSyncing ? 1 : 0);
      }
      
      if (updates.syncError !== undefined) {
        setValues.push('sync_error = ?');
        params.push(updates.syncError);
      }
      
      if (updates.syncProgress !== undefined) {
        setValues.push('sync_progress = ?');
        params.push(updates.syncProgress);
      }
      
      if (updates.syncTotal !== undefined) {
        setValues.push('sync_total = ?');
        params.push(updates.syncTotal);
      }
      
      if (updates.syncType !== undefined) {
        setValues.push('sync_type = ?');
        params.push(updates.syncType);
      }
      
      if (updates.lastSyncAttempt !== undefined) {
        setValues.push('last_sync_attempt = ?');
        params.push(updates.lastSyncAttempt);
      }
      
      if (updates.syncAttemptCount !== undefined) {
        setValues.push('sync_attempt_count = ?');
        params.push(updates.syncAttemptCount);
      }
      
      if (updates.last_page_cursor !== undefined) {
        setValues.push('last_page_cursor = ?');
        params.push(updates.last_page_cursor);
      }
      
      if (setValues.length === 0) {
        return; // Nothing to update
      }
      
      params.push(1); // Add ID parameter
      
      const query = `UPDATE sync_status SET ${setValues.join(', ')} WHERE id = ?`;
      try {
        await this.db.runAsync(query, params);
        logger.debug('CatalogSync', 'Updated sync status', updates);
      } catch (dbError) {
        // If there's an error updating, it might be a schema issue
        logger.warn('CatalogSync', 'Error updating sync status, might be schema issue', { error: dbError });
        
        // Check if this is a "no such column" error
        const errorStr = String(dbError);
        if (errorStr.includes('no such column:')) {
          // Schema mismatch, reset database
          logger.warn('CatalogSync', 'Missing column detected, resetting database schema');
          await modernDb.resetDatabase();
          this.db = await modernDb.getDatabase();
          
          // Retry the update with the fresh database
          const newQuery = `UPDATE sync_status SET ${setValues.join(', ')} WHERE id = ?`;
          await this.db.runAsync(newQuery, params);
        } else {
          // Re-throw for other types of errors
          throw dbError;
        }
      }
    } catch (error) {
      logger.error('CatalogSync', 'Failed to update sync status', { error, updates });
      throw new Error(`Failed to update sync status: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  /**
   * Check that we have proper authentication before starting sync.
   * Uses tokenService to ensure a valid token exists and handles refresh.
   */
  private async checkAuthentication(): Promise<void> {
    const tag = 'CatalogSync:checkAuth';
    logger.debug(tag, 'Checking authentication via tokenService...');
    try {
      const token = await tokenService.ensureValidToken(); // Use the service
      if (!token) {
        // This case might not be strictly necessary if ensureValidToken throws, but good practice
        logger.warn(tag, 'tokenService.ensureValidToken returned null/empty token.');
        throw new Error('Authentication failed: No valid token available.');
      }
      logger.debug(tag, 'Authentication check passed via tokenService.');
    } catch (error: any) {
      // Catch errors thrown by ensureValidToken (e.g., refresh failed, no tokens)
      logger.error(tag, 'Authentication check failed via tokenService', { error: error.message });
      // Re-throw a consistent error message for the sync process
      throw new Error('Authentication failed: Could not ensure a valid token.');
    }
  }
  
  /**
   * Manually trigger a full catalog sync
   * @param skipCategorySync Whether to skip syncing categories (speeds up full sync)
   */
  public async forceFullSync(): Promise<boolean> {
    logger.info('CatalogSync', 'Forcing full sync...');
    try {
      await this.runFullSync();
      return true; // Indicate sync process was started
    } catch (error) {
      logger.error('CatalogSync', 'Forced full sync failed to start or run', { error });
      return false; // Indicate failure
    }
  }
  
  /**
   * Starts the sync process in the background.
   * Currently triggers a full sync.
   */
  public async startBackgroundSync(): Promise<boolean> {
    logger.info('CatalogSync', 'Starting background sync...');
    try {
      // For now, background sync triggers a full sync
      await this.runFullSync();
      return true; // Indicate sync process was started
    } catch (error) {
      logger.error('CatalogSync', 'Background sync failed to start or run', { error });
      return false; // Indicate failure
    }
  }
  
  /**
   * Reset sync status in case of stuck sync
   */
  public async resetSyncStatus(): Promise<void> {
    logger.info('CatalogSync', 'Resetting sync status in database...');
    if (!this.db) {
      this.db = await modernDb.getDatabase();
    }
    await this.db.runAsync(
      `UPDATE sync_status SET 
         last_sync_time = NULL, 
         is_syncing = 0, 
         sync_error = NULL, 
         sync_progress = 0, 
         sync_total = 0, 
         sync_type = NULL, 
         last_page_cursor = NULL, 
         last_sync_attempt = NULL, 
         sync_attempt_count = 0 
       WHERE id = 1`
    );
    logger.info('CatalogSync', 'Sync status reset.');
  }

  /**
   * Debug method to check if items exist in the database
   */
  public async checkItemsInDatabase(): Promise<{ categoryCount: number; itemCount: number }> {
    logger.debug('CatalogSync', 'Checking item counts in database...');
    const { counts } = await modernDb.checkDatabaseContent(); 
    
    // Define the expected row type (matching modernDb.ts)
    type CountRow = { table_name: string; count: number };

    // Helper to find count, using the now typed `counts` array
    const getCount = (tableName: string): number => {
      // Find the row, but treat it as potentially unknown first
      const row = counts.find((r: unknown): r is CountRow => 
        typeof r === 'object' && r !== null && (r as CountRow).table_name === tableName
      );
      // Now `row` is correctly typed as CountRow | undefined
      return row ? row.count : 0;
    };

    return { 
      categoryCount: getCount('categories'),
      itemCount: getCount('catalog_items')
      // Add other counts if needed
    };
  }

  /**
   * Run a full catalog sync
   */
  public async runFullSync(): Promise<{ itemCount: number, categoryCount: number }> {
    const status = await this.getSyncStatus();
    if (status.isSyncing) {
      logger.warn('CatalogSync', 'Full sync aborted - another sync is already in progress');
      return { itemCount: 0, categoryCount: 0 };
    }
    
    logger.info('CatalogSync', 'Starting full sync...');
    await this.updateSyncStatus({
      isSyncing: true,
      syncError: null,
      syncProgress: 0,
      syncTotal: 0, // Reset total, will be set by each batch
      syncType: 'full',
      lastSyncAttempt: new Date().toISOString(),
      syncAttemptCount: (status.syncAttemptCount || 0) + 1
    });
    
    let totalItemsSynced = 0;
    let totalCategoriesSynced = 0;

    try {
      // Step 1: Clear existing catalog data
      logger.info('CatalogSync', 'Clearing existing catalog data...');
      await modernDb.clearCatalogData();
      
      // Step 2: Fetch all catalog data from Square in pages
      let cursor: string | undefined = undefined;
      const objectTypes = "ITEM,CATEGORY,TAX,MODIFIER_LIST,DISCOUNT,IMAGE";
      
      // Loop to handle pagination
      do {
        logger.info('CatalogSync', `Fetching catalog page... ${cursor ? `(cursor: ${cursor})` : ''}`);
        
        // Use directSquareApi to make the API call
        const response = await directSquareApi.fetchCatalogPage(1000, cursor, objectTypes);

        const objects = response.objects || [];
        const newCursor = response.cursor;

        if (objects && objects.length > 0) {
          logger.info('CatalogSync', `Fetched ${objects.length} objects from Square`);
          await modernDb.upsertCatalogObjects(objects);
          
          // Update counts
          totalItemsSynced += objects.filter((o: CatalogObjectFromApi) => o.type === 'ITEM').length;
          totalCategoriesSynced += objects.filter((o: CatalogObjectFromApi) => o.type === 'CATEGORY').length;

          // Update sync progress
          await this.updateSyncStatus({
            syncProgress: totalItemsSynced + totalCategoriesSynced, // Simple progress for now
            syncTotal: (status.syncTotal || 0) + objects.length
          });
        }
        
        cursor = newCursor || undefined;
        
      } while (cursor);
      
      // Step 3: CRITICAL FIX - Link images to items after sync
      logger.info('CatalogSync', 'Starting post-sync image linking...');
      try {
        await this.linkImagesToItems();
        logger.info('CatalogSync', 'Post-sync image linking completed');
      } catch (linkError) {
        logger.error('CatalogSync', 'Post-sync image linking failed', linkError);
        // Don't fail the whole sync for this
      }

      // Step 4: Finalize sync
      logger.info('CatalogSync', 'Full sync completed successfully');
      await this.updateSyncStatus({
        isSyncing: false,
        lastSyncTime: new Date().toISOString(),
        syncError: null,
        syncAttemptCount: 0 // Reset attempt count on success
      });

      // CRITICAL FIX: Send single bulk notification after sync completes
      try {
        const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
        dataChangeNotifier.notifyChange({
          table: 'catalog_items',
          operation: 'UPDATE',
          itemId: 'BULK_SYNC_COMPLETE',
          timestamp: Date.now(),
          data: { syncType: 'full', itemCount: totalItemsSynced, categoryCount: totalCategoriesSynced }
        });
        logger.info('CatalogSync', 'Sent bulk sync completion notification');
      } catch (error) {
        logger.warn('CatalogSync', 'Failed to send sync completion notification', { error });
      }

      return { itemCount: totalItemsSynced, categoryCount: totalCategoriesSynced };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('CatalogSync', 'Full sync failed', { error: errorMessage });
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: errorMessage
      });
      // Re-throw to allow UI to handle the error
      throw error;
    }
  }

  // --- New Method: runIncrementalSync ---
  public async runIncrementalSync(): Promise<void> {
    const syncTag = 'CatalogSync:Incremental';
    logger.info(syncTag, 'Starting incremental sync...');

    // 1. Check authentication and network
    try {
      await this.checkAuthentication();
      const networkState = await Network.getNetworkStateAsync();
      if (!networkState.isConnected || !networkState.isInternetReachable) {
        logger.warn(syncTag, 'No internet connection. Aborting incremental sync.');
        throw new Error('No internet connection');
      }
    } catch (authError: any) {
       logger.error(syncTag, 'Authentication or network check failed', { error: authError.message });
      // No need to update sync status here as it's a prerequisite check
      return; // Stop execution
    }

    // 2. Check if another sync is already running
    const currentStatus = await this.getSyncStatus();
    if (currentStatus.isSyncing) {
      logger.warn(syncTag, 'Another sync operation is already in progress. Skipping.');
      return;
    }

    // 3. Mark sync as started
    const syncStartTime = new Date().toISOString();
    await this.updateSyncStatus({
      isSyncing: true,
      syncType: 'incremental',
      syncError: null,
      syncProgress: 0, // Reset progress for incremental
      syncTotal: 0, // Total is unknown for incremental
      lastSyncAttempt: syncStartTime,
      syncAttemptCount: (currentStatus.syncAttemptCount || 0) + 1,
      last_page_cursor: null, // Clear full sync cursor if running incremental
    });
    logger.info(syncTag, 'Sync status updated to indicate start.');

    let currentCursor: string | null | undefined = null;
    let processedObjectCount = 0;
    let hasMorePages = true;
    let lastFetchedCursor: string | null = null; // Store the cursor received from the last *successful* API call

    try {
      // 4. Get the starting cursor from the last incremental sync
      currentCursor = await modernDb.getLastIncrementalSyncCursor();
      lastFetchedCursor = currentCursor; // Initialize with stored cursor
      logger.info(syncTag, 'Retrieved last incremental sync cursor', { cursor: currentCursor ? '******' : null });

      // 5. Loop through pages of changes
      do {
        logger.debug(syncTag, `Fetching changes page with cursor: ${currentCursor ? '******' : 'None'}`);
        const response = await directSquareApi.searchCatalogObjects(undefined, currentCursor || undefined); // Use direct Square API

        if (!response.success) {
          throw new Error(`Direct Square API error: ${response.error?.message || 'Unknown error'}`);
        }

        const objects = response.objects ?? [];
        const receivedCursor = response.cursor; // Cursor for the *next* page
        hasMorePages = !!receivedCursor;

        logger.debug(syncTag, `Received page response`, { objectCount: objects.length, hasNextPage: hasMorePages });

        if (objects.length > 0) {
           // Separate deletes and upserts
           const toDelete: CatalogObjectFromApi[] = [];
           const toUpsert: CatalogObjectFromApi[] = [];

           // Explicitly type obj here if needed, though TS might infer it
           objects.forEach((obj: CatalogObjectFromApi) => {
             if (!obj || !obj.id) { 
                logger.warn(syncTag, 'Skipping invalid object received from API', { obj });
                return;
             }
             if (obj.is_deleted) {
               toDelete.push(obj);
             } else {
               toUpsert.push(obj);
             }
           });

           // Process deletions
           if (toDelete.length > 0) {
             logger.info(syncTag, `Processing ${toDelete.length} deletions...`);
             for (const obj of toDelete) {
               try {
                  await modernDb.deleteCatalogObjectById(obj.id);
               } catch (deleteError) {
                  logger.error(syncTag, `Failed to delete object ${obj.id}`, { deleteError });
                  // Log and continue
               }
             }
           }

           // Process upserts
           if (toUpsert.length > 0) {
             logger.info(syncTag, `Processing ${toUpsert.length} upserts...`);
             try {
                await modernDb.upsertCatalogObjects(toUpsert);
             } catch (upsertError) {
                logger.error(syncTag, `Failed to upsert batch of ${toUpsert.length} objects`, { upsertError });
                // Abort on batch failure to avoid inconsistent state
                throw new Error('Failed during object upsert batch.');
             }
           }

           processedObjectCount += objects.length;
           logger.debug(syncTag, `Processed ${processedObjectCount} objects so far in this sync run.`);
           await this.updateSyncStatus({ syncProgress: processedObjectCount });
        }

        // Update the cursor for the next iteration *after* successful processing of the current page
        lastFetchedCursor = receivedCursor ?? null; // Store the cursor received from this successful fetch
        currentCursor = receivedCursor; // Use this for the next request

      } while (hasMorePages);

      // 6. Sync completed successfully
      logger.info(syncTag, `Incremental sync completed successfully. Processed ${processedObjectCount} objects.`);
      // Store the cursor that would fetch the *next* page (which is null if finished)
      await modernDb.updateLastIncrementalSyncCursor(lastFetchedCursor);
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: null,
        lastSyncTime: new Date().toISOString(), // Mark successful sync time
        syncAttemptCount: 0, // Reset attempt count on success
        syncProgress: processedObjectCount, // Final count
      });

      // CRITICAL FIX: Send single bulk notification after sync completes
      if (processedObjectCount > 0) {
        try {
          const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
          dataChangeNotifier.notifyChange({
            table: 'catalog_items',
            operation: 'UPDATE',
            itemId: 'BULK_SYNC_COMPLETE',
            timestamp: Date.now(),
            data: { syncType: 'incremental', itemCount: processedObjectCount }
          });
          logger.info(syncTag, 'Sent bulk sync completion notification');
        } catch (error) {
          logger.warn(syncTag, 'Failed to send sync completion notification', { error });
        }
      }

    } catch (error: any) {
      // 7. Handle errors during the sync loop
      logger.error(syncTag, 'Incremental sync failed', { error: error.message, errorDetails: error });
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: `Sync failed: ${error.message || 'Unknown error'}`,
        // Do not update lastSyncTime or reset attempt count on failure
      });
    } finally {
      logger.info(syncTag, 'Incremental sync process finished.');
      // Ensure syncing is false even if unexpected error occurred
      const finalStatus = await this.getSyncStatus();
      if (finalStatus.isSyncing) {
         logger.warn(syncTag, 'Syncing flag was still true in finally block, setting to false.');
         await this.updateSyncStatus({ isSyncing: false });
      }
    }
  }
  // --- End: runIncrementalSync ---
  
  // --- New Method: runIncrementalSyncFromTimestamp ---
  /**
   * Run incremental sync using a specific timestamp from webhook
   * This follows Square's recommended approach for webhook-triggered sync
   */
  public async runIncrementalSyncFromTimestamp(webhookTimestamp: string): Promise<void> {
    const syncTag = 'CatalogSync:WebhookSync';
    logger.info(syncTag, 'Starting webhook-triggered sync...', { webhookTimestamp });

    // 1. Check authentication and network
    try {
      await this.checkAuthentication();
      const networkState = await Network.getNetworkStateAsync();
      if (!networkState.isConnected || !networkState.isInternetReachable) {
        logger.warn(syncTag, 'No internet connection. Webhook sync pending.');
        
        // Notify user that sync is pending due to no internet
        NotificationService.notifySyncPending(1); // 1 indicates webhook event waiting
        throw new Error('No internet connection - sync pending');
      }
    } catch (authError: any) {
       logger.error(syncTag, 'Authentication or network check failed', { error: authError.message });
      return; // Stop execution
    }

    // 2. Check if another sync is already running
    const currentStatus = await this.getSyncStatus();
    if (currentStatus.isSyncing) {
      logger.warn(syncTag, 'Another sync operation is already in progress. Skipping.');
      return;
    }

    // 3. Mark sync as started
    const syncStartTime = new Date().toISOString();
    await this.updateSyncStatus({
      isSyncing: true,
      syncType: 'webhook',
      syncError: null,
      syncProgress: 0,
      syncTotal: 0,
      lastSyncAttempt: syncStartTime,
      syncAttemptCount: (currentStatus.syncAttemptCount || 0) + 1,
    });
    logger.info(syncTag, 'Sync status updated to indicate start.');

    let processedObjectCount = 0;

    try {
      // 4. Get the last sync timestamp from our records
      const lastSyncTimestamp = await this.getLastSyncTimestamp();
      
      // Use the earlier of our last sync or the webhook timestamp for begin_time
      // This ensures we don't miss any changes between our last sync and the webhook
      const beginTime = lastSyncTimestamp && lastSyncTimestamp < webhookTimestamp 
        ? lastSyncTimestamp 
        : webhookTimestamp;
      
      logger.info(syncTag, 'Using timestamp range for sync', { 
        beginTime, 
        webhookTimestamp,
        lastSyncTimestamp 
      });

      // 5. Fetch changes using direct Square API with begin_time approach
      const response = await directSquareApi.searchCatalogObjects(beginTime);
      
      if (!response.success) {
        throw new Error(`Direct Square API error: ${response.error?.message || 'Unknown error'}`);
      }
      
      const objects = response.objects ?? [];

      logger.info(syncTag, `Received ${objects.length} objects from webhook sync`);

      if (objects.length > 0) {
        // Separate deletes and upserts
        const toDelete: CatalogObjectFromApi[] = [];
        const toUpsert: CatalogObjectFromApi[] = [];

        objects.forEach((obj: CatalogObjectFromApi) => {
          if (!obj || !obj.id) { 
             logger.warn(syncTag, 'Skipping invalid object received from API', { obj });
             return;
          }
          if (obj.is_deleted) {
            toDelete.push(obj);
          } else {
            toUpsert.push(obj);
          }
        });

        // Process deletions
        if (toDelete.length > 0) {
          logger.info(syncTag, `Processing ${toDelete.length} deletions...`);
          for (const obj of toDelete) {
            try {
               await modernDb.deleteCatalogObjectById(obj.id);
            } catch (deleteError) {
               logger.error(syncTag, `Failed to delete object ${obj.id}`, { deleteError });
            }
          }
        }

        // Process upserts
        if (toUpsert.length > 0) {
          logger.info(syncTag, `Processing ${toUpsert.length} upserts...`);
          try {
             await modernDb.upsertCatalogObjects(toUpsert);
          } catch (upsertError) {
             logger.error(syncTag, `Failed to upsert batch of ${toUpsert.length} objects`, { upsertError });
             throw new Error('Failed during object upsert batch.');
          }
        }

        processedObjectCount = objects.length;
      }

      // 6. Update our sync timestamp to the webhook timestamp
      await this.updateLastSyncTimestamp(webhookTimestamp);

      // 7. Sync completed successfully
      logger.info(syncTag, `Webhook sync completed successfully. Processed ${processedObjectCount} objects.`);
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: null,
        lastSyncTime: new Date().toISOString(),
        syncAttemptCount: 0,
        syncProgress: processedObjectCount,
      });

      // CRITICAL FIX: Send single bulk notification after sync completes
      if (processedObjectCount > 0) {
        try {
          const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
          dataChangeNotifier.notifyChange({
            table: 'catalog_items',
            operation: 'UPDATE',
            itemId: 'BULK_SYNC_COMPLETE',
            timestamp: Date.now(),
            data: { syncType: 'webhook', itemCount: processedObjectCount }
          });
          logger.info(syncTag, 'Sent bulk sync completion notification');
        } catch (error) {
          logger.warn(syncTag, 'Failed to send sync completion notification', { error });
        }
      }

      // 8. Send notification with specific feedback
      if (processedObjectCount > 0) {
        // Detailed notification about what was synced
        const message = `${processedObjectCount} item${processedObjectCount > 1 ? 's' : ''} synced from Square`;
        NotificationService.addNotification({
          type: 'sync_complete',
          title: 'Square Sync Complete',
          message,
          priority: 'normal',
          source: 'webhook'
        });
      } else {
        // No changes but sync was successful
        NotificationService.addNotification({
          type: 'webhook_catalog_update',
          title: 'Square Update Received',
          message: 'Catalog checked - no changes to sync',
          priority: 'low',
          source: 'webhook'
        });
      }

    } catch (error: any) {
      logger.error(syncTag, 'Webhook sync failed', { error: error.message, errorDetails: error });
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: `Webhook sync failed: ${error.message || 'Unknown error'}`,
      });
    } finally {
      logger.info(syncTag, 'Webhook sync process finished.');
      const finalStatus = await this.getSyncStatus();
      if (finalStatus.isSyncing) {
         logger.warn(syncTag, 'Syncing flag was still true in finally block, setting to false.');
         await this.updateSyncStatus({ isSyncing: false });
      }
    }
  }
  
  /**
   * Get the last sync timestamp from our records
   */
  private async getLastSyncTimestamp(): Promise<string | null> {
    try {
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      const result = await this.db.getFirstAsync<{ value: string }>(`
        SELECT value FROM app_metadata WHERE key = 'last_webhook_sync_timestamp'
      `);
      
      return result?.value || null;
    } catch (error) {
      logger.error('CatalogSync', 'Failed to get last sync timestamp', { error });
      return null;
    }
  }
  
  /**
   * Update the last sync timestamp in our records
   */
  private async updateLastSyncTimestamp(timestamp: string): Promise<void> {
    try {
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      await this.db.runAsync(`
        INSERT OR REPLACE INTO app_metadata (key, value) 
        VALUES ('last_webhook_sync_timestamp', ?)
      `, [timestamp]);
      
      logger.debug('CatalogSync', 'Updated last sync timestamp', { timestamp });
    } catch (error) {
      logger.error('CatalogSync', 'Failed to update last sync timestamp', { error });
    }
  }
  // --- End: runIncrementalSyncFromTimestamp ---
  
  // --- New Method: checkAndRunCatchUpSync ---
  /**
   * Check if we need to run a catch-up sync on app startup
   * This handles cases where the app was closed/offline and missed webhook events
   */
  public async checkAndRunCatchUpSync(): Promise<void> {
    const syncTag = 'CatalogSync:CatchUp';
    logger.info(syncTag, 'Checking if catch-up sync is needed...');
    
    // Add notification to show intelligent catch-up sync check is starting
    NotificationService.addNotification({
      type: 'sync_pending',
      title: 'Intelligent Sync Check',
      message: 'Checking if any webhook events were missed (webhook-first architecture)...',
      priority: 'low',
      source: 'internal'
    });

    try {
      // 1. Get the last time we successfully synced
      const lastWebhookSync = await this.getLastSyncTimestamp();
      const status = await this.getSyncStatus();
      const lastRegularSync = status.lastSyncTime;

      // 2. Get the last time the app was opened
      const lastAppOpen = await this.getLastAppOpenTime();
      const currentTime = new Date().toISOString();
      
      // Update the current app open time
      await this.updateLastAppOpenTime(currentTime);

      logger.debug(syncTag, 'Catch-up sync timestamps', {
        lastWebhookSync,
        lastRegularSync,
        lastAppOpen,
        currentTime
      });

      // 3. Determine if we need to catch up
      let needsCatchUp = false;
      let catchUpReason = '';

      // If we've never synced before, we definitely need a full sync (not catch-up)
      if (!lastRegularSync && !lastWebhookSync) {
        logger.info(syncTag, 'No previous sync found - full sync needed, not catch-up');
        return;
      }

      // Only run catch-up if we have a valid reason to believe we missed webhook events
      // This prevents unnecessary API calls when webhooks are working properly
      
      // Check if we have any pending webhook events that failed to process
      const hasPendingWebhookEvents = await this.checkForPendingWebhookEvents();
      
      if (hasPendingWebhookEvents) {
        needsCatchUp = true;
        catchUpReason = 'Pending webhook events detected - processing missed updates';
      } else if (!lastAppOpen) {
        // First time opening app after install - we definitely need initial sync
        needsCatchUp = true;
        catchUpReason = 'First app launch - initial sync required';
      } else if (lastWebhookSync && lastAppOpen) {
        // Check if app was closed during a time when webhooks might have been sent
        // Only check if we were closed for a significant period (>30 minutes)
        // AND we haven't received any webhook updates recently
        const timeSinceLastOpen = new Date(currentTime).getTime() - new Date(lastAppOpen).getTime();
        const timeSinceLastWebhook = new Date(currentTime).getTime() - new Date(lastWebhookSync).getTime();
        const thirtyMinutes = 30 * 60 * 1000;
        const sixHours = 6 * 60 * 60 * 1000;
        
        if (timeSinceLastOpen > thirtyMinutes && timeSinceLastWebhook > sixHours) {
          needsCatchUp = true;
          catchUpReason = `App was closed for ${Math.round(timeSinceLastOpen / (60 * 1000))} minutes and no webhooks received for ${Math.round(timeSinceLastWebhook / (60 * 60 * 1000))} hours`;
        }
      }

      // 4. If no catch-up needed, exit early
      if (!needsCatchUp) {
        logger.info(syncTag, 'No catch-up sync needed - app was recently active');
        
        // Add notification that no catch-up was needed
        NotificationService.addNotification({
          type: 'sync_complete',
          title: 'Webhooks Working Properly',
          message: 'No missed webhook events detected - catalog is up to date',
          priority: 'low',
          source: 'internal'
        });
        return;
      }

      logger.info(syncTag, `Catch-up sync needed: ${catchUpReason}`);
      
      // Add notification explaining why catch-up sync is needed
      NotificationService.addNotification({
        type: 'sync_pending',
        title: 'Running Catch-up Sync',
        message: `${catchUpReason} - syncing missed changes...`,
        priority: 'normal',
        source: 'internal'
      });

      // 5. Determine the best timestamp to use for catch-up
      let catchUpTimestamp: string | null = null;

      // Use the most recent of our sync timestamps as the starting point
      if (lastWebhookSync && lastRegularSync) {
        catchUpTimestamp = lastWebhookSync > lastRegularSync ? lastWebhookSync : lastRegularSync;
      } else if (lastWebhookSync) {
        catchUpTimestamp = lastWebhookSync;
      } else if (lastRegularSync) {
        catchUpTimestamp = lastRegularSync;
      }

      // 6. Run the catch-up sync
      if (catchUpTimestamp) {
        logger.info(syncTag, 'Running catch-up sync from timestamp', { catchUpTimestamp });
        await this.runCatchUpSyncFromTimestamp(catchUpTimestamp);
      } else {
        logger.warn(syncTag, 'No valid timestamp found for catch-up - running regular incremental sync');
        await this.runIncrementalSync();
      }

    } catch (error) {
      logger.error(syncTag, 'Catch-up sync check failed', { error });
      // Don't throw - this is a background operation
    }
  }

  /**
   * Run a catch-up sync from a specific timestamp
   * Similar to webhook sync but optimized for app startup
   */
  private async runCatchUpSyncFromTimestamp(timestamp: string): Promise<void> {
    const syncTag = 'CatalogSync:CatchUpSync';
    logger.info(syncTag, 'Starting catch-up sync...', { timestamp });

    // 1. Check authentication and network FIRST (before marking sync as started)
    try {
      await this.checkAuthentication();
      const networkState = await Network.getNetworkStateAsync();
      if (!networkState.isConnected || !networkState.isInternetReachable) {
        logger.warn(syncTag, 'No internet connection. Deferring catch-up sync.');
        
        // Add notification about deferred sync
        NotificationService.addNotification({
          type: 'sync_error',
          title: 'Catch-up Sync Deferred',
          message: 'No internet connection - catch-up sync will retry when connection is restored',
          priority: 'normal',
          source: 'internal'
        });
        return;
      }
    } catch (authError: any) {
       logger.error(syncTag, 'Authentication or network check failed', { error: authError.message });
       
       // Add notification about authentication failure
       NotificationService.addNotification({
         type: 'sync_error',
         title: 'Catch-up Sync Failed',
         message: `Authentication failed: ${authError.message}`,
         priority: 'high',
         source: 'internal'
       });
       return; // Stop execution
    }

    // 2. Check if another sync is already running
    const currentStatus = await this.getSyncStatus();
    if (currentStatus.isSyncing) {
      logger.warn(syncTag, 'Another sync operation is already in progress. Skipping catch-up.');
      
      // Add notification that sync was skipped due to another sync running
      NotificationService.addNotification({
        type: 'sync_pending',
        title: 'Sync Already Running',
        message: `${currentStatus.syncType || 'Another'} sync is already in progress - skipping catch-up`,
        priority: 'low',
        source: 'internal'
      });
      return;
    }

    // 3. Mark sync as started (only after authentication check passes)
    await this.updateSyncStatus({
      isSyncing: true,
      syncType: 'catchup',
      syncError: null,
      syncProgress: 0,
      syncTotal: 0,
      lastSyncAttempt: new Date().toISOString(),
      syncAttemptCount: (currentStatus.syncAttemptCount || 0) + 1,
    });

    let processedObjectCount = 0;

    try {

      // Fetch changes using direct Square API with begin_time approach
      logger.info(syncTag, 'Fetching changes since last sync via direct Square API', { beginTime: timestamp });
      const response = await directSquareApi.searchCatalogObjects(timestamp);
      
      if (!response.success) {
        throw new Error(`Direct Square API error: ${response.error?.message || 'Unknown error'}`);
      }
      
      const objects = response.objects ?? [];

      logger.info(syncTag, `Found ${objects.length} objects to catch up on`);

      if (objects.length > 0) {
        // Process the changes (same logic as webhook sync)
        const toDelete: CatalogObjectFromApi[] = [];
        const toUpsert: CatalogObjectFromApi[] = [];

        objects.forEach((obj: CatalogObjectFromApi) => {
          if (!obj || !obj.id) { 
             logger.warn(syncTag, 'Skipping invalid object', { obj });
             return;
          }
          if (obj.is_deleted) {
            toDelete.push(obj);
          } else {
            toUpsert.push(obj);
          }
        });

        // Process deletions
        if (toDelete.length > 0) {
          logger.info(syncTag, `Processing ${toDelete.length} deletions...`);
          for (const obj of toDelete) {
            try {
               await modernDb.deleteCatalogObjectById(obj.id);
            } catch (deleteError) {
               logger.error(syncTag, `Failed to delete object ${obj.id}`, { deleteError });
            }
          }
        }

        // Process upserts
        if (toUpsert.length > 0) {
          logger.info(syncTag, `Processing ${toUpsert.length} upserts...`);
          try {
             await modernDb.upsertCatalogObjects(toUpsert);
          } catch (upsertError) {
             logger.error(syncTag, `Failed to upsert batch`, { upsertError });
             throw new Error('Failed during catch-up upsert batch.');
          }
        }

        processedObjectCount = objects.length;
      }

      // Update our sync timestamp to current time
      await this.updateLastSyncTimestamp(new Date().toISOString());

      // Mark sync as completed
      logger.info(syncTag, `Catch-up sync completed successfully. Processed ${processedObjectCount} objects.`);
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: null,
        lastSyncTime: new Date().toISOString(),
        syncAttemptCount: 0,
        syncProgress: processedObjectCount,
      });

      // CRITICAL FIX: Send single bulk notification after sync completes
      if (processedObjectCount > 0) {
        try {
          const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
          dataChangeNotifier.notifyChange({
            table: 'catalog_items',
            operation: 'UPDATE',
            itemId: 'BULK_SYNC_COMPLETE',
            timestamp: Date.now(),
            data: { syncType: 'catchup', itemCount: processedObjectCount }
          });
          logger.info(syncTag, 'Sent bulk sync completion notification');
        } catch (error) {
          logger.warn(syncTag, 'Failed to send sync completion notification', { error });
        }
      }

      // Add notifications for catch-up sync results
      if (processedObjectCount > 0) {
        // Detailed notification about what was synced during catch-up
        const message = `${processedObjectCount} item${processedObjectCount > 1 ? 's' : ''} synced during catch-up`;
        NotificationService.addNotification({
          type: 'sync_complete',
          title: 'Catch-up Sync Complete',
          message,
          priority: 'normal',
          source: 'internal'
        });
      } else {
        // No changes found during catch-up
        NotificationService.addNotification({
          type: 'sync_complete',
          title: 'Catch-up Check Complete',
          message: 'No new changes found since last sync',
          priority: 'low',
          source: 'internal'
        });
      }

    } catch (error: any) {
      logger.error(syncTag, 'Catch-up sync failed', { error: error.message });
      
      // Check if this is a 403 authorization error
      const is403Error = error.message?.includes('403') || error.status === 403 || error.response?.status === 403;
      const errorMessage = `Catch-up sync failed: ${error.message || 'Unknown error'}`;
      
      await this.updateSyncStatus({
        isSyncing: false,
        syncError: errorMessage,
      });
      
      // Add specific notification based on error type
      if (is403Error) {
        NotificationService.addNotification({
          type: 'sync_error',
          title: 'Authorization Error (403)',
          message: 'Square API access denied. Your authentication token may have expired. Try reconnecting to Square.',
          priority: 'high',
          source: 'internal'
        });
      } else {
        NotificationService.addNotification({
          type: 'sync_error',
          title: 'Catch-up Sync Failed',
          message: errorMessage,
          priority: 'high',
          source: 'internal'
        });
      }
    } finally {
      logger.info(syncTag, 'Catch-up sync process finished.');
      const finalStatus = await this.getSyncStatus();
      if (finalStatus.isSyncing) {
         logger.warn(syncTag, 'Syncing flag was still true in finally block, setting to false.');
         await this.updateSyncStatus({ isSyncing: false });
      }
    }
  }

  /**
   * Check if there are any pending webhook events that failed to process
   * This helps determine if we need catch-up sync due to missed webhooks
   */
  private async checkForPendingWebhookEvents(): Promise<boolean> {
    try {
      // This could check AppSync for unprocessed webhook events
      // For now, we'll return false since we don't have a reliable way to detect this
      // In the future, this could query the backend for webhook delivery failures
      return false;
    } catch (error) {
      logger.error('CatalogSync', 'Failed to check for pending webhook events', { error });
      return false;
    }
  }

  /**
   * Get the last time the app was opened
   */
  private async getLastAppOpenTime(): Promise<string | null> {
    try {
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      const result = await this.db.getFirstAsync<{ value: string }>(`
        SELECT value FROM app_metadata WHERE key = 'last_app_open_time'
      `);
      
      return result?.value || null;
    } catch (error) {
      logger.error('CatalogSync', 'Failed to get last app open time', { error });
      return null;
    }
  }
  
  /**
   * Update the last app open time
   */
  private async updateLastAppOpenTime(timestamp: string): Promise<void> {
    try {
      if (!this.db) {
        this.db = await modernDb.getDatabase();
      }
      
      await this.db.runAsync(`
        INSERT OR REPLACE INTO app_metadata (key, value) 
        VALUES ('last_app_open_time', ?)
      `, [timestamp]);
      
      logger.debug('CatalogSync', 'Updated last app open time', { timestamp });
    } catch (error) {
      logger.error('CatalogSync', 'Failed to update last app open time', { error });
    }
  }
  
  /**
   * Register a listener for sync status changes
   */
  public registerListener(id: string, listener: (status: SyncStatus) => void): void {
    this.listeners.set(id, listener);
  }
  
  /**
   * Unregister a listener
   */
  public unregisterListener(id: string): void {
    this.listeners.delete(id);
  }
  
  /**
   * Notify all listeners of status changes
   */
  private async notifyListeners(): Promise<void> {
    try {
      const status = await this.getSyncStatus();
      this.listeners.forEach(listener => {
        try {
          listener(status);
        } catch (error) {
          logger.error('CatalogSync', 'Error in sync status listener', { error });
        }
      });
    } catch (error) {
      logger.error('CatalogSync', 'Failed to notify listeners', { error });
    }
  }
  // --- End: checkAndRunCatchUpSync ---

  /**
   * CRITICAL FIX: Link images to items using PRODUCT ID, not name matching
   * Square stores object_id in the full IMAGE object data_json
   */
  private async linkImagesToItems(): Promise<void> {
    try {
      const db = await modernDb.getDatabase();

      // Get all images with their full data_json to check for object_id
      const images = await db.getAllAsync<{
        id: string;
        name: string;
        url: string;
        data_json: string;
      }>(`
        SELECT id, name, url, data_json
        FROM images
        WHERE is_deleted = 0
      `);

      logger.info('CatalogSync::linkImagesToItems', `Found ${images.length} images to process`);

      let linkedCount = 0;

      for (const image of images) {
        try {
          // Parse the full image data to find object_id (item ID reference)
          const imageData = JSON.parse(image.data_json || '{}');

          // Check for object_id in the image data (this is the item ID)
          let itemId = null;

          // Method 1: Check for object_id in root level
          if (imageData.object_id) {
            itemId = imageData.object_id;
          }

          // Method 2: Check for object_id in image_data
          if (!itemId && imageData.image_data?.object_id) {
            itemId = imageData.image_data.object_id;
          }

          // Method 3: Check for any field that looks like an item ID
          if (!itemId) {
            // Look for any field that matches item ID pattern
            const dataStr = JSON.stringify(imageData);
            const itemIdMatch = dataStr.match(/"([A-Z0-9]{20,})"/g);
            if (itemIdMatch) {
              // Find one that exists as an item in our database
              for (const match of itemIdMatch) {
                const potentialItemId = match.replace(/"/g, '');
                const itemExists = await db.getFirstAsync(
                  'SELECT id FROM catalog_items WHERE id = ? AND is_deleted = 0',
                  [potentialItemId]
                );
                if (itemExists) {
                  itemId = potentialItemId;
                  break;
                }
              }
            }
          }

          if (itemId) {
            // Get the item and add this image to its image_ids
            const item = await db.getFirstAsync<{
              id: string;
              name: string;
              data_json: string;
            }>(`
              SELECT id, name, data_json
              FROM catalog_items
              WHERE id = ? AND is_deleted = 0
            `, [itemId]);

            if (item) {
              // Parse item data and add image ID
              const itemData = JSON.parse(item.data_json || '{}');
              if (!itemData.item_data) itemData.item_data = {};
              if (!itemData.item_data.image_ids) itemData.item_data.image_ids = [];

              // Add image ID if not already present
              if (!itemData.item_data.image_ids.includes(image.id)) {
                itemData.item_data.image_ids.push(image.id);

                // Update item in database
                await db.runAsync(
                  'UPDATE catalog_items SET data_json = ? WHERE id = ?',
                  [JSON.stringify(itemData), item.id]
                );

                linkedCount++;
                logger.info('CatalogSync::linkImagesToItems', `Linked image to item by ID`, {
                  imageId: image.id,
                  itemId: item.id,
                  itemName: item.name,
                  method: itemData.object_id ? 'object_id' : 'pattern_match'
                });
              }
            } else {
              logger.warn('CatalogSync::linkImagesToItems', `Item not found for image`, {
                imageId: image.id,
                itemId: itemId
              });
            }
          } else {
            logger.debug('CatalogSync::linkImagesToItems', `No item ID found for image`, {
              imageId: image.id,
              imageName: image.name
            });
          }

        } catch (parseError) {
          logger.warn('CatalogSync::linkImagesToItems', `Failed to parse image data`, {
            imageId: image.id,
            error: parseError
          });
        }
      }

      logger.info('CatalogSync::linkImagesToItems', `Successfully linked ${linkedCount} images to items`);

    } catch (error) {
      logger.error('CatalogSync::linkImagesToItems', 'Failed to link images to items', error);
      throw error;
    }
  }
}

// Export the singleton instance
const catalogSyncService = CatalogSyncService.getInstance();
export default catalogSyncService;