import { SQLiteDatabase, openDatabaseAsync, SQLiteBindValue } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system';
import logger from '../utils/logger';
import { ConvertedItem } from '../types/api';
// REMOVED: import { transformCatalogItemToItem } from '../utils/catalogTransformers';
// This import was causing a circular dependency. We'll use dynamic imports instead.

// Constants
const DATABASE_NAME = 'joylabs.db';
const DATABASE_VERSION = 4; // Increment version for reorder table schema refactor (minimal data)
let db: SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLiteDatabase> | null = null;

// Define a helper type for Catalog Objects from API
// (This is simplified; a more specific type based on Square docs would be better)
type CatalogObjectFromApi = {
  type: string;
  id: string;
  updated_at: string;
  version: number | string; // Version can be number or string depending on context?
  is_deleted?: boolean;
  present_at_all_locations?: boolean;
  item_data?: any; // Replace with specific types later
  category_data?: any;
  tax_data?: any;
  discount_data?: any;
  modifier_list_data?: any;
  modifier_data?: any;
  item_variation_data?: any;
  image_data?: any;
  // Add other potential *_data fields
};

/**
 * Initializes the database connection and schema. This function is now designed
 * to be robust against race conditions by using a singleton promise.
 */
export function initDatabase(): Promise<SQLiteDatabase> {
  if (db) {
    return Promise.resolve(db);
  }
  if (dbInitPromise) {
    return dbInitPromise;
  }

  dbInitPromise = (async () => {
    try {
      logger.info('Database', 'Initializing database connection...');
      
      const newDb = await openDatabaseAsync(DATABASE_NAME);
      logger.info('Database', 'Database opened successfully');
      
      let currentVersion = 0;
      try {
        const versionRow = await newDb.getFirstAsync<{ version: number }>(
          'SELECT version FROM db_version WHERE id = 1'
        );
        currentVersion = versionRow?.version || 0;
      } catch (e) {
        currentVersion = 0;
      }

      if (currentVersion < DATABASE_VERSION) {
        logger.info('Database', `Needs migration from v${currentVersion} to v${DATABASE_VERSION}`);
        await initializeSchema(newDb);
      } else {
        await initializeSchema(newDb);
      }
      
      await ensureLocationsTable(newDb);
      
      logger.info('Database', 'Database initialized successfully');
      db = newDb; // Assign to global `db` only on success
      return db;
    } catch (error) {
      logger.error('Database', 'Failed to initialize database', { error });
      dbInitPromise = null; // Reset promise on failure to allow retries
      throw new Error(`Failed to initialize database: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();

  return dbInitPromise;
}

/**
 * Check if database needs migration by verifying table structure
 */
async function checkDatabaseMigration(db: SQLiteDatabase): Promise<boolean> {
  try {
    // Check if we have a version table
    const versionTable = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='db_version'"
    );
    
    // If no version table, we need migration
    if (versionTable.length === 0) {
      logger.info('Database', 'No version table found, migration needed');
      return true;
    }
    
    // Check version
    const versionRow = await db.getFirstAsync<{ version: number }>(
      "SELECT version FROM db_version WHERE id = 1"
    );
    
    if (!versionRow || versionRow.version < DATABASE_VERSION) {
      logger.info('Database', `Database version ${versionRow?.version || 'unknown'} is outdated, current version is ${DATABASE_VERSION}`);
      return true;
    }
    
    // Check if sync_status table has all required columns
    try {
      // Try a simple query that will fail if any of these columns is missing
      await db.getFirstAsync(`SELECT 
        id, last_sync_time, is_syncing, sync_error, sync_progress, 
        sync_total, sync_type, last_sync_attempt, sync_attempt_count 
        FROM sync_status WHERE id = 1`);
      
      logger.info('Database', 'Schema validation successful');
      return false;
    } catch (error) {
      // If this fails, the schema is invalid
      logger.warn('Database', 'Schema validation failed, migration needed', { error });
      return true;
    }
  } catch (error) {
    // On any error, assume migration is needed
    logger.warn('Database', 'Error checking migration status, will recreate schema', { error });
    return true;
  }
}

/**
 * Initialize database schema - creates tables if they don't exist
 */
export async function initializeSchema(dbInstance?: SQLiteDatabase): Promise<void> {
  logger.info('Database', 'Initializing database schema...');
  const db = dbInstance || await getDatabase();
  let currentVersion = 0;

  // Check if db_version table exists and get current version
  try {
    const versionRow = await db.getFirstAsync<{ version: number }>(
      'SELECT version FROM db_version WHERE id = 1'
    );
    currentVersion = versionRow?.version || 0;
    logger.info('Database', `Current DB version: ${currentVersion}`);
  } catch (error) {
    logger.warn('Database', 'db_version table not found or error reading version, assuming version 0.', { error });
    currentVersion = 0;
  }

  if (currentVersion < DATABASE_VERSION) {
    logger.info('Database', `Schema outdated (Current: ${currentVersion}, Required: ${DATABASE_VERSION}). Applying migrations/recreating...`);
    
    // --- Migration Logic ---
    await db.withTransactionAsync(async () => {
      logger.info('Schema Init', 'Starting schema creation/update transaction...');

      // Special migration for reorder_items table (v3 -> v4): Convert to minimal data structure
      if (currentVersion === 3) {
        logger.info('Schema Migration', 'Migrating reorder_items from v3 to v4 (minimal data structure)...');
        try {
          // Check if old reorder_items table exists
          const tableExists = await db.getAllAsync<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='reorder_items'"
          );

          if (tableExists.length > 0) {
            // Backup existing data
            const existingItems = await db.getAllAsync<any>('SELECT * FROM reorder_items');
            logger.info('Schema Migration', `Found ${existingItems.length} existing reorder items to migrate`);

            // Create new table with minimal schema
            await db.runAsync('DROP TABLE IF EXISTS reorder_items');
            await db.runAsync(`CREATE TABLE reorder_items (
              id TEXT PRIMARY KEY NOT NULL,
              item_id TEXT NOT NULL,
              quantity INTEGER DEFAULT 1,
              status TEXT DEFAULT 'incomplete',
              added_by TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
              last_sync_at TEXT,
              owner TEXT,
              pending_sync INTEGER DEFAULT 0
            )`);

            // Migrate data to new format (minimal data only)
            for (const item of existingItems) {
              const status = item.completed ? 'complete' : 'incomplete';
              await db.runAsync(
                `INSERT INTO reorder_items (id, item_id, quantity, status, added_by, created_at, updated_at, last_sync_at, owner, pending_sync)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                item.id, item.item_id, item.quantity, status, item.added_by,
                item.created_at, item.updated_at, item.last_sync_at, item.owner, item.pending_sync
              );
            }

            logger.info('Schema Migration', `Successfully migrated ${existingItems.length} reorder items to minimal format`);
          }
        } catch (migrationError) {
          logger.error('Schema Migration', 'Error migrating reorder_items table', { migrationError });
          // Continue with full recreation if migration fails
        }
      }

      // Drop remaining tables for full recreation (except reorder_items if already migrated)
      logger.info('Schema Init', 'Dropping existing tables (part of update)...');
      try {
        await db.runAsync('DROP TABLE IF EXISTS sync_status');
        await db.runAsync('DROP TABLE IF EXISTS team_data');
        // Skip reorder_items if already migrated above
        if (currentVersion !== 3) {
          await db.runAsync('DROP TABLE IF EXISTS reorder_items');
        }
        await db.runAsync('DROP TABLE IF EXISTS item_change_logs');
        await db.runAsync('DROP TABLE IF EXISTS categories');
        await db.runAsync('DROP TABLE IF EXISTS catalog_items');
        await db.runAsync('DROP TABLE IF EXISTS item_variations');
        await db.runAsync('DROP TABLE IF EXISTS modifier_lists');
        await db.runAsync('DROP TABLE IF EXISTS modifiers');
        await db.runAsync('DROP TABLE IF EXISTS taxes');
        await db.runAsync('DROP TABLE IF EXISTS discounts');
        await db.runAsync('DROP TABLE IF EXISTS images');
        await db.runAsync('DROP TABLE IF EXISTS merchant_info');
        await db.runAsync('DROP TABLE IF EXISTS locations');
        await db.runAsync('DROP TABLE IF EXISTS sync_logs');
        await db.runAsync('DROP TABLE IF EXISTS db_version');
        logger.info('Schema Init', 'Existing tables dropped successfully (part of update).');
      } catch(dropError) {
        logger.error('Schema Init', 'Error dropping tables during update', { dropError });
        throw dropError;
      }

      logger.info('Schema Init', 'Creating tables...');
      try {
        // Create sync_status table
        await db.runAsync(`CREATE TABLE sync_status (
          id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
          last_sync_time TEXT,
          is_syncing INTEGER NOT NULL DEFAULT 0,
          sync_error TEXT,
          sync_progress INTEGER NOT NULL DEFAULT 0,
          sync_total INTEGER NOT NULL DEFAULT 0, -- Consider removing if progress is page-based
          sync_type TEXT, -- e.g., 'full', 'delta'
          last_page_cursor TEXT, -- Store cursor for resuming
          last_sync_attempt TEXT,
          sync_attempt_count INTEGER NOT NULL DEFAULT 0,
          last_incremental_sync_cursor TEXT
        )`);
        await db.runAsync(`INSERT INTO sync_status (id) VALUES (1)`);
        logger.debug('Schema Init', 'Created sync_status table.');

        // Create team_data table for local storage of AppSync ItemData
        await db.runAsync(`CREATE TABLE team_data (
          item_id TEXT PRIMARY KEY NOT NULL,
          case_upc TEXT,
          case_cost REAL,
          case_quantity INTEGER,
          vendor TEXT,
          discontinued INTEGER DEFAULT 0,
          notes TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          last_sync_at TEXT,
          owner TEXT
        )`);
        logger.debug('Schema Init', 'Created team_data table.');

        // PERFORMANCE OPTIMIZATION: Create indexes for team_data searches
        await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_team_data_case_upc ON team_data(case_upc)`);
        await db.runAsync(`CREATE INDEX IF NOT EXISTS idx_team_data_item_id ON team_data(item_id)`);
        logger.debug('Schema Init', 'Created team_data indexes.');

        // Create reorder_items table for minimal reorder data (cross-reference with Square catalog)
        // Skip if already created during migration
        if (currentVersion !== 3) {
          await db.runAsync(`CREATE TABLE reorder_items (
            id TEXT PRIMARY KEY NOT NULL,
            item_id TEXT NOT NULL,              -- Reference to Square catalog (cross-reference for item details)
            quantity INTEGER DEFAULT 1,         -- Reorder quantity
            status TEXT DEFAULT 'incomplete',   -- 'incomplete' | 'complete' (received is in team data history)
            added_by TEXT,                      -- Who added this item
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            last_sync_at TEXT,
            owner TEXT,
            pending_sync INTEGER DEFAULT 0
          )`);
          logger.debug('Schema Init', 'Created reorder_items table.');
        } else {
          logger.debug('Schema Init', 'Reorder_items table already migrated, skipping creation.');
        }

        // Create item_change_logs table for local storage of AppSync ItemChangeLogs
        await db.runAsync(`CREATE TABLE item_change_logs (
          id TEXT PRIMARY KEY NOT NULL,
          item_id TEXT NOT NULL,
          author_id TEXT,
          author_name TEXT,
          timestamp TEXT,
          change_type TEXT,
          change_details TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          last_sync_at TEXT,
          owner TEXT
        )`);
        logger.debug('Schema Init', 'Created item_change_logs table.');

        // Create categories table
        await db.runAsync(`CREATE TABLE categories (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL, -- Store as TEXT since it can be large number string
          is_deleted INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          data_json TEXT -- Store the raw category_data JSON
        )`);
        logger.debug('Schema Init', 'Created categories table.');
        await db.runAsync(`CREATE TABLE catalog_items (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          present_at_all_locations INTEGER DEFAULT 1,
          name TEXT,
          description TEXT,
          category_id TEXT, -- Reference categories table
          data_json TEXT -- Store the raw item_data JSON
        )`);
        logger.debug('Schema Init', 'Created catalog_items table.');
        await db.runAsync(`CREATE TABLE item_variations (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          item_id TEXT NOT NULL, -- Reference items table
          name TEXT,
          sku TEXT,
          pricing_type TEXT,
          price_amount INTEGER, -- Store amount in cents/smallest unit
          price_currency TEXT,
          data_json TEXT -- Store the raw item_variation_data JSON
        )`);
        logger.debug('Schema Init', 'Created item_variations table.');
        await db.runAsync(`CREATE TABLE modifier_lists (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          selection_type TEXT, -- SINGLE or MULTIPLE
          data_json TEXT -- Store the raw modifier_list_data JSON
        )`);
        logger.debug('Schema Init', 'Created modifier_lists table.');
        await db.runAsync(`CREATE TABLE modifiers (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          modifier_list_id TEXT NOT NULL, -- Reference modifier_lists table
          name TEXT,
          price_amount INTEGER,
          price_currency TEXT,
          ordinal INTEGER,
          data_json TEXT -- Store the raw modifier_data JSON
        )`);
        logger.debug('Schema Init', 'Created modifiers table.');
        await db.runAsync(`CREATE TABLE taxes (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          calculation_phase TEXT, -- SUBTOTAL_PHASE, TOTAL_PHASE
          inclusion_type TEXT, -- ADDITIVE, INCLUSIVE
          percentage TEXT, -- Store as string as it can be like "7.25"
          applies_to_custom_amounts INTEGER,
          enabled INTEGER,
          data_json TEXT -- Store the raw tax_data JSON
        )`);
        logger.debug('Schema Init', 'Created taxes table.');
        await db.runAsync(`CREATE TABLE discounts (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          discount_type TEXT, -- FIXED_PERCENTAGE, FIXED_AMOUNT, VARIABLE_PERCENTAGE, VARIABLE_AMOUNT
          percentage TEXT,
          amount INTEGER,
          currency TEXT,
          pin_required INTEGER,
          label_color TEXT,
          modify_tax_basis TEXT, -- MODIFY_TAX_BASIS, DO_NOT_MODIFY_TAX_BASIS
          data_json TEXT -- Store the raw discount_data JSON
        )`);
        logger.debug('Schema Init', 'Created discounts table.');
        await db.runAsync(`CREATE TABLE images (
          id TEXT PRIMARY KEY NOT NULL,
          updated_at TEXT NOT NULL,
          version TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          name TEXT,
          url TEXT,
          caption TEXT,
          type TEXT DEFAULT 'IMAGE', -- Keep track of object type
          data_json TEXT -- Store the raw image_data JSON
        )`);
        logger.debug('Schema Init', 'Created images table.');
        
        // --- Recreate Other Tables ---
        await db.runAsync(`CREATE TABLE merchant_info (
          id TEXT PRIMARY KEY NOT NULL,
          business_name TEXT,
          country TEXT,
          language_code TEXT,
          currency TEXT,
          status TEXT,
          main_location_id TEXT,
          created_at TEXT,
          last_updated TEXT,
          logo_url TEXT,
          data TEXT
        )`);
        logger.debug('Schema Init', 'Created merchant_info table.');
        await db.runAsync(`CREATE TABLE locations (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT,
          merchant_id TEXT,
          address TEXT,
          timezone TEXT,
          phone_number TEXT,
          business_name TEXT,
          business_email TEXT,
          website_url TEXT,
          description TEXT,
          status TEXT,
          type TEXT,
          logo_url TEXT,
          created_at TEXT,
          last_updated TEXT,
          data TEXT,
          is_deleted INTEGER NOT NULL DEFAULT 0
        )`);
        logger.debug('Schema Init', 'Created locations table.');
        await db.runAsync(`CREATE TABLE sync_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          data TEXT
        )`);
        logger.debug('Schema Init', 'Created sync_logs table.');
        await db.runAsync(`CREATE TABLE db_version (
          id INTEGER PRIMARY KEY NOT NULL DEFAULT 1,
          version INTEGER NOT NULL,
          updated_at TEXT
        )`);
        await db.runAsync(`INSERT INTO db_version (id, version, updated_at) VALUES (1, ?, ?)`, DATABASE_VERSION, new Date().toISOString());
        logger.debug('Schema Init', 'Created db_version table.');
        
        logger.info('Schema Init', 'All tables created successfully.');
      } catch (createError) {
        logger.error('Schema Init', 'Error creating tables', { createError });
        throw createError;
      }

      logger.info('Schema Init', 'Creating indexes...');
      try {
        // --- Create Indexes --- 
        // Catalog Items
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_items_name ON catalog_items (name)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_items_category_id ON catalog_items (category_id)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_items_deleted ON catalog_items (is_deleted)');
        // Variations
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_variations_item_id ON item_variations (item_id)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_variations_sku ON item_variations (sku)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_variations_deleted ON item_variations (is_deleted)');
        // Categories
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_categories_name ON categories (name)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_categories_deleted ON categories (is_deleted)');
        // Modifiers
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_modifiers_list_id ON modifiers (modifier_list_id)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_modifiers_deleted ON modifiers (is_deleted)');
        // Modifier Lists
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_modifier_lists_deleted ON modifier_lists (is_deleted)');
        // Taxes
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_taxes_deleted ON taxes (is_deleted)');
        // Discounts
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_discounts_deleted ON discounts (is_deleted)');
        // Images
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_images_deleted ON images (is_deleted)');
        // Locations
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_locations_merchant_id ON locations (merchant_id)');

        // PERFORMANCE OPTIMIZATION: Additional indexes for reorder operations
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_reorder_items_item_id ON reorder_items (item_id)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_reorder_items_status ON reorder_items (status)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_reorder_items_updated_at ON reorder_items (updated_at)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_reorder_items_owner ON reorder_items (owner)');

        // Composite indexes for common queries
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_catalog_items_category_deleted ON catalog_items (category_id, is_deleted)');
        await db.runAsync('CREATE INDEX IF NOT EXISTS idx_variations_item_deleted ON item_variations (item_id, is_deleted)');

        logger.info('Schema Init', 'All indexes created successfully.');
      } catch (indexError) {
        logger.error('Schema Init', 'Error creating indexes', { indexError });
        throw indexError;
      }
      
      // Update the database version number
      // Embedding value as runAsync parameter passing seems problematic
      await db.runAsync(`UPDATE db_version SET version = ${DATABASE_VERSION} WHERE id = 1`);
      logger.info('Schema Init', `Database version updated to ${DATABASE_VERSION}. Schema update transaction committed.`);
    });
  } else {
    logger.info('Database', 'Schema is up-to-date.');
  }
  
  // Enable foreign keys after initialization
  try {
    await db.runAsync('PRAGMA foreign_keys = ON;'); 
    logger.info('Database', 'Foreign key support enabled.');
  } catch (fkError) {
    logger.error('Database', 'Failed to enable foreign keys', { fkError });
    // Decide if this is critical; maybe throw?
  }

  logger.info('Database', 'Schema initialization completed.');
}

/**
 * Resets the entire database by deleting the file and re-initializing it.
 * This is a destructive operation.
 * @param dbInstance - An optional existing database instance to close.
 */
export async function resetDatabase(): Promise<void> {
  logger.warn('Database', 'Executing full database reset...');
  try {
    // Step 1: Close the active database connection, if it exists.
    await closeDatabase();

    // Step 2: Delete the database file from the filesystem.
    const dbPath = `${FileSystem.documentDirectory}SQLite/${DATABASE_NAME}`;
    logger.info('Database', `Deleting database file at: ${dbPath}`);
    await FileSystem.deleteAsync(dbPath, { idempotent: true });
    logger.info('Database', 'Database file deleted successfully.');

    // Step 3: Re-initialize the database. This will create a new empty file
    // and set up the schema.
    await initDatabase();
    logger.info('Database', 'Database has been re-initialized after reset.');

  } catch (error) {
    logger.error('Database', 'Failed to reset database', { error });
    // Re-throw the error to be handled by the calling function.
    throw error;
  }
}

/**
 * Closes the database connection if it's open.
 */
export async function closeDatabase(): Promise<void> {
  if (db) {
    await db.closeAsync();
    db = null;
    dbInitPromise = null; // Also clear the promise
    logger.info('Database', 'Database connection closed.');
  }
}

/**
 * Gets the singleton database instance, initializing it if necessary.
 * This function is the primary entry point for accessing the database.
 */
export async function getDatabase(): Promise<SQLiteDatabase> {
  return initDatabase();
}

/**
 * Upserts catalog objects into the database.
 * Takes an array of objects from the API.
 */
export async function upsertCatalogObjects(objects: CatalogObjectFromApi[]): Promise<void> {
  if (!objects || objects.length === 0) {
    return;
  }
  const db = await getDatabase();

  // Prepare statements for different object types (improves performance)
  // We will store the main identifying fields and the raw JSON data
  const statements = {
    ITEM: await db.prepareAsync(
      `INSERT OR REPLACE INTO catalog_items (id, updated_at, version, is_deleted, present_at_all_locations, name, description, category_id, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    CATEGORY: await db.prepareAsync(
      `INSERT OR REPLACE INTO categories (id, updated_at, version, is_deleted, name, data_json) 
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    ITEM_VARIATION: await db.prepareAsync(
      `INSERT OR REPLACE INTO item_variations (id, updated_at, version, is_deleted, item_id, name, sku, pricing_type, price_amount, price_currency, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    MODIFIER_LIST: await db.prepareAsync(
      `INSERT OR REPLACE INTO modifier_lists (id, updated_at, version, is_deleted, name, selection_type, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    MODIFIER: await db.prepareAsync(
      `INSERT OR REPLACE INTO modifiers (id, updated_at, version, is_deleted, modifier_list_id, name, price_amount, price_currency, ordinal, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    TAX: await db.prepareAsync(
      `INSERT OR REPLACE INTO taxes (id, updated_at, version, is_deleted, name, calculation_phase, inclusion_type, percentage, applies_to_custom_amounts, enabled, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    DISCOUNT: await db.prepareAsync(
      `INSERT OR REPLACE INTO discounts (id, updated_at, version, is_deleted, name, discount_type, percentage, amount, currency, pin_required, label_color, modify_tax_basis, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    IMAGE: await db.prepareAsync(
      `INSERT OR REPLACE INTO images (id, updated_at, version, is_deleted, name, url, caption, type, data_json) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
  };

  try {
    await db.withTransactionAsync(async () => {
      for (const obj of objects) {
        const versionStr = String(obj.version); // Ensure version is string
        const isDeleted = obj.is_deleted ? 1 : 0;
        const dataJson = JSON.stringify(obj); // Store the whole object

        // ---- REMOVE TEMPORARY DEBUG LOGGING ----
        /*
        const targetId = 'VMQX2FPCHRX6N5KT2KVKIQ23';
        if (obj.id === targetId) {
          // Log basic info when the target ID is processed
          logger.warn('Database', `*** Processing upsert for target ID ${targetId} ***`, { objectType: obj.type, isDeleted: isDeleted });
        }
        */
        // ---- END REMOVED TEMPORARY DEBUG LOGGING ----

        switch (obj.type) {
          case 'ITEM':
            // CRITICAL DEBUG: Log ITEM objects to see if they have image_ids
            if (obj.item_data?.image_ids && obj.item_data.image_ids.length > 0) {
              logger.info('Database::ITEM', 'ITEM with images found', {
                id: obj.id,
                name: obj.item_data?.name,
                imageIds: obj.item_data.image_ids,
                imageCount: obj.item_data.image_ids.length
              });
            } else if (obj.item_data?.name?.includes('Beyoglu')) {
              logger.warn('Database::ITEM', 'Beyoglu item has NO image_ids', {
                id: obj.id,
                name: obj.item_data?.name,
                hasImageIds: !!obj.item_data?.image_ids,
                imageIds: obj.item_data?.image_ids,
                itemDataKeys: obj.item_data ? Object.keys(obj.item_data) : []
              });
            }
            // First, insert the main item data
            await statements.ITEM.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.present_at_all_locations ? 1 : 0,
              obj.item_data?.name,
              obj.item_data?.description,
              obj.item_data?.category_id,
              dataJson // Store the full original object JSON for the item row
            );
            
            // **NEW: Process nested variations for this item**
            if (obj.item_data?.variations && Array.isArray(obj.item_data.variations)) {
              for (const variation of obj.item_data.variations) {
                // Ensure variation has necessary data and type
                if (variation && variation.type === 'ITEM_VARIATION' && variation.item_variation_data) {
                  const variationVersionStr = String(variation.version);
                  const variationIsDeleted = variation.is_deleted ? 1 : 0;
                  // Store the full original variation object JSON for the variation row
                  const variationDataJson = JSON.stringify(variation);
                  
                  // Use the ITEM_VARIATION prepared statement
                  try {
                    // Log parameters BEFORE attempting execution
                    logger.debug('Database::Upsert::Variation', 'Attempting variation insert', {
                      variationId: variation.id,
                      itemId: obj.id, // Explicitly use parent item ID
                      updated_at: variation.updated_at,
                      version: variationVersionStr,
                      isDeleted: variationIsDeleted,
                      name: variation.item_variation_data.name,
                      sku: variation.item_variation_data.sku,
                      pricing_type: variation.item_variation_data.pricing_type,
                      price_amount: variation.item_variation_data.price_money?.amount,
                      price_currency: variation.item_variation_data.price_money?.currency,
                      dataJsonLength: variationDataJson.length
                    });
                    
                     await statements.ITEM_VARIATION.executeAsync(
                      variation.id,                         // PK
                      variation.updated_at,
                      variationVersionStr,
                      variationIsDeleted,
                      obj.id,                               // FK - Explicitly use parent obj.id
                      variation.item_variation_data.name,
                      variation.item_variation_data.sku,
                      variation.item_variation_data.pricing_type,
                      variation.item_variation_data.price_money?.amount,
                      variation.item_variation_data.price_money?.currency,
                      variationDataJson                   // Full variation JSON
                    );
                  } catch (nestedVariationError) {
                     const errorMsg = nestedVariationError instanceof Error ? nestedVariationError.message : String(nestedVariationError);
                     logger.error('Database', 'Failed to insert/update nested ITEM_VARIATION', { 
                        variationId: variation.id, 
                        itemId: obj.id, 
                        error: errorMsg,
                        // Log all parameters attempted for insert
                        attemptedParams: {
                          id: variation.id,
                          updated_at: variation.updated_at,
                          version: variationVersionStr,
                          isDeleted: variationIsDeleted,
                          item_id: obj.id,
                          name: variation.item_variation_data.name,
                          sku: variation.item_variation_data.sku,
                          pricing_type: variation.item_variation_data.pricing_type,
                          price_amount: variation.item_variation_data.price_money?.amount,
                          price_currency: variation.item_variation_data.price_money?.currency,
                          dataJsonLength: variationDataJson.length
                        },
                        variationObject: variationDataJson // Log the variation JSON
                     });
                     // Decide if we should throw/rollback the whole transaction or continue
                     // For now, we log and continue to try and save other variations/items
                  }
                }
              }
            }

            // CRITICAL FIX: Only notify data change listeners if NOT in bulk sync mode
            try {
              const { default: catalogSyncService } = await import('../database/catalogSync');
              const syncStatus = await catalogSyncService.getSyncStatus();

              if (!syncStatus.isSyncing) {
                const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
                const operation = isDeleted ? 'DELETE' : 'UPDATE';
                dataChangeNotifier.notifyCatalogItemChange(operation, obj.id, obj);
              }
            } catch (error) {
              // Ignore notification errors to prevent breaking the main operation
              logger.debug('Database', 'Failed to notify catalog item change', { error, itemId: obj.id });
            }
            break;
          case 'CATEGORY':
            await statements.CATEGORY.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.category_data?.name,
              dataJson
            );
            break;
          case 'ITEM_VARIATION':
            // Wrap the execution in a try/catch to isolate variation errors
            try {
              // DEBUG: Log variation data before inserting, especially for the problematic UPC
              if (obj.item_variation_data?.upc === '827680191749') {
                logger.debug('Database::Upsert', '[Debug] Inserting variation with target UPC', { 
                  variationId: obj.id, 
                  itemId: obj.item_variation_data?.item_id,
                  sku: obj.item_variation_data?.sku,
                  upc: obj.item_variation_data?.upc,
                  data_json_to_insert: dataJson // Log the full JSON string being inserted
                });
              }
              await statements.ITEM_VARIATION.executeAsync(
                obj.id,
                obj.updated_at,
                versionStr,
                isDeleted,
                obj.item_variation_data?.item_id,
                obj.item_variation_data?.name,
                obj.item_variation_data?.sku,
                obj.item_variation_data?.pricing_type,
                obj.item_variation_data?.price_money?.amount,
                obj.item_variation_data?.price_money?.currency,
                dataJson
              );
            } catch (variationError) {
              // Log the specific error and the variation that caused it
              logger.error('Database', 'Failed to insert/update ITEM_VARIATION', { 
                variationId: obj.id, 
                itemId: obj.item_variation_data?.item_id,
                error: variationError instanceof Error ? variationError.message : String(variationError),
                variationObject: JSON.stringify(obj) // Log the problematic object
              });
              // NOTE: For debugging, we are NOT re-throwing here. In production,
              // you might want to re-throw to ensure transaction integrity.
              // throw variationError;
            }
            break;
          case 'MODIFIER_LIST':
            await statements.MODIFIER_LIST.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.modifier_list_data?.name,
              obj.modifier_list_data?.selection_type,
              dataJson
            );
            break;
          case 'MODIFIER':
            await statements.MODIFIER.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.modifier_data?.modifier_list_id,
              obj.modifier_data?.name,
              obj.modifier_data?.price_money?.amount,
              obj.modifier_data?.price_money?.currency,
              obj.modifier_data?.ordinal,
              dataJson
            );
            break;
          case 'TAX':
            await statements.TAX.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.tax_data?.name,
              obj.tax_data?.calculation_phase,
              obj.tax_data?.inclusion_type,
              obj.tax_data?.percentage,
              obj.tax_data?.applies_to_custom_amounts ? 1 : 0,
              obj.tax_data?.enabled ? 1 : 0,
              dataJson
            );
            break;
          case 'DISCOUNT':
            await statements.DISCOUNT.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.discount_data?.name,
              obj.discount_data?.discount_type,
              obj.discount_data?.percentage,
              obj.discount_data?.amount_money?.amount,
              obj.discount_data?.amount_money?.currency,
              obj.discount_data?.pin_required ? 1 : 0,
              obj.discount_data?.label_color,
              obj.discount_data?.modify_tax_basis,
              dataJson
            );
            break;
          case 'IMAGE':
            // CRITICAL DEBUG: Log IMAGE object to understand structure
            logger.info('Database::IMAGE', 'Processing IMAGE object', {
              id: obj.id,
              hasImageData: !!obj.image_data,
              imageDataKeys: obj.image_data ? Object.keys(obj.image_data) : [],
              name: obj.image_data?.name,
              url: obj.image_data?.url,
              caption: obj.image_data?.caption,
              fullObject: obj
            });

            // CRITICAL FIX: Square IMAGE objects might not have direct URLs
            // Check multiple possible URL fields and construct URL if needed
            let imageUrl = obj.image_data?.url;

            // If no direct URL, try to construct from Square CDN pattern
            if (!imageUrl && obj.image_data?.id) {
              // Square images are typically served from their CDN
              imageUrl = `https://items-images-production.s3.us-west-2.amazonaws.com/files/${obj.image_data.id}/original.jpeg`;
            }

            // Fallback: use the object ID if no image_data.id
            if (!imageUrl && obj.id) {
              imageUrl = `https://items-images-production.s3.us-west-2.amazonaws.com/files/${obj.id}/original.jpeg`;
            }

             await statements.IMAGE.executeAsync(
              obj.id,
              obj.updated_at,
              versionStr,
              isDeleted,
              obj.image_data?.name,
              imageUrl, // Use constructed URL
              obj.image_data?.caption,
              obj.type, // Store IMAGE type
              dataJson
            );

            // NOTE: Square handles image-to-item linking automatically
            // CatalogItem objects contain image_ids array that references CatalogImage objects
            // No manual linking needed - just ensure both are synced properly

            // CRITICAL FIX: Only notify data change listeners if NOT in bulk sync mode
            try {
              const { default: catalogSyncService } = await import('../database/catalogSync');
              const syncStatus = await catalogSyncService.getSyncStatus();

              if (!syncStatus.isSyncing) {
                const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
                const operation = isDeleted ? 'DELETE' : 'UPDATE';
                dataChangeNotifier.notifyImageChange(operation, obj.id, obj);
              }
            } catch (error) {
              // Ignore notification errors to prevent breaking the main operation
              logger.debug('Database', 'Failed to notify image change', { error, imageId: obj.id });
            }
            break;
          default:
            // Log unsupported type? Or ignore?
             logger.warn('Database', `Unsupported catalog object type encountered: ${obj.type}`, { id: obj.id });
            break;
        }
      }
    });
  } catch (error) {
     logger.error('Database', 'Error during catalog object upsert transaction', { error });
     throw error; // Re-throw to allow calling function to handle
  } finally {
    // Finalize prepared statements
    await Promise.all(Object.values(statements).map(stmt => stmt.finalizeAsync()));
  }
}



/**
 * Clears all catalog-related tables.
 */
export async function clearCatalogData(): Promise<void> {
  logger.info('Database', 'Clearing all catalog data...');
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM categories');
    await db.runAsync('DELETE FROM catalog_items');
    await db.runAsync('DELETE FROM item_variations');
    await db.runAsync('DELETE FROM modifier_lists');
    await db.runAsync('DELETE FROM modifiers');
    await db.runAsync('DELETE FROM taxes');
    await db.runAsync('DELETE FROM discounts');
    await db.runAsync('DELETE FROM images');
    // Optionally reset sync status related to catalog
    await db.runAsync('UPDATE sync_status SET last_sync_time = NULL, last_page_cursor = NULL WHERE id = 1');
  });
   logger.info('Database', 'Catalog data cleared.');
}

