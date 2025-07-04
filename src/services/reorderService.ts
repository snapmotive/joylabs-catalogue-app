import { ConvertedItem } from '../types/api';
import logger from '../utils/logger';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateClient } from 'aws-amplify/api';
import * as queries from '../graphql/queries';
import * as subscriptions from '../graphql/subscriptions';
import * as mutations from '../graphql/mutations';
import { itemHistoryService } from './itemHistoryService';
import * as modernDb from '../database/modernDb';
import appSyncMonitor from './appSyncMonitor';
import crossReferenceService from './crossReferenceService';
import dataConsistencyService, { ConsistencyReport } from './dataConsistencyService';
import { dataChangeNotifier, DataChangeEvent } from './dataChangeNotifier';

export interface TeamData {
  vendor?: string;
  vendorCost?: number;
  caseUpc?: string;
  caseCost?: number;
  caseQuantity?: number;
  discontinued?: boolean;
  notes?: string;
}

// Minimal reorder data (stored in AppSync/local DB)
export interface ReorderItem {
  id: string;
  itemId: string;           // Reference to Square catalog
  quantity: number;         // Reorder quantity
  status: 'incomplete' | 'complete';  // Reorder status (received is in team data history)
  addedBy: string;          // Who added this item
  createdAt: string;        // Timestamps for sync
  updatedAt: string;
  // Local computed fields
  timestamp?: Date;         // For chronological ordering
  index?: number;           // For UI display
}

// Display item with cross-referenced data (for UI)
export interface DisplayReorderItem extends ReorderItem {
  // Cross-referenced from Square catalog
  itemName: string;
  itemBarcode?: string;
  itemCategory?: string;
  itemPrice?: number;
  // Cross-referenced from team data
  teamData?: TeamData;
  // Square catalog item (if available)
  item?: ConvertedItem;
  // Status indicators
  missingSquareData?: boolean;
  missingTeamData?: boolean;
  // Custom item flag
  isCustom?: boolean;
}

class ReorderService {
  private reorderItems: ReorderItem[] = [];
  private listeners: Array<(items: DisplayReorderItem[]) => void> = [];
  private client = generateClient();
  private teamDataCache = new Map<string, { data: TeamData; timestamp: number }>();
  private subscriptions: any[] = [];
  private isInitialized = false;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
  private currentUserId: string | null = null;
  private isOfflineMode = false;
  private pendingSyncItems: ReorderItem[] = []; // Items waiting to sync
  private readonly STORAGE_KEY = 'reorder_items_offline';

  // Event-driven sync queue for batched operations
  private syncQueue: Array<{ operation: string; data: any; timestamp: number; retryCount?: number }> = [];
  private syncBatchTimeout: NodeJS.Timeout | null = null;
  private isProcessingQueue = false;
  private lastServerSync = 0;
  private readonly BATCH_DELAY = 3000; // 3 seconds to collect operations
  private readonly MAX_BATCH_SIZE = 10; // Max operations per batch

  // Initialize the service
  async initialize(userId?: string) {
    if (this.isInitialized && this.currentUserId === userId) return;
    
    this.currentUserId = userId || null;
    
    try {
      // Check authentication status first
      const isAuthenticated = await this.checkAuthStatus();

      if (isAuthenticated) {
        // Load from local storage first (local-first approach)
        await this.loadOfflineItems();

        // Set up smart real-time subscriptions (resource-efficient)
        this.setupSmartSubscriptions();

        // Set up event-driven sync (no polling)
        this.setupEventDrivenSync();

        // Set up automatic item detail updates (real-time data change notifications)
        this.setupRealTimeDataChangeMonitoring();
      } else {
        // Load from offline storage
        this.isOfflineMode = true;
        await this.loadOfflineItems();
      }
      
      this.isInitialized = true;
      logger.info('[ReorderService]', 'Service initialized successfully', { 
        userId: this.currentUserId,
        isOfflineMode: this.isOfflineMode 
      });
      
      // Notify all listeners with loaded data
      this.notifyListeners();
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to initialize service', { error });
      // Fallback to offline mode
      this.isOfflineMode = true;
      await this.loadOfflineItems();
      this.notifyListeners();
    }
  }

  // Load reorder items from local database first (LOCAL-FIRST ARCHITECTURE)
  private async loadReorderItems() {
    try {
      logger.info('[ReorderService]', '🔍 Loading reorder items locally (LOCAL-FIRST)');

      // ✅ CRITICAL FIX: Load from local SQLite first
      const localReorderItems = await this.loadLocalReorderItems();

      if (localReorderItems && localReorderItems.length > 0) {
        this.reorderItems = localReorderItems;
        logger.info('[ReorderService]', `✅ Loaded ${this.reorderItems.length} reorder items from local database`);

        // ✅ CROSS-REFERENCING: Item details and team data loaded on-demand via crossReferenceService
        // ✅ NO TIME-BASED POLLING: Data syncs only via webhooks/AppSync or CRUD operations
      } else {
        logger.info('[ReorderService]', '📭 No local reorder items found - attempting initial recovery from DynamoDB');
        // ✅ INITIAL RECOVERY: When local data is missing, recover from DynamoDB once
        await this.recoverFromDynamoDB();
      }
    } catch (error) {
      logger.error('[ReorderService]', '❌ Failed to load reorder items', { error });
    }
  }

  // Manual sync function for explicit user-triggered syncs only
  async manualSync() {
    try {
      logger.info('[ReorderService]', '🔄 Manual sync triggered by user');

      // Check AppSync connectivity before attempting sync
      const canConnectToAppSync = await this.testAppSyncConnectivity();
      if (!canConnectToAppSync) {
        logger.warn('[ReorderService]', 'Cannot connect to AppSync - manual sync skipped');
        throw new Error('Cannot connect to server. Please check your internet connection and try again.');
      }

      // 🚨 EMERGENCY FIX: Warn user about potential data loss
      if (this.pendingSyncItems.length > 0) {
        logger.warn('[ReorderService]', `⚠️ WARNING: ${this.pendingSyncItems.length} pending items will be synced to server first`);

        // Sync pending items first to prevent data loss
        await this.syncPendingItems();
      }

      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('listReorderItems', 'ReorderService:manualSync', { limit: 1000 });

      const response = await this.client.graphql({
        query: queries.listReorderItems,
        variables: {
          limit: 1000 // Adjust as needed
        }
      }) as any;

      if (response.data?.listReorderItems?.items) {
        // Map server items to minimal ReorderItem format
        const serverItems = response.data.listReorderItems.items.map((item: any, index: number) => ({
          id: item.id,
          itemId: item.itemId,              // Reference to Square catalog
          quantity: item.quantity,          // Reorder quantity
          status: item.status || 'incomplete', // 'incomplete' | 'complete'
          addedBy: item.addedBy,           // Who added it
          createdAt: item.createdAt,       // Timestamps
          updatedAt: item.updatedAt,
          timestamp: new Date(item.createdAt), // For chronological ordering
          index: index + 1
        }));

        // 🚨 CONFLICT RESOLUTION: Merge server items with local items instead of overwriting
        const mergedItems = this.mergeServerAndLocalItems(serverItems, this.reorderItems);

        // Save to local database
        await this.saveReorderItemsLocally(mergedItems);

        // Update in-memory items
        this.reorderItems = mergedItems;

        logger.info('[ReorderService]', `✅ Manual sync completed: ${mergedItems.length} reorder items (merged, minimal data)`);

        // ✅ CROSS-REFERENCING: Item details and team data loaded on-demand via crossReferenceService
        // Notify listeners of updated data (with cross-referenced display data)
        await this.notifyListeners();
      }
    } catch (error) {
      logger.error('[ReorderService]', '❌ Manual sync failed', { error });
      throw error;
    }
  }

