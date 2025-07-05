import logger from '../utils/logger';

/**
 * Event-driven data change notification system
 * Replaces polling with direct notifications when data changes
 */

export interface DataChangeEvent {
  table: 'catalog_items' | 'team_data' | 'images';
  operation: 'CREATE' | 'UPDATE' | 'DELETE';
  itemId: string;
  timestamp: number;
  data?: any; // Optional: the actual changed data
}

export type DataChangeListener = (event: DataChangeEvent) => void;

class DataChangeNotifier {
  private listeners: DataChangeListener[] = [];
  private isDisabled: boolean = false;

  /**
   * Temporarily disable all notifications
   */
  disable(): void {
    this.isDisabled = true;
    logger.debug('[DataChangeNotifier]', 'Notifications disabled');
  }

  /**
   * Re-enable notifications
   */
  enable(): void {
    this.isDisabled = false;
    logger.debug('[DataChangeNotifier]', 'Notifications enabled');
  }

  /**
   * Add a listener for data changes
   */
  addListener(listener: DataChangeListener): () => void {
    this.listeners.push(listener);

    logger.debug('[DataChangeNotifier]', `Added listener, total: ${this.listeners.length}`);

    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
      logger.debug('[DataChangeNotifier]', `Removed listener, total: ${this.listeners.length}`);
    };
  }

  /**
   * Notify all listeners of a data change
   */
  notifyChange(event: DataChangeEvent): void {
    // Skip notifications if disabled
    if (this.isDisabled) {
      logger.debug('[DataChangeNotifier]', 'Skipping notification - disabled', {
        table: event.table,
        operation: event.operation,
        itemId: event.itemId
      });
      return;
    }

    // Only log bulk operations and errors to reduce spam
    if (event.itemId === 'BULK_SYNC_COMPLETE' || this.listeners.length === 0) {
      logger.debug('[DataChangeNotifier]', 'Notifying data change', {
        table: event.table,
        operation: event.operation,
        itemId: event.itemId,
        listenerCount: this.listeners.length
      });
    }

    this.listeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        logger.error('[DataChangeNotifier]', 'Error in change listener', { error });
      }
    });
  }

  /**
   * Notify catalog item change
   */
  notifyCatalogItemChange(operation: 'CREATE' | 'UPDATE' | 'DELETE', itemId: string, data?: any): void {
    this.notifyChange({
      table: 'catalog_items',
      operation,
      itemId,
      timestamp: Date.now(),
      data
    });
  }

  /**
   * Notify team data change
   */
  notifyTeamDataChange(operation: 'CREATE' | 'UPDATE' | 'DELETE', itemId: string, data?: any): void {
    this.notifyChange({
      table: 'team_data',
      operation,
      itemId,
      timestamp: Date.now(),
      data
    });
  }

  /**
   * Notify image change
   */
  notifyImageChange(operation: 'CREATE' | 'UPDATE' | 'DELETE', itemId: string, data?: any): void {
    this.notifyChange({
      table: 'images',
      operation,
      itemId,
      timestamp: Date.now(),
      data
    });
  }

  /**
   * Get current listener count for debugging
   */
  getListenerCount(): number {
    return this.listeners.length;
  }
}

// Export singleton instance
export const dataChangeNotifier = new DataChangeNotifier();
export default dataChangeNotifier;