/**
 * Fetches the current sync status from the database.
 */
export async function getSyncStatus(): Promise<any> { // Replace 'any' with a specific SyncStatus type
  const db = await getDatabase();
  const status = await db.getFirstAsync('SELECT * FROM sync_status WHERE id = 1');
  return status;
}

/**
 * Updates specific fields in the sync status table.
 */
export async function updateSyncStatus(updates: Partial<{ /* Define SyncStatus type here */ }>): Promise<void> {
  const db = await getDatabase();
  const fields = Object.keys(updates);
  const values = Object.values(updates);
  
  if (fields.length === 0) return;
  
  const setClause = fields.map(field => `${field} = ?`).join(', ');
  const sql = `UPDATE sync_status SET ${setClause} WHERE id = 1`;
  
  // Cast values to the expected type
  await db.runAsync(sql, ...(values as SQLiteBindValue[]));
}

/**
 * Checks the content of the database for debugging.
 */
export async function checkDatabaseContent() {
  const db = await getDatabase();
  
  // Define expected row structure for counts
  type CountRow = { table_name: string; count: number };

  // Cast the result of the query to CountRow[]
  const counts = await db.getAllAsync<CountRow>(`
    SELECT 'categories' as table_name, COUNT(*) as count FROM categories
    UNION ALL
    SELECT 'catalog_items', COUNT(*) FROM catalog_items
    UNION ALL
    SELECT 'item_variations', COUNT(*) FROM item_variations
    UNION ALL
    SELECT 'modifier_lists', COUNT(*) FROM modifier_lists
    UNION ALL
    SELECT 'modifiers', COUNT(*) FROM modifiers
    UNION ALL
    SELECT 'taxes', COUNT(*) FROM taxes
    UNION ALL
    SELECT 'discounts', COUNT(*) FROM discounts
    UNION ALL
    SELECT 'images', COUNT(*) FROM images
    UNION ALL
    SELECT 'merchant', COUNT(*) FROM merchant_info
    UNION ALL
    SELECT 'locations', COUNT(*) FROM locations
  `);

  const samples = {
    // Cast sample results as well if needed, or use specific queries
    categories: await db.getAllAsync<{id: string, name: string}>('SELECT id, name FROM categories LIMIT 5'),
    items: await db.getAllAsync<{id: string, name: string}>('SELECT id, name FROM catalog_items LIMIT 5'),
    variations: await db.getAllAsync<{id: string, name: string, item_id: string}>('SELECT id, name, item_id FROM item_variations LIMIT 5'),
    // Add samples for other tables if needed
  };
  
  // The return type here should reflect the structure including CountRow
  return { counts: counts || [], samples }; // Ensure counts is always an array
}