  // 🚨 EMERGENCY FIX: Add conflict resolution to prevent data loss
  private mergeServerAndLocalItems(serverItems: ReorderItem[], localItems: ReorderItem[]): ReorderItem[] {
    const merged = [...serverItems];

    // Add local items that don't exist on server
    localItems.forEach(localItem => {
      const existsOnServer = serverItems.find(serverItem =>
        serverItem.id === localItem.id ||
        (serverItem.itemId === localItem.itemId && serverItem.createdAt === localItem.createdAt)
      );

      if (!existsOnServer) {
        logger.info('[ReorderService]', `🔄 Preserving local item not found on server: ${localItem.itemId}`);
        merged.push(localItem);
      }
    });

    return merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  // loadTeamDataForItems method removed - now using cross-referencing via crossReferenceService

  // Set up event-driven sync (no polling)
  private setupEventDrivenSync() {
    // Listen for app state changes to trigger sync
    if (typeof window !== 'undefined') {
      // Sync when app comes back into focus
      window.addEventListener('focus', () => this.triggerBatchSync('APP_FOCUS'));

      // Sync before app goes into background
      window.addEventListener('blur', () => this.triggerBatchSync('APP_BLUR'));
    }

    logger.info('[ReorderService]', 'Event-driven sync setup complete');
  }

  // Set up automatic item detail updates via real-time data change notifications
  private setupRealTimeDataChangeMonitoring() {
    try {
      // Listen for real-time data changes and automatically refresh affected reorder items
      const unsubscribe = dataChangeNotifier.addListener(async (event: DataChangeEvent) => {
        // Only handle catalog item and team data changes
        if (event.table === 'catalog_items' || event.table === 'team_data') {

          // CRITICAL FIX: Handle bulk sync completion notification
          if (event.itemId === 'BULK_SYNC_COMPLETE') {
            logger.info('[ReorderService]', 'Bulk sync completed, refreshing reorder items with updated catalog data', {
              syncType: event.data?.syncType,
              itemCount: event.data?.itemCount
            });

            // Add a small delay to ensure all database operations are complete
            setTimeout(async () => {
              await this.notifyListeners();
            }, 500);
            return;
          }

          // For individual item updates, check if any of our reorder items are affected
          const affectedReorderItems = this.reorderItems.filter(item =>
            item.itemId === event.itemId
          );

          if (affectedReorderItems.length > 0) {
            logger.info('[ReorderService]', `Reorder item affected by ${event.table} ${event.operation}`, {
              itemId: event.itemId,
              operation: event.operation,
              affectedCount: affectedReorderItems.length
            });

            // Notify listeners to refresh cross-referenced data
            // This will automatically show updated item details (price, name, discontinued status, etc.)
            await this.notifyListeners();

            logger.debug('[ReorderService]', 'Reorder items automatically updated with latest item details');
          }
        }
      });

      // Store unsubscribe function for cleanup
      this.subscriptions.push({ unsubscribe });

      logger.info('[ReorderService]', 'Real-time data change monitoring setup complete - automatic item detail updates enabled');
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to setup real-time data change monitoring', { error });
    }
  }



  // Trigger batched sync after user interactions
  private triggerBatchSync(reason: string) {
    if (this.syncQueue.length === 0) return;

    // Clear existing timeout
    if (this.syncBatchTimeout) {
      clearTimeout(this.syncBatchTimeout);
    }

    // Set new timeout for batching
    this.syncBatchTimeout = setTimeout(async () => {
      if (this.isProcessingQueue) return;

      logger.info('[ReorderService]', `Triggering batch sync: ${reason}`, {
        queueLength: this.syncQueue.length
      });

      await this.processSyncBatch();
    }, this.BATCH_DELAY);
  }

  // Process batched sync operations
  private async processSyncBatch() {
    if (this.syncQueue.length === 0 || this.isProcessingQueue) return;

    this.isProcessingQueue = true;

    try {
      // Take a batch of operations
      const batch = this.syncQueue.splice(0, this.MAX_BATCH_SIZE);

      logger.info('[ReorderService]', `Processing sync batch: ${batch.length} operations`);

      // Group operations by type for efficient batching
      const groupedOps = this.groupOperationsByType(batch);

      // Process each group
      for (const [opType, operations] of Object.entries(groupedOps)) {
        try {
          await this.processBatchedOperations(opType, operations);
        } catch (error) {
          logger.error('[ReorderService]', `Failed to process batch: ${opType}`, { error });

          // Re-queue failed operations with exponential backoff
          operations.forEach(op => {
            const retryDelay = Math.min(5000 * Math.pow(2, op.retryCount || 0), 60000); // Max 1 minute
            if ((op.retryCount || 0) < 3) { // Max 3 retries
              setTimeout(() => {
                this.syncQueue.push({
                  ...op,
                  retryCount: (op.retryCount || 0) + 1,
                  timestamp: Date.now()
                });
              }, retryDelay);
            }
          });
        }
      }

      // If there are more operations, schedule another batch
      if (this.syncQueue.length > 0) {
        this.triggerBatchSync('REMAINING_OPERATIONS');
      }

    } finally {
      this.isProcessingQueue = false;
    }
  }

  // Group operations by type for efficient batching
  private groupOperationsByType(operations: any[]): Record<string, any[]> {
    return operations.reduce((groups, op) => {
      if (!groups[op.operation]) {
        groups[op.operation] = [];
      }
      groups[op.operation].push(op);
      return groups;
    }, {} as Record<string, any[]>);
  }

  // Process batched operations efficiently
  private async processBatchedOperations(operationType: string, operations: any[]) {
    switch (operationType) {
      case 'CREATE_ITEM':
        // Batch create operations
        await this.batchCreateItems(operations.map(op => op.data));
        break;
      case 'UPDATE_ITEM':
        // Batch update operations
        await this.batchUpdateItems(operations.map(op => op.data));
        break;
      case 'DELETE_ITEM':
        // Batch delete operations
        await this.batchDeleteItems(operations.map(op => op.data));
        break;
      // TOGGLE_COMPLETION removed - now uses UPDATE_ITEM
      default:
        logger.warn('[ReorderService]', 'Unknown batch operation', { operationType });
    }
  }

  // Batch create multiple items
  private async batchCreateItems(items: any[]) {
    logger.info('[ReorderService]', `Batch creating ${items.length} items`);

    // Process in parallel but limit concurrency
    const promises = items.map(item => this.syncCreateItem(item));
    await Promise.allSettled(promises);
  }

  // Batch update multiple items
  private async batchUpdateItems(items: any[]) {
    logger.info('[ReorderService]', `Batch updating ${items.length} items`);

    const promises = items.map(item => this.syncUpdateItem(item));
    await Promise.allSettled(promises);
  }

  // Batch delete multiple items
  private async batchDeleteItems(items: any[]) {
    logger.info('[ReorderService]', `Batch deleting ${items.length} items`);

    const promises = items.map(item => this.syncDeleteItem(item));
    await Promise.allSettled(promises);
  }

  // batchToggleCompletion removed - now uses batchUpdateItems

  // Set up smart real-time subscriptions (resource-efficient)
  private setupSmartSubscriptions() {
    try {
      // Only subscribe to changes from OTHER users (not our own changes)
      this.subscribeToOtherUsersChanges();
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to setup smart subscriptions', { error });
    }
  }

  // Subscribe only to changes from other users
  private subscribeToOtherUsersChanges() {
    try {
      if (!this.currentUserId) {
        logger.warn('[ReorderService]', 'Cannot setup subscriptions without currentUserId');
        return;
      }

      // Subscribe to reorder item creates from other users
      const createSubscription = this.client.graphql({
        query: subscriptions.onCreateReorderItem,
        variables: {
          filter: {
            addedBy: {
              ne: this.currentUserId // Only changes from other users
            }
          }
        }
      }).subscribe({
        next: (result: any) => {
          const createdItem = result.data?.onCreateReorderItem;
          if (createdItem && createdItem.addedBy !== this.currentUserId) {
            logger.info('[ReorderService]', 'Received external create', { itemId: createdItem.itemId, addedBy: createdItem.addedBy });
            this.handleExternalCreate(createdItem);
          }
        },
        error: (error: any) => {
          logger.error('[ReorderService]', 'Create subscription error', { error });
        }
      });

      // Subscribe to reorder item updates from other users
      const updateSubscription = this.client.graphql({
        query: subscriptions.onUpdateReorderItem,
        variables: {
          filter: {
            addedBy: {
              ne: this.currentUserId // Only changes from other users
            }
          }
        }
      }).subscribe({
        next: (result: any) => {
          const updatedItem = result.data?.onUpdateReorderItem;
          if (updatedItem && updatedItem.addedBy !== this.currentUserId) {
            logger.info('[ReorderService]', 'Received external update', { itemId: updatedItem.itemId, addedBy: updatedItem.addedBy });
            this.handleExternalUpdate(updatedItem);
          }
        },
        error: (error: any) => {
          logger.error('[ReorderService]', 'Update subscription error', { error });
        }
      });

      // Subscribe to reorder item deletes from other users
      const deleteSubscription = this.client.graphql({
        query: subscriptions.onDeleteReorderItem,
        variables: {
          filter: {
            addedBy: {
              ne: this.currentUserId // Only changes from other users
            }
          }
        }
      }).subscribe({
        next: (result: any) => {
          const deletedItem = result.data?.onDeleteReorderItem;
          if (deletedItem && deletedItem.addedBy !== this.currentUserId) {
            logger.info('[ReorderService]', 'Received external delete', { itemId: deletedItem.itemId, addedBy: deletedItem.addedBy });
            this.handleExternalDelete(deletedItem);
          }
        },
        error: (error: any) => {
          logger.error('[ReorderService]', 'Delete subscription error', { error });
        }
      });

      this.subscriptions.push(createSubscription, updateSubscription, deleteSubscription);
      logger.info('[ReorderService]', 'Smart subscriptions setup complete', {
        currentUserId: this.currentUserId,
        subscriptionCount: this.subscriptions.length
      });
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to setup subscriptions', { error });
    }
  }

  // Handle creates from other users
  private async handleExternalCreate(createdItem: any) {
    try {
      // Check if we already have this item locally
      const existingItem = this.reorderItems.find(item => item.id === createdItem.id);

      if (!existingItem) {
        // Add the new item to our local list
        const newReorderItem: ReorderItem = {
          id: createdItem.id,
          itemId: createdItem.itemId,
          quantity: createdItem.quantity,
          status: createdItem.status,
          addedBy: createdItem.addedBy,
          createdAt: createdItem.createdAt,
          updatedAt: createdItem.updatedAt,
          timestamp: new Date(createdItem.createdAt)
        };

        this.reorderItems.push(newReorderItem);

        // Sort chronologically (most recent first)
        this.reorderItems.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        // Re-index items
        this.reorderItems.forEach((item, index) => {
          item.index = index + 1;
        });

        await this.saveOfflineItems();
        this.notifyListeners();

        logger.info('[ReorderService]', 'Added external item to local list', {
          itemId: createdItem.itemId,
          addedBy: createdItem.addedBy
        });
      }
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to handle external create', { error });
    }
  }

  // Handle updates from other users
  private async handleExternalUpdate(updatedItem: any) {
    try {
      // Check if this conflicts with local data
      const localItem = this.reorderItems.find(item => item.id === updatedItem.id);

      if (localItem && localItem.updatedAt > updatedItem.updatedAt) {
        // Local data is newer - show conflict resolution dialog
        await this.showConflictResolutionDialog(localItem, updatedItem);
      } else {
        // Server data is newer or no conflict - update locally
        await this.updateLocalItemFromServer(updatedItem);
      }
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to handle external update', { error });
    }
  }

  // Handle deletes from other users
  private async handleExternalDelete(deletedItem: any) {
    try {
      // Remove the item from our local list
      const itemIndex = this.reorderItems.findIndex(item => item.id === deletedItem.id);

      if (itemIndex >= 0) {
        this.reorderItems.splice(itemIndex, 1);

        // Re-index remaining items
        this.reorderItems.forEach((item, index) => {
          item.index = index + 1;
        });

        await this.saveOfflineItems();
        this.notifyListeners();

        logger.info('[ReorderService]', 'Removed external deleted item from local list', {
          itemId: deletedItem.itemId,
          addedBy: deletedItem.addedBy
        });
      }
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to handle external delete', { error });
    }
  }

  // Queue sync operation and trigger batching
  private queueBackgroundSync(operation: string, data: any) {
    if (this.isOfflineMode) {
      logger.info('[ReorderService]', `Queuing operation for later sync: ${operation}`, {
        operation,
        data,
        isOfflineMode: this.isOfflineMode
      });
      return;
    }

    this.syncQueue.push({
      operation,
      data,
      timestamp: Date.now(),
      retryCount: 0
    });

    logger.info('[ReorderService]', `Queued sync operation: ${operation}`, {
      queueLength: this.syncQueue.length,
      operation,
      dataKeys: Object.keys(data),
      isOfflineMode: this.isOfflineMode
    });

    // Trigger batched sync after user interaction
    this.triggerBatchSync('USER_INTERACTION');
  }

  // Force immediate sync (for manual sync button)
  async forceSyncNow(): Promise<void> {
    if (this.syncQueue.length === 0) {
      logger.info('[ReorderService]', 'No pending operations to sync');
      return;
    }

    logger.info('[ReorderService]', 'Force syncing pending operations immediately');

    // Clear any pending batch timeout
    if (this.syncBatchTimeout) {
      clearTimeout(this.syncBatchTimeout);
      this.syncBatchTimeout = null;
    }

    // Process immediately
    await this.processSyncBatch();
  }

  // Background sync methods
  private async syncCreateItem(data: any) {
    try {
      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('createReorderItem', 'ReorderService:syncCreateItem', data);

      const response = await this.client.graphql({
        query: mutations.createReorderItem,
        variables: {
          input: data
        }
      }) as any;

      if (response.data?.createReorderItem) {
        logger.info('[ReorderService]', `✅ Background sync: Created item on server`, { itemId: data.itemId });
        await appSyncMonitor.afterRequest('createReorderItem', 'ReorderService:syncCreateItem', true);
      } else {
        throw new Error('No data returned from createReorderItem mutation');
      }
    } catch (error: any) {
      await appSyncMonitor.afterRequest('createReorderItem', 'ReorderService:syncCreateItem', false, error);

      // Enhanced error logging
      logger.error('[ReorderService]', 'Failed to sync create item', {
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        graphQLErrors: error.errors,
        data,
        isAuthError: error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser'
      });

      // Handle specific error types
      if (error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser') {
        logger.warn('[ReorderService]', 'Authentication error during sync - switching to offline mode');
        this.isOfflineMode = true;
      }

      throw error;
    }
  }

  private async syncUpdateItem(data: any) {
    try {
      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('updateReorderItem', 'ReorderService:syncUpdateItem', data);

      const response = await this.client.graphql({
        query: mutations.updateReorderItem,
        variables: {
          input: data
        }
      }) as any;

      if (response.data?.updateReorderItem) {
        logger.info('[ReorderService]', `✅ Background sync: Updated item on server`, { itemId: data.id });
        await appSyncMonitor.afterRequest('updateReorderItem', 'ReorderService:syncUpdateItem', true);
      } else {
        throw new Error('No data returned from updateReorderItem mutation');
      }
    } catch (error: any) {
      await appSyncMonitor.afterRequest('updateReorderItem', 'ReorderService:syncUpdateItem', false, error);

      // Enhanced error logging
      logger.error('[ReorderService]', 'Failed to sync update item', {
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        graphQLErrors: error.errors,
        data,
        isAuthError: error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser'
      });

      // Handle specific error types
      if (error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser') {
        logger.warn('[ReorderService]', 'Authentication error during sync - switching to offline mode');
        this.isOfflineMode = true;
      }

      throw error;
    }
  }

  private async syncDeleteItem(data: any) {
    try {
      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('deleteReorderItem', 'ReorderService:syncDeleteItem', data);

      const response = await this.client.graphql({
        query: mutations.deleteReorderItem,
        variables: {
          input: { id: data.id }
        }
      }) as any;

      if (response.data?.deleteReorderItem) {
        logger.info('[ReorderService]', `✅ Background sync: Deleted item on server`, { itemId: data.id });
        await appSyncMonitor.afterRequest('deleteReorderItem', 'ReorderService:syncDeleteItem', true);
      } else {
        throw new Error('No data returned from deleteReorderItem mutation');
      }
    } catch (error: any) {
      await appSyncMonitor.afterRequest('deleteReorderItem', 'ReorderService:syncDeleteItem', false, error);

      // Enhanced error logging
      logger.error('[ReorderService]', 'Failed to sync delete item', {
        error: error.message,
        errorName: error.name,
        errorCode: error.code,
        graphQLErrors: error.errors,
        data,
        isAuthError: error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser'
      });

      // Handle specific error types
      if (error?.name === 'NotAuthorizedException' || error?.name === 'NoSignedUser') {
        logger.warn('[ReorderService]', 'Authentication error during sync - switching to offline mode');
        this.isOfflineMode = true;
      }

      throw error;
    }
  }

  // syncToggleCompletion removed - now uses syncUpdateItem

  // Show conflict resolution dialog
  private async showConflictResolutionDialog(localItem: ReorderItem, serverItem: any): Promise<void> {
    return new Promise((resolve) => {
      // Import Alert from react-native
      const { Alert } = require('react-native');

      Alert.alert(
        'Sync Conflict Detected',
        `Item "${localItem.itemId}" has been modified by another user.\n\nLocal: qty ${localItem.quantity}, updated ${new Date(localItem.updatedAt).toLocaleTimeString()}\nServer: qty ${serverItem.quantity}, updated ${new Date(serverItem.updatedAt).toLocaleTimeString()}\n\nWhat would you like to do?`,
        [
          {
            text: 'Keep Local',
            onPress: () => {
              logger.info('[ReorderService]', 'User chose to keep local version');
              // Queue local version to overwrite server
              this.queueBackgroundSync('UPDATE_ITEM', {
                id: localItem.id,
                quantity: localItem.quantity,
                status: localItem.status,
                updatedAt: new Date().toISOString()
              });
              resolve();
            }
          },
          {
            text: 'Use Server',
            onPress: async () => {
              logger.info('[ReorderService]', 'User chose to use server version');
              await this.updateLocalItemFromServer(serverItem);
              resolve();
            }
          },
          {
            text: 'Merge',
            onPress: () => {
              logger.info('[ReorderService]', 'User chose to merge versions');
              // Merge by taking higher quantity and more recent completion status
              const mergedItem = {
                ...localItem,
                quantity: Math.max(localItem.quantity, serverItem.quantity),
                status: serverItem.updatedAt > localItem.updatedAt ? serverItem.status : localItem.status,
                updatedAt: new Date().toISOString()
              };

              // Update local item
              const itemIndex = this.reorderItems.findIndex(item => item.id === localItem.id);
              if (itemIndex >= 0) {
                this.reorderItems[itemIndex] = mergedItem;
                this.notifyListeners();
              }

              // Queue merged version to server
              this.queueBackgroundSync('UPDATE_ITEM', {
                id: mergedItem.id,
                quantity: mergedItem.quantity,
                status: mergedItem.status,
                updatedAt: mergedItem.updatedAt
              });

              resolve();
            }
          },
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => {
              logger.info('[ReorderService]', 'User cancelled conflict resolution');
              resolve();
            }
          }
        ],
        { cancelable: false }
      );
    });
  }

