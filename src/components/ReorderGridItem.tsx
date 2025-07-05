import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import CachedImage from './CachedImage';

interface ReorderGridItemProps {
  item: any; // DisplayReorderItem type
  size: 'large' | 'medium' | 'small';
  onImageTap: (imageUrl: string, item: any) => void;
  onImageLongPress?: (itemId: string) => void;
  onItemPress: () => void;
  onItemLongPress: () => void;
  onToggleComplete: () => void;
}

const ReorderGridItem: React.FC<ReorderGridItemProps> = ({
  item,
  size,
  onImageTap,
  onImageLongPress,
  onItemPress,
  onItemLongPress,
  onToggleComplete,
}) => {
  const { width: screenWidth } = Dimensions.get('window');
  
  // Calculate item width based on grid size
  const getItemWidth = () => {
    const padding = 32; // Total horizontal padding
    const spacing = size === 'large' ? 0 : size === 'medium' ? 16 : 32; // Spacing between items
    const columns = size === 'large' ? 1 : size === 'medium' ? 2 : 3;
    return (screenWidth - padding - spacing) / columns;
  };

  const itemWidth = getItemWidth();
  const imageSize = itemWidth - 16; // Account for item padding

  // Build data line efficiently
  const buildDataLine = () => {
    const parts = [
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
    ].filter(Boolean);

    return parts.join(' • ');
  };

  const getTextStyles = () => {
    switch (size) {
      case 'large':
        return {
          itemName: styles.itemNameLarge,
          itemDetails: styles.itemDetailsLarge,
        };
      case 'medium':
        return {
          itemName: styles.itemNameMedium,
          itemDetails: styles.itemDetailsMedium,
        };
      case 'small':
        return {
          itemName: styles.itemNameSmall,
          itemDetails: styles.itemDetailsSmall,
        };
    }
  };

  const textStyles = getTextStyles();

  return (
    <View style={[
      styles.gridItem,
      { width: itemWidth },
      item.status === 'complete' && styles.gridItemCompleted
    ]}>
      {/* Completion Toggle */}
      <Pressable style={styles.completionToggle} onPress={onToggleComplete}>
        {item.status === 'complete' ? (
          <View style={styles.completedCheckbox}>
            <Ionicons name="checkmark" size={12} color="#fff" />
          </View>
        ) : (
          <View style={styles.incompleteCheckbox} />
        )}
      </Pressable>

      {/* Image */}
      <Pressable
        style={[styles.imageContainer, { width: imageSize, height: imageSize }]}
        onPress={() => {
          if (item.item?.images && item.item.images.length > 0 && item.item.images[0]?.url) {
            onImageTap(item.item.images[0].url, item);
          }
        }}
        onLongPress={() => {
          // Long press on image thumbnail opens image management modal directly
          if (onImageLongPress) {
            onImageLongPress(item.itemId);
          }
        }}
      >
        {item.item?.images && item.item.images.length > 0 && item.item.images[0]?.url ? (
          <CachedImage
            source={{ uri: item.item.images[0].url }}
            style={styles.image}
            fallbackStyle={styles.fallbackImage}
            fallbackText={item.itemName ? item.itemName.substring(0, 2).toUpperCase() : '📦'}
            showLoadingIndicator={false}
          />
        ) : (
          <View style={styles.fallbackImage}>
            <Text style={styles.fallbackText}>
              {item.itemName ? item.itemName.substring(0, 2).toUpperCase() : '📦'}
            </Text>
          </View>
        )}
      </Pressable>

      {/* Item Info */}
      <Pressable
        style={styles.itemInfo}
        onPress={onItemPress}
        onLongPress={onItemLongPress}
      >
        {size !== 'small' && (
          <Text style={[
            textStyles.itemName,
            item.status === 'complete' && styles.completedText
          ]} numberOfLines={size === 'large' ? 2 : 1}>
            {item.itemName}
          </Text>
        )}
        
        {size === 'large' && (
          <Text style={textStyles.itemDetails} numberOfLines={3}>
            {buildDataLine()}
          </Text>
        )}
        
        {size === 'medium' && (
          <Text style={textStyles.itemDetails} numberOfLines={2}>
            {buildDataLine()}
          </Text>
        )}
      </Pressable>

      {/* Quantity Badge */}
      <View style={styles.quantityBadge}>
        <Text style={styles.quantityText}>{item.quantity}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  gridItem: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 8,
    marginBottom: 16,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    position: 'relative',
  },
  gridItemCompleted: {
    backgroundColor: '#f8f9fa',
  },
  completionToggle: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 10,
  },
  completedCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#4CD964',
    justifyContent: 'center',
    alignItems: 'center',
  },
  incompleteCheckbox: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: '#007AFF',
    backgroundColor: 'transparent',
  },
  imageContainer: {
    alignSelf: 'center',
    borderRadius: 8,
    overflow: 'hidden',
    marginTop: 24, // Space for completion toggle
    marginBottom: 8,
  },
  image: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  fallbackImage: {
    width: '100%',
    height: '100%',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  fallbackText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#666',
  },
  itemInfo: {
    flex: 1,
    paddingHorizontal: 4,
  },
  itemNameLarge: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
    textAlign: 'center',
  },
  itemNameMedium: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
    textAlign: 'center',
  },
  itemNameSmall: {
    fontSize: 12,
    fontWeight: '600',
    color: '#333',
    textAlign: 'center',
  },
  itemDetailsLarge: {
    fontSize: 12,
    color: '#666',
    lineHeight: 16,
    textAlign: 'center',
  },
  itemDetailsMedium: {
    fontSize: 10,
    color: '#666',
    lineHeight: 14,
    textAlign: 'center',
  },
  itemDetailsSmall: {
    fontSize: 9,
    color: '#666',
    textAlign: 'center',
  },
  completedText: {
    color: '#666',
  },
  quantityBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: '#007AFF',
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  quantityText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
});

export default ReorderGridItem;