/**
 * Searches local catalog items and variations for a given query term.
 * Performs a case-insensitive search across name, SKU, and GTIN (UPC).
 * @param query The search term.
 * @returns A promise resolving to an array of matching ConvertedItem objects.
 */
export async function searchLocalItems(query: string): Promise<ConvertedItem[]> {
  const db = await getDatabase();
  const searchTerm = `%${query}%`; // Prepare for LIKE query
  const exactQuery = query; // Keep original query for exact UPC match
  logger.info('Database', 'Searching local catalog', { query });

  try {
    // Broad SQL Query: Fetch if name, SKU, OR the variation JSON string matches
    // Using LIKE on data_json is a broad filter to ensure rows with potential UPC matches are included
    const results = await db.getAllAsync<any>(`
      SELECT 
        ci.id as item_id, 
        ci.data_json as item_data_json, 
        iv.data_json as variation_data_json, 
        iv.id as variation_id, /* Also fetch variation ID */
        ci.updated_at as item_updated_at
      FROM catalog_items ci
      JOIN item_variations iv ON ci.id = iv.item_id
      WHERE ci.is_deleted = 0 AND iv.is_deleted = 0
      AND (
        ci.name LIKE ? COLLATE NOCASE OR
        iv.sku LIKE ? COLLATE NOCASE OR
        iv.data_json LIKE ? /* Broad check for UPC within JSON */
      )
      ORDER BY ci.name COLLATE NOCASE ASC
    `, [searchTerm, searchTerm, searchTerm]); // Need searchTerm three times

    logger.debug('Database', `Local SQL search (name/sku/json) found ${results.length} potential matches`);

    // Refined TypeScript Filtering: Check name, SKU, and exact UPC
    const filteredResults = results.filter(row => {
      try {
        const itemData = JSON.parse(row.item_data_json || '{}');
        const variationData = JSON.parse(row.variation_data_json || '{}');
        
        // Check Name (case-insensitive contains)
        if (itemData.item_data?.name?.toLowerCase().includes(exactQuery.toLowerCase())) {
          return true; 
        }
        
        // Check SKU (case-insensitive contains)
        if (variationData.item_variation_data?.sku?.toLowerCase().includes(exactQuery.toLowerCase())) {
          return true; 
        }
        
        // Check UPC (exact match)
        const upc = variationData.item_variation_data?.upc;
        if (upc && upc === exactQuery) {
          logger.debug('Database', 'Found exact match via UPC check in code', { variationId: row.variation_id, upc });
          return true; 
        }
        
      } catch (parseError) {
        logger.error('Database', 'Error parsing JSON during filtering', { variationId: row.variation_id, error: parseError });
        return false; // Exclude if JSON parsing fails
      }
      return false; // Exclude if no fields matched
    });
    
    logger.debug('Database', `Filtered to ${filteredResults.length} matches after filtering`);

    // --- Transformation Logic (using filteredResults) --- 
    const transformedItemsMap = new Map<string, ConvertedItem>();

    // Loop through FILTERED results and transform
    for (const row of filteredResults) {
      try {
        const itemData = JSON.parse(row.item_data_json || '{}');
        const variationData = JSON.parse(row.variation_data_json || '{}');
        
        // --- Start: Determine CRV Type --- 
        let crvType: 'CRV5' | 'CRV10' | undefined = undefined;
        const modifierListInfo = itemData?.item_data?.modifier_list_info;
        
        // Check if modifier info exists and has IDs
        if (modifierListInfo && Array.isArray(modifierListInfo) && modifierListInfo.length > 0) {
          const modifierListIds = modifierListInfo
            .map((info: any) => info?.modifier_list_id)
            .filter((id: any): id is string => typeof id === 'string'); 

          if (modifierListIds.length > 0) {
            try {
              const placeholders = modifierListIds.map(() => '?').join(',');
              const modifierLists = await db.getAllAsync<{ name: string }>(
                `SELECT name FROM modifier_lists WHERE id IN (${placeholders})`,
                modifierListIds
              );

              // Check names for CRV types
              for (const list of modifierLists) {
                if (list.name === "Modifier Set - CRV10 >24oz") {
                  crvType = 'CRV10';
                  break; // Found CRV10, prioritize it
                }
                if (list.name === "Modifier Set - CRV5 <24oz") {
                  crvType = 'CRV5';
                }
              }
            } catch (dbError) {
              logger.error('Database', 'Error querying modifier_lists during search', { itemId: row.item_id, modifierListIds, error: dbError });
            }
          }
        }
        // --- End: Determine CRV Type ---
        
        // Reconstruct a partial CatalogObject structure for the transformer
        const reconstructedCatalogObject: Partial<CatalogObjectFromApi> & { id: string } = {
          id: row.item_id,
          type: 'ITEM',
          updated_at: row.item_updated_at,
          version: itemData.version || '0', 
          is_deleted: false,
          item_data: {
            // Spread the original item_data properties from the parsed item JSON
            ...(itemData.item_data || {}),
            // Ensure tax_ids are carried over if they exist at the item_data level
            tax_ids: itemData?.item_data?.tax_ids || [], 
            variations: [{ // Create the variation object structure
              id: variationData.id, 
              type: 'ITEM_VARIATION',
              updated_at: variationData.updated_at, // Need variation updated_at
              version: variationData.version, // Need variation version
              // Correctly nest the variation-specific data
              item_variation_data: variationData.item_variation_data || {}
            }]
          }
        };

        // Log the object being passed to the transformer
        logger.debug('Database::searchLocalItems', 'Reconstructed object for transformer:', { 
            itemId: reconstructedCatalogObject.id, 
            // Log specific parts to avoid overly large logs, or stringify if necessary
            itemDataName: reconstructedCatalogObject.item_data?.name,
            variationId: reconstructedCatalogObject.item_data?.variations?.[0]?.id,
            variationSku: reconstructedCatalogObject.item_data?.variations?.[0]?.item_variation_data?.sku,
            variationUpc: reconstructedCatalogObject.item_data?.variations?.[0]?.item_variation_data?.upc,
            taxIds: reconstructedCatalogObject.item_data?.tax_ids,
            crvType 
        });

        // Pass crvType to the transformer (using dynamic import to avoid circular dependency)
        const { transformCatalogItemToItem } = await import('../utils/catalogTransformers');
        const transformed = transformCatalogItemToItem(reconstructedCatalogObject as any);

        // Log the result from the transformer
        logger.debug('Database::searchLocalItems', 'Transformed item result:', transformed);

        if (transformed && !transformedItemsMap.has(transformed.id)) {
           transformedItemsMap.set(transformed.id, transformed);
        }
      } catch (parseError) {
        logger.error('Database', 'Failed to parse or transform local search result row', { 
          itemId: row.item_id, 
          error: parseError 
        });
      }
    }
    
    const uniqueItems = Array.from(transformedItemsMap.values());
    logger.info('Database', `Local search returning ${uniqueItems.length} unique items after transformation`);
    return uniqueItems;

  } catch (error) {
    logger.error('Database', 'Failed to execute local item search', { error, query });
    return []; // Return empty array on error
  }
}