  // Update local item from server data
  private async updateLocalItemFromServer(serverItem: any): Promise<void> {
    try {
      const itemIndex = this.reorderItems.findIndex(item => item.id === serverItem.id);

      if (itemIndex >= 0) {
        // Update existing item
        this.reorderItems[itemIndex] = {
          ...this.reorderItems[itemIndex],
          ...serverItem,
          timestamp: new Date(serverItem.createdAt),
          index: itemIndex + 1
        };
      } else {
        // Add new item from server
        this.reorderItems.push({
          ...serverItem,
          timestamp: new Date(serverItem.createdAt),
          index: this.reorderItems.length + 1
        });
      }

      // Save to local database
      await this.saveOfflineItems();

      // Notify listeners
      this.notifyListeners();

      logger.info('[ReorderService]', `Updated local item from server: ${serverItem.itemId}`);
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to update local item from server', { error });
    }
  }

  // Handle real-time reorder item creation
  private handleReorderItemCreated(newItem: any) {
    // Don't add if it's already in our local list
    const exists = this.reorderItems.find(item => item.id === newItem.id);
    if (exists) return;

    const reorderItem: ReorderItem = {
      ...newItem,
      timestamp: new Date(newItem.createdAt),
      index: this.reorderItems.length + 1
    };

    this.reorderItems.push(reorderItem);
    logger.info('[ReorderService]', `Real-time: Added reorder item ${newItem.itemId}`);
    this.notifyListeners();
  }