/**
 * Fetches the raw data for the first 10 rows from the catalog_items table.
 * Useful for debugging purposes.
 */
export async function getFirstTenItemsRaw(): Promise<any[]> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching first 10 raw catalog items for inspection');
  try {
    // Fetching all columns to see the raw structure
    const results = await db.getAllAsync<any>(`
      SELECT * 
      FROM catalog_items 
      WHERE is_deleted = 0
      LIMIT 10
    `);
    logger.info('Database', `Fetched ${results.length} raw items`);
    return results;
  } catch (error) {
    logger.error('Database', 'Failed to fetch raw items for inspection', { error });
    throw error; // Re-throw the error to be caught by the caller
  }
}

/**
 * Fetches the raw row data for a specific item or variation by its ID.
 * @param id The ID of the item or variation.
 * @returns A promise resolving to the raw row data or null if not found.
 */
export async function getItemOrVariationRawById(id: string): Promise<any | null> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching raw item/variation by ID', { id });
  try {
    // Try finding in catalog_items first
    let result = await db.getFirstAsync<any>(
      `SELECT *, 'item' as found_in FROM catalog_items WHERE id = ?`,
      [id]
    );

    if (result) {
      logger.info('Database', 'Found item by ID', { id });
      return result;
    }

    // If not found in items, try variations
    result = await db.getFirstAsync<any>(
      `SELECT *, 'variation' as found_in FROM item_variations WHERE id = ?`,
      [id]
    );

    if (result) {
      logger.info('Database', 'Found variation by ID', { id });
      return result;
    } 

    logger.warn('Database', 'Item/variation not found by ID', { id });
    return null; // Not found in either table

  } catch (error) {
    logger.error('Database', 'Failed to fetch item/variation by ID', { id, error });
    throw error; // Re-throw error
  }
}

/**
 * Fetches the raw data for the first 10 rows from the item_variations table.
 * Useful for debugging purposes.
 */
export async function getFirstTenVariationsRaw(): Promise<any[]> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching first 10 raw item variations for inspection');
  try {
    // Fetching all columns to see the raw structure
    const results = await db.getAllAsync<any>(`
      SELECT * 
      FROM item_variations 
      WHERE is_deleted = 0
      LIMIT 10
    `);
    logger.info('Database', `Fetched ${results.length} raw variations`);
    return results;
  } catch (error) {
    logger.error('Database', 'Failed to fetch raw variations for inspection', { error });
    throw error; // Re-throw the error to be caught by the caller
  }
}

/**
 * Fetches all categories (ID and Name) from the database.
 * @returns A promise resolving to an array of categories { id: string, name: string }.
 */
export const getAllCategories = async (): Promise<Array<{ id: string; name: string }>> => {
  const db = await getDatabase();
  try {
    const results = await db.getAllAsync<{ id: string, name: string }>(
      'SELECT id, name FROM categories WHERE is_deleted = 0 ORDER BY name ASC'
    );
    return results;
  } catch (error) {
    logger.error('Database', 'Error fetching categories', { error });
    return [];
  }
};

/**
 * Fetches all non-deleted taxes (ID, Name, and Percentage) from the database.
 * @returns A promise resolving to an array of taxes { id: string, name: string, percentage: string | null }.
 */