  // Handle real-time reorder item updates
  private handleReorderItemUpdated(updatedItem: any) {
    const index = this.reorderItems.findIndex(item => item.id === updatedItem.id);
    if (index >= 0) {
      this.reorderItems[index] = {
        ...updatedItem,
        timestamp: new Date(updatedItem.createdAt),
        index: this.reorderItems[index].index
      };
      logger.info('[ReorderService]', `Real-time: Updated reorder item ${updatedItem.itemId}`);
      this.notifyListeners();
    }
  }

  // Handle real-time reorder item deletion
  private handleReorderItemDeleted(deletedItem: any) {
    const initialLength = this.reorderItems.length;
    this.reorderItems = this.reorderItems.filter(item => item.id !== deletedItem.id);
    
    if (this.reorderItems.length < initialLength) {
      // Re-index remaining items
      this.reorderItems.forEach((item, index) => {
        item.index = index + 1;
      });
      logger.info('[ReorderService]', `Real-time: Deleted reorder item ${deletedItem.itemId}`);
      this.notifyListeners();
    }
  }

  // Handle team data updates from subscriptions
  private handleTeamDataUpdate(updatedItemData: any) {
    const itemId = updatedItemData.id;
    
    // Update cache
    const teamData: TeamData = {
      vendor: updatedItemData.vendor,
      vendorCost: updatedItemData.caseCost && updatedItemData.caseQuantity ? 
        updatedItemData.caseCost / updatedItemData.caseQuantity : undefined,
      caseUpc: updatedItemData.caseUpc,
      caseCost: updatedItemData.caseCost,
      caseQuantity: updatedItemData.caseQuantity,
      discontinued: updatedItemData.discontinued,
      notes: updatedItemData.notes?.[0]?.content,
    };
    
    this.teamDataCache.set(itemId, { data: teamData, timestamp: Date.now() });
    
    // Update any reorder items with this team data
    let itemsUpdated = false;
    this.reorderItems.forEach(reorderItem => {
      if (reorderItem.itemId === itemId) {
        reorderItem.teamData = teamData;
        itemsUpdated = true;
      }
    });
    
    if (itemsUpdated) {
      this.notifyListeners();
      logger.info('[ReorderService]', `Updated team data for item ${itemId} via real-time sync`);
    }
  }

  // LOCAL-FIRST team data fetching with caching
  async fetchTeamData(itemId: string): Promise<TeamData | undefined> {
    // Check cache first
    const cached = this.teamDataCache.get(itemId);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_DURATION) {
      return cached.data;
    }