export async function getAllTaxes(): Promise<{ id: string; name: string; percentage: string | null }[]> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching all taxes with percentages');
  try {
    // Fetch id, name, and the full data_json
    const results = await db.getAllAsync<{ id: string; name: string; data_json: string }>(`
      SELECT id, name, data_json 
      FROM taxes 
      WHERE is_deleted = 0 AND enabled = 1
      ORDER BY name ASC
    `);
    logger.info('Database', `Fetched ${results.length} enabled taxes`);

    // Parse the JSON and extract the percentage
    const taxesWithPercentage = results.map(tax => {
      let percentage: string | null = null;
      try {
        if (tax.data_json) {
          const taxData = JSON.parse(tax.data_json);
          // Access percentage within the nested tax_data object
          percentage = taxData?.tax_data?.percentage || null; 
        }
      } catch (parseError) {
        logger.error('Database::getAllTaxes', 'Failed to parse tax_data JSON', { taxId: tax.id, error: parseError });
      }
      return { id: tax.id, name: tax.name, percentage };
    });

    return taxesWithPercentage || [];
  } catch (error) {
    logger.error('Database', 'Failed to fetch taxes', { error });
    throw error;
  }
}

/**
 * Fetches all non-deleted modifier lists (ID and Name) from the database.
 * @returns A promise resolving to an array of modifier lists { id: string, name: string }.
 */
export async function getAllModifierLists(): Promise<{ id: string; name: string }[]> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching all modifier lists');
  try {
    const results = await db.getAllAsync<{ id: string; name: string }>(`
      SELECT id, name 
      FROM modifier_lists 
      WHERE is_deleted = 0
      ORDER BY name ASC
    `);
    logger.info('Database', `Fetched ${results.length} modifier lists`);
    return results || [];
  } catch (error) {
    logger.error('Database', 'Failed to fetch modifier lists', { error });
    throw error;
  }
}

/**
 * Ensure the locations table exists and has default data
 */
export async function ensureLocationsTable(dbInstance?: SQLiteDatabase): Promise<void> {
  try {
    const db = dbInstance || await getDatabase();
    logger.info('Database', 'Ensuring locations table exists and has data');
    
    // Create the locations table directly with "IF NOT EXISTS" instead of checking first
    await db.runAsync(`CREATE TABLE IF NOT EXISTS locations (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT,
      merchant_id TEXT,
      address TEXT,
      timezone TEXT,
      phone_number TEXT,
      business_name TEXT,
      business_email TEXT,
      website_url TEXT,
      description TEXT,
      status TEXT,
      type TEXT,
      logo_url TEXT,
      created_at TEXT,
      last_updated TEXT,
      data TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )`);
    
    // Create index on merchant_id (also using IF NOT EXISTS)
    await db.runAsync('CREATE INDEX IF NOT EXISTS idx_locations_merchant_id ON locations (merchant_id)');
    
    logger.info('Database', 'Successfully ensured locations table exists');
  } catch (error) {
    logger.error('Database', 'Error ensuring locations table', { error });
    throw error;
  }
}

/**
 * Fetches all locations (ID and Name) from the database.
 * @returns A promise resolving to an array of locations { id: string, name: string }.
 */
export async function getAllLocations(): Promise<{ id: string; name: string }[]> {
  const db = await getDatabase();
  logger.info('Database', 'Fetching all locations');
  
  try {
    const results = await db.getAllAsync<{ id: string; name: string }>(`
      SELECT id, name 
      FROM locations 
      WHERE is_deleted = 0 
      ORDER BY name ASC
    `);

    if (results.length === 0) {
      logger.warn('Database', 'The locations table is empty. A location sync may be required.');
    }
    
    logger.info('Database', `Fetched ${results.length} locations`);
    return results;
  } catch (error) {
    logger.error('Database', 'Error fetching locations', { error });
    // Return empty array instead of fallbacks
    return [];
  }
}

// Export default object with all methods
export default {
  initDatabase,
  resetDatabase,
  closeDatabase,
  getDatabase,
  upsertCatalogObjects,
  clearCatalogData,
  getSyncStatus,
  updateSyncStatus,
  checkDatabaseContent,
  getFirstTenItemsRaw,
  getItemOrVariationRawById,
  getFirstTenVariationsRaw,
  getAllCategories,
  getAllTaxes,
  getAllModifierLists,
  getAllLocations
}; 

// --- New Functions for Incremental Sync Cursor --- 

/**
 * Gets the cursor stored from the last successful incremental sync.
 */
export async function getLastIncrementalSyncCursor(): Promise<string | null> {
  try {
    const db = await getDatabase();
    // Use getFirstAsync which returns the first row or null
    const row = await db.getFirstAsync<{ last_incremental_sync_cursor: string | null }>(
      'SELECT last_incremental_sync_cursor FROM sync_status WHERE id = 1'
    );
    // Return the cursor value, which can be null if not set or row doesn't exist
    return row?.last_incremental_sync_cursor ?? null;
  } catch (error) {
    logger.error('Database', 'Error getting last incremental sync cursor', { error });
    // Decide on error handling: return null or throw? Returning null might be safer.
    return null;
  }
}

/**
 * Updates the cursor stored after a successful incremental sync.
 */
export async function updateLastIncrementalSyncCursor(cursor: string | null): Promise<void> {
  try {
    const db = await getDatabase();
    await db.runAsync(
      'UPDATE sync_status SET last_incremental_sync_cursor = ? WHERE id = 1',
      [cursor] // Pass cursor directly, it handles null correctly
    );
    logger.debug('Database', 'Updated last incremental sync cursor', { cursor });
  } catch (error) {
    logger.error('Database', 'Error updating last incremental sync cursor', { error, cursor });
    // Consider re-throwing or specific error handling if update fails
    throw error;
  }
}

// ===== TEAM DATA FUNCTIONS =====

export interface TeamData {
  itemId: string;
  caseUpc?: string;
  caseCost?: number;
  caseQuantity?: number;
  vendor?: string;
  discontinued?: boolean;
  notes?: string;
  createdAt?: string;
  updatedAt?: string;
  lastSyncAt?: string;
  owner?: string;
}

/**
 * Upsert team data to local SQLite database
 * CRITICAL FIX: Graceful handling when user is not signed in and team_data table doesn't exist
 */
export async function upsertTeamData(teamData: TeamData): Promise<void> {
  try {
    const db = await getDatabase();

    // Note: Table may exist from previous sign-ins
    const now = new Date().toISOString();

    await db.runAsync(`
      INSERT OR REPLACE INTO team_data
      (item_id, case_upc, case_cost, case_quantity, vendor, discontinued, notes, updated_at, last_sync_at, owner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      teamData.itemId,
      teamData.caseUpc || null,
      teamData.caseCost || null,
      teamData.caseQuantity || null,
      teamData.vendor || null,
      teamData.discontinued ? 1 : 0,
      teamData.notes || null,
      now,
      teamData.lastSyncAt || now,
      teamData.owner || null
    ]);

    logger.debug('Database', 'Upserted team data', { itemId: teamData.itemId });

    // CRITICAL FIX: Only notify data change listeners if NOT in bulk sync mode
    try {
      const { default: catalogSyncService } = await import('../database/catalogSync');
      const syncStatus = await catalogSyncService.getSyncStatus();

      if (!syncStatus.isSyncing) {
        const { dataChangeNotifier } = await import('../services/dataChangeNotifier');
        dataChangeNotifier.notifyTeamDataChange('UPDATE', teamData.itemId, teamData);
      }
    } catch (error) {
      // Ignore notification errors to prevent breaking the main operation
      logger.debug('Database', 'Failed to notify team data change', { error });
    }
  } catch (error) {
    // CRITICAL FIX: Graceful error handling for offline/unauthenticated users
    if (error?.message?.includes('no such table: team_data') || error?.code === 'ERR_INTERNAL_SQLITE_ERROR') {
      logger.debug('Database', 'Team data table may not exist (user not signed in), skipping upsert', {
        itemId: teamData.itemId,
        error: error?.message || error?.code
      });
      return;
    }

    logger.error('Database', 'Error upserting team data', { error, itemId: teamData.itemId });
    throw error;
  }
}

/**
 * Get team data for a specific item from local SQLite
 * CRITICAL FIX: Graceful handling when user is not signed in and team_data table doesn't exist
 */
export async function getTeamData(itemId: string): Promise<TeamData | null> {
  try {
    const db = await getDatabase();

    // Note: Table may exist from previous sign-ins, but specific items might be missing
    const result = await db.getFirstAsync<any>(`
      SELECT * FROM team_data WHERE item_id = ?
    `, [itemId]);

    if (!result) return null;

    return {
      itemId: result.item_id,
      caseUpc: result.case_upc,
      caseCost: result.case_cost,
      caseQuantity: result.case_quantity,
      vendor: result.vendor,
      discontinued: result.discontinued === 1,
      notes: result.notes,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
      lastSyncAt: result.last_sync_at,
      owner: result.owner
    };
  } catch (error) {
    // CRITICAL FIX: Graceful error handling for offline/unauthenticated users
    if (error?.message?.includes('no such table: team_data') || error?.code === 'ERR_INTERNAL_SQLITE_ERROR') {
      logger.debug('Database', 'Team data table may not exist or item not found (user not signed in)', {
        itemId,
        error: error?.message || error?.code
      });
      return null;
    }

    logger.error('Database', 'Error getting team data', { error, itemId });
    return null;
  }
}

/**
 * Get team data statistics for debugging
 */
export async function getTeamDataStats(): Promise<{
  totalItems: number;
  itemsWithCaseUpc: number;
  itemsWithVendor: number;
}> {
  const db = await getDatabase();

  try {
    const totalResult = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM team_data'
    );

    const caseUpcResult = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM team_data WHERE case_upc IS NOT NULL AND case_upc != ""'
    );

    const vendorResult = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM team_data WHERE vendor IS NOT NULL AND vendor != ""'
    );

    return {
      totalItems: totalResult?.count || 0,
      itemsWithCaseUpc: caseUpcResult?.count || 0,
      itemsWithVendor: vendorResult?.count || 0,
    };
  } catch (error) {
    logger.error('Database', 'Error getting team data stats', { error });
    return { totalItems: 0, itemsWithCaseUpc: 0, itemsWithVendor: 0 };
  }
}

/**
 * Search items by case UPC locally
 */
export async function searchItemsByCaseUpc(caseUpc: string): Promise<ConvertedItem[]> {
  const db = await getDatabase();

  logger.info('Database', 'Searching items by case UPC locally', { caseUpc });

  try {
    // Validate input - case UPCs should be numeric
    if (!/^\d+$/.test(caseUpc.trim())) {
      logger.debug('Database', 'Invalid case UPC format - must be numeric', { caseUpc });
      return [];
    }

    // First check if team_data table has any data
    const teamDataCount = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM team_data WHERE case_upc IS NOT NULL'
    );

    if (!teamDataCount || teamDataCount.count === 0) {
      logger.info('Database', 'No team data with case UPC found - table empty or user not signed in');
      return [];
    }

    // Fixed query: Use INNER JOIN instead of LEFT JOIN to ensure team_data exists
    // and handle NULL case_upc values properly
    const results = await db.getAllAsync<any>(`
      SELECT
        ci.id as item_id,
        ci.name,
        ci.description,
        ci.category_id,
        ci.data_json as item_data_json,
        td.case_upc,
        td.case_cost,
        td.case_quantity,
        td.vendor,
        td.discontinued,
        td.notes
      FROM catalog_items ci
      INNER JOIN team_data td ON ci.id = td.item_id
      WHERE td.case_upc = ? AND ci.is_deleted = 0 AND td.case_upc IS NOT NULL
      ORDER BY ci.name COLLATE NOCASE ASC
    `, [caseUpc]);

    logger.info('Database', `Found ${results.length} items with case UPC ${caseUpc}`);

    // Use dynamic import to avoid circular dependency
    const { transformCatalogItemToItem } = await import('../utils/catalogTransformers');

    return results.map(row => {
      try {
        // Parse the item data JSON to get full item details
        const itemData = row.item_data_json ? JSON.parse(row.item_data_json) : {};

        return transformCatalogItemToItem({
          ...itemData,
          id: row.item_id,
          item_data: {
            ...itemData.item_data,
            name: row.name,
            description: row.description,
            category_id: row.category_id
          },
          // Add team data
          team_data: {
            case_upc: row.case_upc,
            case_cost: row.case_cost,
            case_quantity: row.case_quantity,
            vendor: row.vendor,
            discontinued: row.discontinued === 1,
            notes: row.notes
          }
        });
      } catch (parseError) {
        logger.error('Database', 'Failed to parse case UPC search result', {
          itemId: row.item_id,
          error: parseError
        });
        return null;
      }
    }).filter((item): item is ConvertedItem => item !== null);

  } catch (error) {
    logger.error('Database', 'Error searching items by case UPC', { error, caseUpc });
    // Return empty array instead of throwing to prevent search failures
    return [];
  }
}

// ✅ REMOVED: getTeamDataLastSync function - no time-based polling needed
// Data syncs only via webhooks/AppSync or CRUD operations

// --- New Function for Deleting Objects ---

/**
 * Deletes a catalog object and its associated data (like variations) by ID.
 * Note: This currently targets items and variations. Extend if other types need specific deletion logic.
 */
export async function deleteCatalogObjectById(objectId: string): Promise<void> {
  if (!objectId) {
    logger.warn('Database', 'Attempted to delete object with null/empty ID');
    return;
  }
  
  logger.info('Database', 'Deleting catalog object by ID', { objectId });
  const db = await getDatabase();
  
  try {
    await db.withTransactionAsync(async () => {
      // Check if it's an item (and delete its variations first)
      const item = await db.getFirstAsync<{ id: string }>('SELECT id FROM catalog_items WHERE id = ?', [objectId]);
      if (item) {
        logger.debug('Database', 'Deleting variations for item', { objectId });
        await db.runAsync('DELETE FROM item_variations WHERE item_id = ?', [objectId]);
        logger.debug('Database', 'Deleting item itself', { objectId });
        await db.runAsync('DELETE FROM catalog_items WHERE id = ?', [objectId]);
        logger.info('Database', 'Successfully deleted item and its variations', { objectId });
        return; // Exit transaction early if item found and deleted
      }
      
      // Check if it's a variation (delete directly)
      const variation = await db.getFirstAsync<{ id: string }>('SELECT id FROM item_variations WHERE id = ?', [objectId]);
      if (variation) {
        logger.debug('Database', 'Deleting variation', { objectId });
        await db.runAsync('DELETE FROM item_variations WHERE id = ?', [objectId]);
        logger.info('Database', 'Successfully deleted variation', { objectId });
        return;
      }
      
      // Check if it's a category (delete directly)
      const category = await db.getFirstAsync<{ id: string }>('SELECT id FROM categories WHERE id = ?', [objectId]);
      if (category) {
        logger.debug('Database', 'Deleting category', { objectId });
        // Note: We might need to handle items associated with this category (set category_id to null?)
        // For now, just delete the category record.
        // await db.runAsync('UPDATE catalog_items SET category_id = NULL WHERE category_id = ?', [objectId]);
        await db.runAsync('DELETE FROM categories WHERE id = ?', [objectId]);
        logger.info('Database', 'Successfully deleted category', { objectId });
        return;
      }

      // TODO: Add checks and deletions for other types (Taxes, Modifiers, Discounts, Images) if they are stored in separate tables and need explicit deletion.
      // Example for Tax:
      // const tax = await db.getFirstAsync<{ id: string }>('SELECT id FROM taxes WHERE id = ?', [objectId]);
      // if (tax) {
      //   await db.runAsync('DELETE FROM taxes WHERE id = ?', [objectId]);
      //   logger.info('Database', 'Successfully deleted tax', { objectId });
      //   return;
      // }

      logger.warn('Database', 'Object ID not found in known deletable tables (item, variation, category)', { objectId });
      
    }); // End transaction
  } catch (error) {
    logger.error('Database', 'Error deleting catalog object by ID', { objectId, error });
    // Re-throw the error to be handled by the caller (e.g., the sync process)
    throw error;
  }
} 

export interface SearchFilters {
  name: boolean;
  sku: boolean;
  barcode: boolean;
  category: boolean;
}

export interface RawSearchResult {
  id: string; // This will be the item ID
  data_json: string; // The data_json of the main catalog_item
  match_type: 'name' | 'sku' | 'barcode' | 'category' | 'case_upc';
  match_context: string; // e.g., the actual SKU value, category name, etc.
}

/**
 * Tokenizes a search string by splitting on whitespace and removing punctuation
 * @param searchString The input search string
 * @returns Array of cleaned tokens
 */
function tokenizeSearchString(searchString: string): string[] {
  if (!searchString || typeof searchString !== 'string') {
    return [];
  }
  
  return searchString
    .toLowerCase()
    .trim()
    // Split on whitespace and common punctuation
    .split(/[\s\-_,\.\/\\]+/)
    // Remove empty strings and very short tokens (less than 2 characters)
    .filter(token => token.length >= 2)
    // Remove duplicates
    .filter((token, index, array) => array.indexOf(token) === index);
}

/**
 * Performs fuzzy search for name matches using tokenized search terms
 * All tokens must match somewhere in the item name (in any order)
 * @param tokens Array of search tokens
 * @returns Promise<RawSearchResult[]>
 */
async function searchNamesFuzzy(tokens: string[]): Promise<RawSearchResult[]> {
  if (tokens.length === 0) {
    return [];
  }

  const db = await getDatabase();
  
  // Build a query where ALL tokens must match the name
  // Each token gets its own LIKE condition joined with AND
  const tokenConditions = tokens.map(() => 'ci.name LIKE ? COLLATE NOCASE').join(' AND ');
  
  const query = `
    SELECT
      ci.id,
      ci.data_json,
      'name' as match_type,
      ci.name as match_context
    FROM catalog_items ci
    WHERE ci.is_deleted = 0 AND (${tokenConditions})
    ORDER BY 
      -- Prioritize exact matches first
      CASE WHEN ci.name LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END,
      -- Then prioritize matches where first token appears at start
      CASE WHEN ci.name LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END,
      -- Finally sort by name length (shorter names first, likely more relevant)
      LENGTH(ci.name),
      ci.name COLLATE NOCASE
  `;
  
  // Prepare parameters: one %token% for each token condition, plus exact match and first token prefix
  const tokenParams = tokens.map(token => `%${token}%`);
  const exactMatch = `%${tokens.join(' ')}%`; // Check if original phrase exists
  const firstTokenPrefix = `${tokens[0]}%`; // Check if first token is at start
  
  const params = [...tokenParams, exactMatch, firstTokenPrefix];
  
  try {
    const results = await db.getAllAsync<RawSearchResult>(query, params);
    logger.debug('searchNamesFuzzy', `Fuzzy name search found ${results.length} results for tokens:`, tokens);
    return results;
  } catch (error) {
    logger.error('searchNamesFuzzy', 'Error in fuzzy name search', { error, tokens });
    return [];
  }
}

export const searchCatalogItems = async (
  searchTerm: string,
  filters: SearchFilters
): Promise<RawSearchResult[]> => {
  // logger.debug('searchCatalogItems', 'Starting search', { searchTerm, filters });

  if (!searchTerm || searchTerm.trim().length === 0) {
    return [];
  }

  const queryParts: string[] = [];
  const params: any[] = [];
  const searchTermLike = `%${searchTerm.trim()}%`;

  // Use fuzzy search for names if name filter is enabled
  if (filters.name) {
    const tokens = tokenizeSearchString(searchTerm);
    
    if (tokens.length > 1) {
      // Use fuzzy search for multi-token queries
      logger.debug('searchCatalogItems', 'Using fuzzy search for name with tokens:', tokens);
      const fuzzyResults = await searchNamesFuzzy(tokens);
      
      // Convert fuzzy results to the format expected by the rest of the function
      if (fuzzyResults.length > 0) {
        // Add fuzzy results directly to final results since they're already processed
        const otherResults = await searchCatalogItemsNonName(searchTerm, {
          ...filters,
          name: false // Don't search names again
        });
        
        // Combine and deduplicate
        const allResults = [...fuzzyResults, ...otherResults];
        const uniqueResults = new Map<string, RawSearchResult>();
        allResults.forEach(row => {
          if (row && row.id && row.data_json) {
            // Prioritize fuzzy name matches over other match types
            if (!uniqueResults.has(row.id) || row.match_type === 'name') {
              uniqueResults.set(row.id, row);
            }
          }
        });
        
        const finalResults = Array.from(uniqueResults.values());
        logger.info('searchCatalogItems', `Fuzzy search for '${searchTerm}' found ${finalResults.length} unique items.`);
        return finalResults;
      }
      // If fuzzy search returns no results, fall back to exact search
    }
    
    // Fall back to exact search for single tokens or when fuzzy search fails
    queryParts.push(`
      SELECT
        ci.id,
        ci.data_json,
        'name' as match_type,
        ci.name as match_context
      FROM catalog_items ci
      WHERE ci.name LIKE ? AND ci.is_deleted = 0
    `);
    params.push(searchTermLike);
    logger.debug('searchCatalogItems', 'Using exact search for name');
  }

  if (filters.sku) {
    queryParts.push(`
      SELECT
        iv.item_id as id,
        ci.data_json,
        'sku' as match_type,
        iv.sku as match_context
      FROM item_variations iv
      JOIN catalog_items ci ON iv.item_id = ci.id
      WHERE iv.sku LIKE ? AND iv.is_deleted = 0 AND ci.is_deleted = 0
    `);
    params.push(searchTermLike);
    // logger.debug('searchCatalogItems', 'Added SKU query');
  }

  if (filters.barcode) {
    // Note: This relies on the specific JSON structure within data_json for item_variations.
    // This is less efficient than a dedicated column but necessary for the current schema.
    queryParts.push(`
      SELECT
        iv.item_id as id,
        ci.data_json,
        'barcode' as match_type,
        json_extract(iv.data_json, '$.item_variation_data.upc') as match_context
      FROM item_variations iv
      JOIN catalog_items ci ON iv.item_id = ci.id
      WHERE json_extract(iv.data_json, '$.item_variation_data.upc') LIKE ?
        AND iv.is_deleted = 0 AND ci.is_deleted = 0
    `);
    params.push(searchTermLike);
    // Note: Case UPC search is handled separately via GraphQL in the useCatalogItems hook
    // since Case UPC data is stored in AWS AppSync/DynamoDB, not in local SQLite
    // logger.debug('searchCatalogItems', 'Added barcode query');
  }

  if (filters.category) {
    const categorySearchTerm = searchTerm.trim();
    // Search by exact category name on catalog_items.category_id joining categories
    queryParts.push(`
      SELECT
        ci.id,
        ci.data_json,
        'category' as match_type,
        cat.name as match_context
      FROM catalog_items ci
      JOIN categories cat ON ci.category_id = cat.id
      WHERE cat.name LIKE ? AND ci.is_deleted = 0 AND cat.is_deleted = 0
    `);
    params.push(searchTermLike);
    // logger.debug('searchCatalogItems', 'Added category query (standard category_id)');
    
    // Search by reporting_category_id on catalog_items joining categories
    queryParts.push(`
      SELECT
        ci.id,
        ci.data_json,
        'category' as match_type,
        rcat.name as match_context
      FROM catalog_items ci
      JOIN categories rcat ON json_extract(ci.data_json, '$.reporting_category.id') = rcat.id
      WHERE rcat.name LIKE ? AND ci.is_deleted = 0 AND rcat.is_deleted = 0
    `);
    params.push(searchTermLike);
    // logger.debug('searchCatalogItems', 'Added category query (reporting_category_id)');
  }

  if (queryParts.length === 0) {
    // logger.debug('searchCatalogItems', 'No active filters, returning empty results.');
    return [];
  }

  const fullQuery = queryParts.join('\n\nUNION\n') + '\nLIMIT 250;';
  // logger.debug('searchCatalogItems', 'Executing combined query', { query: fullQuery, params });
  
  try {
    const db = await getDatabase();
    const rawResults = await db.getAllAsync<RawSearchResult>(fullQuery, params);
    // logger.debug('searchCatalogItems', `Raw query returned ${rawResults.length} results.`);
    
    // Deduplicate results based on item ID, preserving the first match found
    const uniqueResults = new Map<string, RawSearchResult>();
    rawResults.forEach(row => {
      if (row && row.id && row.data_json) {
        uniqueResults.set(row.id, row);
      } else {
        logger.warn('searchCatalogItems', 'Skipping invalid row from DB search', { row });
      }
    });
    
    const finalResults = Array.from(uniqueResults.values());
    // logger.info('searchCatalogItems', `Search for '${searchTerm}' found ${finalResults.length} unique items.`);
    return finalResults;
  } catch (error) {
    logger.error('searchCatalogItems', 'Error executing search query', { error, query: fullQuery });
    throw error; // Re-throw to be handled by the calling hook
  }
}; 

/**
 * Helper function to search non-name fields (SKU, barcode, category)
 * Used when combining with fuzzy name search
 */
async function searchCatalogItemsNonName(
  searchTerm: string,
  filters: SearchFilters
): Promise<RawSearchResult[]> {
  const queryParts: string[] = [];
  const params: any[] = [];
  const searchTermLike = `%${searchTerm.trim()}%`;

  if (filters.sku) {
    queryParts.push(`
      SELECT
        iv.item_id as id,
        ci.data_json,
        'sku' as match_type,
        iv.sku as match_context
      FROM item_variations iv
      JOIN catalog_items ci ON iv.item_id = ci.id
      WHERE iv.sku LIKE ? AND iv.is_deleted = 0 AND ci.is_deleted = 0
    `);
    params.push(searchTermLike);
  }

  if (filters.barcode) {
    queryParts.push(`
      SELECT
        iv.item_id as id,
        ci.data_json,
        'barcode' as match_type,
        json_extract(iv.data_json, '$.item_variation_data.upc') as match_context
      FROM item_variations iv
      JOIN catalog_items ci ON iv.item_id = ci.id
      WHERE json_extract(iv.data_json, '$.item_variation_data.upc') LIKE ?
        AND iv.is_deleted = 0 AND ci.is_deleted = 0
    `);
    params.push(searchTermLike);
    // Note: Case UPC search is handled separately via GraphQL since it's stored in AWS AppSync/DynamoDB
  }

  if (filters.category) {
    queryParts.push(`
      SELECT
        ci.id,
        ci.data_json,
        'category' as match_type,
        cat.name as match_context
      FROM catalog_items ci
      JOIN categories cat ON ci.category_id = cat.id
      WHERE cat.name LIKE ? AND ci.is_deleted = 0 AND cat.is_deleted = 0
    `);
    params.push(searchTermLike);
    
    queryParts.push(`
      SELECT
        ci.id,
        ci.data_json,
        'category' as match_type,
        rcat.name as match_context
      FROM catalog_items ci
      JOIN categories rcat ON json_extract(ci.data_json, '$.reporting_category.id') = rcat.id
      WHERE rcat.name LIKE ? AND ci.is_deleted = 0 AND rcat.is_deleted = 0
    `);
    params.push(searchTermLike);
  }

  if (queryParts.length === 0) {
    return [];
  }

  const fullQuery = queryParts.join('\n\nUNION\n') + '\nLIMIT 250;';
  
  try {
    const db = await getDatabase();
    const rawResults = await db.getAllAsync<RawSearchResult>(fullQuery, params);
    return rawResults.filter(row => row && row.id && row.data_json);
  } catch (error) {
    logger.error('searchCatalogItemsNonName', 'Error executing non-name search query', { error });
    return [];
  }
} 