    try {
      logger.info('[ReorderService]', '🔍 Fetching team data locally (LOCAL-FIRST)', { itemId });

      // ✅ CRITICAL FIX: Get from local SQLite only - NO AppSync calls
      const localTeamData = await modernDb.getTeamData(itemId);

      if (localTeamData) {
        const teamData: TeamData = {
          vendor: localTeamData.vendor,
          vendorCost: localTeamData.caseCost && localTeamData.caseQuantity ?
            localTeamData.caseCost / localTeamData.caseQuantity : undefined,
          caseUpc: localTeamData.caseUpc,
          caseCost: localTeamData.caseCost,
          caseQuantity: localTeamData.caseQuantity,
          discontinued: localTeamData.discontinued,
          notes: localTeamData.notes,
        };

        // Update cache
        this.teamDataCache.set(itemId, { data: teamData, timestamp: Date.now() });
        logger.info('[ReorderService]', '✅ Team data loaded from local database', { itemId });
        return teamData;
      } else {
        logger.info('[ReorderService]', '📭 No local team data found', { itemId });

        // ✅ LOCAL-FIRST: Only attempt recovery if explicitly requested AND online
        // Don't auto-recover on every scan - this violates local-first philosophy
        if (this.isOfflineMode) {
          logger.info('[ReorderService]', '🔒 Offline mode - skipping team data recovery', { itemId });
          return undefined;
        }

        // Check if we've already attempted recovery for this item recently
        const recoveryKey = `recovery_attempted_${itemId}`;
        const lastAttempt = this.teamDataCache.get(recoveryKey);
        if (lastAttempt && (Date.now() - lastAttempt.timestamp) < 300000) { // 5 minutes
          logger.info('[ReorderService]', '⏰ Recent recovery attempt - skipping to avoid spam', { itemId });
          return undefined;
        }

        // Mark that we're attempting recovery to prevent spam
        this.teamDataCache.set(recoveryKey, { data: null, timestamp: Date.now() });

        logger.info('[ReorderService]', '🔄 Attempting one-time team data recovery from DynamoDB', { itemId });
        return await this.recoverTeamDataFromDynamoDB(itemId);
      }
    } catch (error: any) {
      logger.error('[ReorderService]', '❌ Error fetching local team data', { error, itemId });
      return undefined;
    }
  }

  // ✅ CONTROLLED RECOVERY: Recover team data from DynamoDB only when appropriate
  private async recoverTeamDataFromDynamoDB(itemId: string): Promise<TeamData | undefined> {
    try {
      // Double-check offline status before making network call
      if (this.isOfflineMode) {
        logger.info('[ReorderService]', '🔒 Offline mode detected - aborting team data recovery', { itemId });
        return undefined;
      }

      logger.info('[ReorderService]', '🔄 Recovering team data from DynamoDB (controlled recovery)', { itemId });

      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('getItemData', 'ReorderService:teamDataRecovery', { id: itemId });

      const response = await this.client.graphql({
        query: queries.getItemData,
        variables: { id: itemId }
      }) as any;

      if (response.data?.getItemData) {
        const itemData = response.data.getItemData;
        const teamData: TeamData = {
          vendor: itemData.vendor,
          vendorCost: itemData.caseCost && itemData.caseQuantity ?
            itemData.caseCost / itemData.caseQuantity : undefined,
          caseUpc: itemData.caseUpc,
          caseCost: itemData.caseCost,
          caseQuantity: itemData.caseQuantity,
          discontinued: itemData.discontinued,
          notes: itemData.notes?.[0]?.content,
        };

        // Save to local database for future use
        await modernDb.upsertTeamData({
          itemId: itemId,
          caseUpc: itemData.caseUpc,
          caseCost: itemData.caseCost,
          caseQuantity: itemData.caseQuantity,
          vendor: itemData.vendor,
          discontinued: itemData.discontinued,
          notes: itemData.notes?.[0]?.content,
          lastSyncAt: new Date().toISOString(),
          owner: itemData.owner
        });

        // Update cache
        this.teamDataCache.set(itemId, { data: teamData, timestamp: Date.now() });
        logger.info('[ReorderService]', '✅ Team data recovered from DynamoDB and saved locally', { itemId });
        return teamData;
      } else {
        logger.info('[ReorderService]', '📭 No team data found in DynamoDB', { itemId });
        return undefined;
      }
    } catch (error: any) {
      logger.error('[ReorderService]', '❌ Team data recovery from DynamoDB failed', { error, itemId });

      // If it's an authentication error, switch to offline mode to prevent future attempts
      if (error.name === 'NotAuthorizedException' || error.name === 'NoSignedUser') {
        logger.warn('[ReorderService]', '🔒 Authentication failed - switching to offline mode', { itemId });
        this.isOfflineMode = true;
      }

      return undefined;
    }
  }

  // Add listener for reorder list changes
  addListener(listener: (items: DisplayReorderItem[]) => void) {
    this.listeners.push(listener);
    
    // Initialize service when first listener is added
    if (this.listeners.length === 1 && !this.isInitialized) {
      this.initialize(this.currentUserId || undefined).then(async () => {
        // Notify the listener with current cross-referenced data after initialization
        const displayItems = await crossReferenceService.buildDisplayItems(this.reorderItems);
        listener(displayItems);
      });
    } else {
      // If already initialized, immediately provide current cross-referenced data
      crossReferenceService.buildDisplayItems(this.reorderItems).then(displayItems => {
        listener(displayItems);
      });
    }
    
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  // PERFORMANCE OPTIMIZATION: Debounced notify to prevent excessive re-renders
  private notifyListeners = this.debounce(async () => {
    try {
      const startTime = Date.now();
      const displayItems = await crossReferenceService.buildDisplayItems(this.reorderItems);
      const endTime = Date.now();

      if (this.reorderItems.length > 50) {
        logger.debug('[ReorderService]', `Cross-reference completed for ${this.reorderItems.length} items in ${endTime - startTime}ms`);
      }

      this.listeners.forEach(listener => {
        try {
          listener(displayItems);
        } catch (error) {
          logger.error('[ReorderService]', 'Error notifying listener', { error });
        }
      });
    } catch (error) {
      logger.error('[ReorderService]', 'Error in notifyListeners', { error });
    }
  }, 100); // 100ms debounce to prevent excessive calls

  // Debounce utility function
  private debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
    let timeout: NodeJS.Timeout;
    return ((...args: any[]) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), wait);
    }) as T;
  }

  // Clean up subscriptions and timers
  cleanup() {
    this.subscriptions.forEach(sub => {
      if (sub && typeof sub.unsubscribe === 'function') {
        sub.unsubscribe();
      }
    });
    this.subscriptions = [];

    // Clean up sync timeout
    if (this.syncBatchTimeout) {
      clearTimeout(this.syncBatchTimeout);
      this.syncBatchTimeout = null;
    }

    // Real-time data change monitoring cleanup is handled by subscription cleanup above

    logger.info('[ReorderService]', 'Subscriptions, timers, and database monitoring cleaned up');
  }

  // Add item to reorder list using GraphQL
  async addItem(item: ConvertedItem, quantity: number = 1, teamData?: TeamData, addedBy: string = 'Unknown User', overwriteMode: boolean = false): Promise<boolean> {
    try {
      // Check if item already exists in reorder list
      const existingItemIndex = this.reorderItems.findIndex(
        reorderItem => reorderItem.itemId === item.id
      );

      // 🚀 LOCAL-FIRST: Always work locally first for instant responsiveness
      if (existingItemIndex >= 0) {
        // Update quantity for existing item locally
        const existingItem = this.reorderItems[existingItemIndex];
        if (overwriteMode) {
          existingItem.quantity = quantity; // Overwrite instead of add
        } else {
          existingItem.quantity += quantity; // Add to existing quantity
        }
        existingItem.updatedAt = new Date().toISOString();

        // Queue background sync
        this.queueBackgroundSync('UPDATE_ITEM', {
          id: existingItem.id,
          quantity: existingItem.quantity,
          updatedAt: existingItem.updatedAt
        });

        logger.info('[ReorderService]', `✅ Updated item locally: ${item.name} (qty: ${existingItem.quantity})`);
      } else {
        // Add new item locally (MINIMAL DATA ONLY)
        const newReorderItem: ReorderItem = {
          id: `local-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          itemId: item.id,              // Reference to Square catalog
          quantity,                     // Reorder quantity
          status: 'incomplete',         // Initial status
          addedBy: addedBy,            // Who added it
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          timestamp: new Date(),        // For chronological ordering
          index: this.reorderItems.length + 1
        };

        this.reorderItems.push(newReorderItem);

        // Queue background sync (MINIMAL DATA ONLY)
        this.queueBackgroundSync('CREATE_ITEM', {
          itemId: item.id,              // Reference to Square catalog
          quantity,                     // Reorder quantity
          status: 'incomplete',         // Initial status
          addedBy: addedBy             // Who added it
        });

        logger.info('[ReorderService]', `✅ Added item locally: ${item.name} (qty: ${quantity})`);
      }

      await this.saveOfflineItems();
      this.notifyListeners();

      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to add item', { error, itemId: item.id });
      return false;
    }
  }

  // Get all reorder items with cross-referenced data
  async getItems(): Promise<DisplayReorderItem[]> {
    return await crossReferenceService.buildDisplayItems(this.reorderItems);
  }

  // Get reorder items count
  getCount(): number {
    return this.reorderItems.length;
  }

  // Get incomplete reorder items count (for badge display)
  getIncompleteCount(): number {
    return this.reorderItems.filter(item => item.status === 'incomplete').length;
  }

  // Clear all reorder items - LOCAL-FIRST
  async clear() {
    try {
      const itemCount = this.reorderItems.length;

      // 🚀 LOCAL-FIRST: Clear locally first for instant responsiveness
      const itemsToDelete = [...this.reorderItems]; // Copy for background sync

      // Clear local arrays immediately
      this.reorderItems = [];

      // Queue background deletion for each item
      itemsToDelete.forEach(item => {
        this.queueBackgroundSync('DELETE_ITEM', {
          id: item.id
        });
      });

      // Save empty state locally
      await this.saveOfflineItems();
      this.notifyListeners();

      logger.info('[ReorderService]', `✅ Cleared ${itemCount} items locally (background sync queued)`);
      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to clear reorder items locally', { error });
      return false;
    }
  }

  // Remove specific item - LOCAL-FIRST
  async removeItem(itemId: string): Promise<boolean> {
    try {
      const itemIndex = this.reorderItems.findIndex(item => item.id === itemId);
      if (itemIndex === -1) {
        logger.warn('[ReorderService]', 'Item not found for removal', { itemId });
        return false;
      }

      const removedItem = this.reorderItems[itemIndex];

      // 🚀 LOCAL-FIRST: Remove locally first for instant responsiveness
      this.reorderItems.splice(itemIndex, 1);

      // Re-index remaining items
      this.reorderItems.forEach((item, index) => {
        item.index = index + 1;
      });

      // Queue background deletion
      this.queueBackgroundSync('DELETE_ITEM', {
        id: itemId
      });

      await this.saveOfflineItems();
      this.notifyListeners();

      logger.info('[ReorderService]', `✅ Removed item locally: ${removedItem.itemId} (background sync queued)`);
      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to remove reorder item locally', { error, itemId });
      return false;
    }
  }

  // Move item to chronological top by updating timestamp (independent of GUI filters/sorting)
  async moveItemToTop(itemId: string, teamData?: TeamData, userName: string = 'Unknown User'): Promise<boolean> {
    try {
      const itemIndex = this.reorderItems.findIndex(item => item.id === itemId);
      if (itemIndex === -1) {
        logger.error('[ReorderService]', 'Item not found for moveItemToTop', { itemId });
        return false;
      }

      const existingItem = this.reorderItems[itemIndex];

      // 🚀 LOCAL-FIRST: Update timestamp to bring to chronological top (behind the scenes)
      const now = new Date().toISOString();

      // Update item with new timestamp - this makes it chronologically most recent
      // regardless of how the GUI is filtering/sorting the display
      existingItem.updatedAt = now;
      existingItem.timestamp = new Date(now);
      existingItem.status = 'incomplete'; // Reset to incomplete
      // Note: teamData is now handled via cross-referencing, not stored directly

      // Queue background sync
      this.queueBackgroundSync('UPDATE_ITEM', {
        id: itemId,
        status: 'incomplete',
        updatedAt: now
      });

      // Keep internal data sorted chronologically (most recent first)
      // This ensures scanning logic works correctly regardless of GUI display
      this.reorderItems.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      // Re-index items
      this.reorderItems.forEach((item, index) => {
        item.index = index + 1;
      });

      await this.saveOfflineItems();
      this.notifyListeners();

      logger.info('[ReorderService]', `Moved item to chronological top: ${existingItem.itemId}`, {
        itemId,
        newTimestamp: now,
        note: 'Chronological position independent of GUI filters'
      });
      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to move item to top', { error, itemId });
      return false;
    }
  }

  // Mark item as received by deleting from reorder list and logging in item history
  async markAsReceived(itemId: string, userName: string = 'Unknown User'): Promise<boolean> {
    try {
      const itemIndex = this.reorderItems.findIndex(item => item.id === itemId);
      if (itemIndex === -1) {
        logger.error('[ReorderService]', 'Item not found for markAsReceived', { itemId });
        return false;
      }

      const reorderItem = this.reorderItems[itemIndex];
      const squareItemId = reorderItem.itemId;

      // Step 1: Log the reorder completion in item history (using cross-referenced item name)
      try {
        // Get item name via cross-referencing
        const squareItem = await crossReferenceService.getSquareItem(squareItemId);
        const itemName = squareItem?.name || `Unknown Item (${squareItemId})`;

        // Import itemHistoryService if not already imported
        const { itemHistoryService } = await import('./itemHistoryService');

        await itemHistoryService.logReorder(
          squareItemId,
          itemName,
          reorderItem.quantity,
          userName
        );

        logger.info('[ReorderService]', `Logged reorder completion in item history: ${squareItemId}`, {
          itemName: itemName,
          quantity: reorderItem.quantity
        });
      } catch (historyError) {
        logger.error('[ReorderService]', 'Failed to log reorder completion in item history', {
          error: historyError,
          itemId: squareItemId
        });
        // Continue with deletion even if history logging fails
      }

      // Step 2: 🚀 LOCAL-FIRST: Delete locally first, then sync in background
      // Remove from active reorder list
      this.reorderItems.splice(itemIndex, 1);

      // Re-index remaining items
      this.reorderItems.forEach((item, index) => {
        item.index = index + 1;
      });

      // Queue background deletion
      this.queueBackgroundSync('DELETE_ITEM', {
        id: itemId
      });

      await this.saveOfflineItems();
      this.notifyListeners();

      logger.info('[ReorderService]', `✅ Marked item as received and deleted locally: ${itemId}`, {
        squareItemId: squareItemId,
        quantity: reorderItem.quantity
      });
      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to mark item as received', { error, itemId });
      return false;
    }
  }

  // Toggle item status (incomplete <-> complete)
  async toggleCompletion(itemId: string, userName: string = 'Unknown User') {
    try {
      const item = this.reorderItems.find(item => item.id === itemId);
      if (!item) return;

      const newStatus = item.status === 'incomplete' ? 'complete' : 'incomplete';

      // Note: We don't log reorder history here anymore - only when item is received (markAsReceived)

      // 🚀 LOCAL-FIRST: Update locally first for instant responsiveness
      item.status = newStatus;
      item.updatedAt = new Date().toISOString();

      // Queue background sync
      this.queueBackgroundSync('UPDATE_ITEM', {
        id: itemId,
        status: newStatus,
        updatedAt: item.updatedAt
      });

      await this.saveOfflineItems();
      await this.notifyListeners();

      logger.info('[ReorderService]', `Toggled status locally for item: ${itemId}`, {
        status: newStatus
      });
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to toggle completion', { error, itemId });
    }
  }

  // Manual refresh - reload from server and sync pending items (optimized for 2-3 second target)
  async refresh() {
    const startTime = Date.now();
    try {
      logger.info('[ReorderService]', '🔄 Starting optimized refresh...');

      // Check if we can connect to server
      const isAuthenticated = await this.checkAuthStatus();

      if (isAuthenticated) {
        // Sync pending items first (minimal data only)
        const syncStart = Date.now();
        await this.syncPendingItems();
        logger.debug('[ReorderService]', `Sync completed in ${Date.now() - syncStart}ms`);

        // Then reload from server (minimal data only)
        const loadStart = Date.now();
        await this.loadReorderItems();
        logger.debug('[ReorderService]', `Load completed in ${Date.now() - loadStart}ms`);

        // Cross-reference on-demand (instant local operation)
        const crossRefStart = Date.now();
        await this.notifyListeners();
        logger.debug('[ReorderService]', `Cross-reference completed in ${Date.now() - crossRefStart}ms`);

        const totalTime = Date.now() - startTime;
        logger.info('[ReorderService]', `✅ Manual refresh completed with sync in ${totalTime}ms`);
      } else {
        // Still offline, just reload local data (instant)
        await this.loadOfflineItems();
        await this.notifyListeners();
        const totalTime = Date.now() - startTime;
        logger.info('[ReorderService]', `✅ Manual refresh completed (offline mode) in ${totalTime}ms`);
      }
    } catch (error) {
      const totalTime = Date.now() - startTime;
      logger.error('[ReorderService]', `❌ Manual refresh failed after ${totalTime}ms`, { error });
    }
  }

  // Sync pending items to server
  private async syncPendingItems(): Promise<void> {
    if (this.pendingSyncItems.length === 0) return;
    
    logger.info('[ReorderService]', `Syncing ${this.pendingSyncItems.length} pending items`);
    
    const syncedItems: string[] = [];
    
    for (const item of this.pendingSyncItems) {
      try {
        const response = await this.client.graphql({
          query: mutations.createReorderItem,
          variables: {
            input: {
              itemId: item.itemId,        // Reference to Square catalog
              quantity: item.quantity,    // Reorder quantity
              status: item.status,        // 'incomplete' | 'complete'
              addedBy: item.addedBy      // Who added it
            }
          }
        }) as any;

        if (response.data?.createReorderItem) {
          syncedItems.push(item.id);
          logger.info('[ReorderService]', `Synced item: ${item.itemId}`);
        }
      } catch (error) {
        logger.error('[ReorderService]', `Failed to sync item: ${item.itemId}`, { error });
      }
    }
    
    // Remove synced items from pending list
    this.pendingSyncItems = this.pendingSyncItems.filter(item => !syncedItems.includes(item.id));
    
    logger.info('[ReorderService]', `Sync completed: ${syncedItems.length} items synced, ${this.pendingSyncItems.length} pending`);
  }

  // Add custom item to reorder list (items not in catalog)
  async addCustomItem(customItem: {
    itemName: string;
    itemCategory?: string;
    quantity: number;
    addedBy: string;
    vendor?: string;
    notes?: string;
  }): Promise<boolean> {
    try {
      const customId = `custom-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      // Create minimal reorder item (custom items use minimal format too)
      const newItem: ReorderItem = {
        id: customId,
        itemId: customId,              // Custom ID for cross-referencing
        quantity: customItem.quantity, // Reorder quantity
        status: 'incomplete',          // Initial status
        addedBy: customItem.addedBy,   // Who added it
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        timestamp: new Date(),
        index: this.reorderItems.length + 1
      };

      // Store custom item details in team_data table for cross-referencing
      try {
        const db = await modernDb.getDatabase();
        await db.runAsync(`
          INSERT OR REPLACE INTO team_data
          (item_id, vendor, notes, last_updated, updated_by, history)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          customId,
          customItem.vendor || 'Custom Item',
          JSON.stringify({
            itemName: customItem.itemName,
            itemCategory: customItem.itemCategory || 'Custom',
            isCustom: true,
            customNotes: customItem.notes
          }),
          new Date().toISOString(),
          customItem.addedBy,
          JSON.stringify([])
        ]);
        logger.debug('[ReorderService]', 'Stored custom item details in team_data', { customId });
      } catch (error) {
        logger.error('[ReorderService]', 'Failed to store custom item details', { error, customId });
      }

      // 🚀 LOCAL-FIRST: Add locally first for instant responsiveness
      this.reorderItems.unshift(newItem);

      // Queue background sync (MINIMAL DATA ONLY)
      this.queueBackgroundSync('CREATE_ITEM', {
        itemId: customId,              // Reference (custom items bypass cross-referencing)
        quantity: customItem.quantity, // Reorder quantity
        status: 'incomplete',          // Initial status
        addedBy: customItem.addedBy   // Who added it
      });

      await this.saveOfflineItems();
      this.notifyListeners();

      logger.info('[ReorderService]', `✅ Added custom item locally: ${customItem.itemName} (background sync queued)`, {
        itemId: customId,
        quantity: customItem.quantity
      });
      return true;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to add custom item locally', {
        error,
        itemName: customItem.itemName
      });
      return false;
    }
  }

  // Check if user is authenticated and online
  private async checkAuthStatus(): Promise<boolean> {
    try {
      // First check if user is authenticated using Amplify's getCurrentUser
      const { getCurrentUser } = require('aws-amplify/auth');
      const user = await getCurrentUser();

      if (!user) {
        this.isOfflineMode = true;
        logger.info('[ReorderService]', 'No authenticated user found, switching to offline mode');
        return false;
      }

      // CRITICAL FIX: Don't test AppSync connectivity during auth check
      // This was causing false offline mode when user is authenticated but AppSync has issues
      // Instead, just check authentication and assume online if authenticated
      this.isOfflineMode = false;
      logger.info('[ReorderService]', 'User authenticated - assuming online mode', {
        userId: user.userId || user.username
      });
      return true;

    } catch (authError: any) {
      // Authentication check failed
      this.isOfflineMode = true;
      logger.info('[ReorderService]', 'Authentication check failed - switching to offline mode', {
        error: authError.message
      });
      return false;
    }
  }

  // Test AppSync connectivity separately (only when needed for sync operations)
  private async testAppSyncConnectivity(): Promise<boolean> {
    try {
      await this.client.graphql({
        query: queries.listReorderItems,
        variables: { limit: 1 }
      });
      return true;
    } catch (error: any) {
      logger.warn('[ReorderService]', 'AppSync connectivity test failed', {
        error: error.message,
        errorName: error.name
      });
      return false;
    }
  }

  // Load items from local storage when offline
  private async loadOfflineItems(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const items = JSON.parse(stored);
        this.reorderItems = items.map((item: any, index: number) => ({
          ...item,
          timestamp: new Date(item.createdAt),
          index: index + 1
        }));
        logger.info('[ReorderService]', `Loaded ${this.reorderItems.length} items from offline storage`);
      }
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to load offline items', { error });
    }
  }

  // Save items to local storage
  private async saveOfflineItems(): Promise<void> {
    try {
      await AsyncStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.reorderItems));
      logger.info('[ReorderService]', 'Saved items to offline storage');
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to save offline items', { error });
    }
  }

  // Public method to force save offline data (used during sign-out)
  async forceSaveOfflineData(): Promise<void> {
    try {
      logger.info('[ReorderService]', 'Forcing offline data save (sign-out preservation)', {
        itemCount: this.reorderItems.length
      });

      // Save current items to AsyncStorage
      await AsyncStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.reorderItems));

      // Set offline mode to ensure data is loaded from storage on next init
      this.isOfflineMode = true;

      logger.info('[ReorderService]', 'Successfully preserved data for sign-out', {
        itemCount: this.reorderItems.length,
        storageKey: this.STORAGE_KEY
      });

      return Promise.resolve();
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to force save offline data', { error });
      return Promise.reject(error);
    }
  }

  // Public method to refresh authentication status (used when user signs in)
  async refreshAuthenticationStatus(): Promise<void> {
    try {
      logger.info('[ReorderService]', 'Refreshing authentication status...');

      const isAuthenticated = await this.checkAuthStatus();

      if (isAuthenticated && this.isOfflineMode) {
        // User just came online - set up online services
        logger.info('[ReorderService]', 'User came online - setting up sync services');

        // Set up real-time subscriptions
        this.setupSmartSubscriptions();

        // Set up event-driven sync
        this.setupEventDrivenSync();

        // Set up real-time data change monitoring
        this.setupRealTimeDataChangeMonitoring();

        // Trigger a sync to catch up
        await this.refresh();

        logger.info('[ReorderService]', 'Successfully transitioned to online mode');
      } else if (!isAuthenticated && !this.isOfflineMode) {
        // User went offline
        logger.info('[ReorderService]', 'User went offline - cleaning up online services');

        // Clean up subscriptions
        this.subscriptions.forEach(sub => {
          if (sub && typeof sub.unsubscribe === 'function') {
            sub.unsubscribe();
          }
        });
        this.subscriptions = [];
      }

    } catch (error) {
      logger.error('[ReorderService]', 'Failed to refresh authentication status', { error });
    }
  }

  // Get current sync status
  getSyncStatus(): {
    isOnline: boolean;
    pendingCount: number;
    isAuthenticated: boolean;
    currentUserId: string | null;
    isProcessingQueue: boolean;
    queueOperations: any[];
  } {
    return {
      isOnline: !this.isOfflineMode,
      pendingCount: this.syncQueue.length, // Fixed: was using pendingSyncItems instead of syncQueue
      isAuthenticated: !this.isOfflineMode && this.currentUserId !== null,
      // Additional debugging info
      currentUserId: this.currentUserId,
      isProcessingQueue: this.isProcessingQueue,
      queueOperations: this.syncQueue.map(op => ({
        operation: op.operation,
        retryCount: op.retryCount,
        timestamp: op.timestamp
      }))
    };
  }

  // Debug method to manually trigger sync
  async debugTriggerSync(): Promise<void> {
    logger.info('[ReorderService]', 'Debug: Manually triggering sync', {
      queueLength: this.syncQueue.length,
      isOfflineMode: this.isOfflineMode,
      isProcessingQueue: this.isProcessingQueue,
      currentUserId: this.currentUserId
    });

    if (this.isOfflineMode) {
      logger.warn('[ReorderService]', 'Debug: Cannot sync in offline mode');
      return;
    }

    if (this.syncQueue.length === 0) {
      logger.info('[ReorderService]', 'Debug: No operations in sync queue');
      return;
    }

    try {
      await this.processSyncBatch();
      logger.info('[ReorderService]', 'Debug: Manual sync completed');
    } catch (error) {
      logger.error('[ReorderService]', 'Debug: Manual sync failed', { error });
    }
  }

  // Local database functions for reorder items
  private async loadLocalReorderItems(): Promise<ReorderItem[]> {
    try {
      const db = await modernDb.getDatabase();
      const results = await db.getAllAsync<any>(`
        SELECT * FROM reorder_items
        WHERE pending_sync = 0
        ORDER BY created_at DESC
      `);

      // Map minimal database schema to ReorderItem interface
      return results.map(row => ({
        id: row.id,
        itemId: row.item_id,              // Reference to Square catalog
        quantity: row.quantity,           // Reorder quantity
        status: row.status || 'incomplete', // 'incomplete' | 'complete'
        addedBy: row.added_by,           // Who added it
        createdAt: row.created_at,       // Timestamps
        updatedAt: row.updated_at,
        timestamp: new Date(row.created_at), // For chronological ordering
        index: 0 // Will be set later
      }));
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to load local reorder items', { error });
      return [];
    }
  }

  private async saveReorderItemsLocally(items: ReorderItem[]): Promise<void> {
    try {
      const db = await modernDb.getDatabase();
      const now = new Date().toISOString();

      await db.withTransactionAsync(async () => {
        for (const item of items) {
          await db.runAsync(`
            INSERT OR REPLACE INTO reorder_items
            (id, item_id, quantity, status, added_by, created_at, updated_at, last_sync_at, pending_sync)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            item.id,
            item.itemId,                    // Reference to Square catalog
            item.quantity,                  // Reorder quantity
            item.status,                    // 'incomplete' | 'complete'
            item.addedBy,                   // Who added it
            item.createdAt,                 // Timestamps
            item.updatedAt,
            now,                           // Last sync timestamp
            0                              // Not pending sync
          ]);
        }
      });

      logger.info('[ReorderService]', `Saved ${items.length} reorder items locally (minimal data)`);
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to save reorder items locally', { error });
    }
  }

  // ✅ INITIAL RECOVERY: Recover data from DynamoDB when local data is missing
  private async recoverFromDynamoDB(): Promise<void> {
    try {
      logger.info('[ReorderService]', '🔄 Recovering reorder items from DynamoDB (initial recovery)');

      // Monitor AppSync request
      await appSyncMonitor.beforeRequest('listReorderItems', 'ReorderService:initialRecovery', { limit: 1000 });

      const response = await this.client.graphql({
        query: queries.listReorderItems,
        variables: {
          limit: 1000 // Adjust as needed
        }
      }) as any;

      if (response.data?.listReorderItems?.items) {
        const serverItems = response.data.listReorderItems.items.map((item: any, index: number) => ({
          ...item,
          timestamp: new Date(item.createdAt),
          index: index + 1
        }));

        // Save to local database
        await this.saveReorderItemsLocally(serverItems);

        // Update in-memory items
        this.reorderItems = serverItems;

        logger.info('[ReorderService]', `✅ Initial recovery completed: ${serverItems.length} reorder items recovered from DynamoDB`);

        // ✅ CROSS-REFERENCING: Item details and team data loaded on-demand via crossReferenceService
        // Notify listeners of recovered data (with cross-referenced display data)
        await this.notifyListeners();
      } else {
        logger.info('[ReorderService]', '📭 No reorder items found in DynamoDB');
      }
    } catch (error) {
      logger.error('[ReorderService]', '❌ Initial recovery from DynamoDB failed', { error });
      // Don't throw - this is a recovery operation
    }
  }

  // Run data consistency checks
  async runConsistencyCheck(): Promise<ConsistencyReport> {
    try {
      logger.info('[ReorderService]', 'Running data consistency check...');
      const report = await dataConsistencyService.runConsistencyCheck(this.reorderItems);

      if (report.totalIssues > 0) {
        logger.warn('[ReorderService]', `Found ${report.totalIssues} consistency issues`, {
          issuesByType: report.issuesByType,
          issuesBySeverity: report.issuesBySeverity
        });
      } else {
        logger.info('[ReorderService]', 'No consistency issues found');
      }

      return report;
    } catch (error) {
      logger.error('[ReorderService]', 'Failed to run consistency check', { error });
      throw error;
    }
  }

  // Check if consistency check should be run
  shouldRunConsistencyCheck(): boolean {
    return dataConsistencyService.shouldRunCheck();
  }
}

// Export singleton instance
export const reorderService = new ReorderService(); 