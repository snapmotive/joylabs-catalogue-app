import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  SafeAreaView
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { lightTheme } from '../themes';
import logger from '../utils/logger';
import CachedImage from './CachedImage';
import { imageCacheService } from '../services/imageCacheService';
import SimpleImagePicker from './SimpleImagePicker';

// Responsive sizing is now handled in styles

interface ItemImage {
  id: string;
  url: string;
  name: string;
}

interface ImageManagementModalProps {
  visible: boolean;
  onClose: () => void;
  images: ItemImage[];
  itemId: string;
  itemName: string;
  onImageUpload?: (imageUri: string, imageName: string) => Promise<void>;
  onImageMakePrimary?: (imageId: string) => Promise<void>;
  onImageDelete?: (imageId: string) => Promise<void>;
  onOperationComplete?: () => void; // Callback to signal when modal UI is updated
}

const ImageManagementModal: React.FC<ImageManagementModalProps> = ({
  visible,
  onClose,
  images,
  itemId,
  itemName,
  onImageUpload,
  onImageMakePrimary,
  onImageDelete,
  onOperationComplete
}) => {
  const [isUploading, setIsUploading] = useState(false);
  const [deletingImageId, setDeletingImageId] = useState<string | null>(null);
  const [makingPrimaryImageId, setMakingPrimaryImageId] = useState<string | null>(null);
  const [confirmDeleteImageId, setConfirmDeleteImageId] = useState<string | null>(null);
  const [confirmPrimaryImageId, setConfirmPrimaryImageId] = useState<string | null>(null);
  const [simplePickerVisible, setSimplePickerVisible] = useState(false);
  const [selectedImageForCrop, setSelectedImageForCrop] = useState<string | null>(null);

  // Local state to track modal's images - this updates immediately for UI responsiveness
  const [localImages, setLocalImages] = useState<ItemImage[]>(images);

  // Update local images when prop changes
  useEffect(() => {
    setLocalImages(images);
  }, [images]);

  // Preload images when modal becomes visible
  useEffect(() => {
    if (visible && localImages.length > 0) {
      logger.info('ImageManagementModal', 'Modal opened - preloading images', { count: localImages.length });
      localImages.forEach(image => {
        if (image.url) {
          imageCacheService.preloadImage(image.url);
        }
      });
    } else if (!visible) {
      logger.info('ImageManagementModal', 'Modal closed');
    }
  }, [visible, localImages]);



  // Handle taking photo with camera - DIRECT launch
  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need camera permission to take photos.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false, // Skip iOS editing screen - we'll crop manually
        quality: 0.8,
        exif: false,
        base64: false, // Don't include base64 to reduce memory usage
        aspect: [1, 1], // Request 1:1 aspect ratio from camera
      });

      if (!result.canceled && result.assets[0]) {
        // Set the selected image and open crop modal
        setSelectedImageForCrop(result.assets[0].uri);
        setSimplePickerVisible(true);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to take photo. Please try again.');
    }
  };

  // Handle selecting from gallery - DIRECT launch
  const handleSelectFromGallery = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need photo library permission to select images.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        // Set the selected image and open crop modal
        setSelectedImageForCrop(result.assets[0].uri);
        setSimplePickerVisible(true);
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to select image. Please try again.');
    }
  };

  // Handle image selection from Instagram-style picker
  const handleImageSelected = async (imageUri: string, imageName: string) => {
    try {
      await handleUploadImage(imageUri, imageName);
    } catch (error) {
      logger.error('ImageManagementModal', 'Failed to upload selected image', error);
      Alert.alert('Error', 'Failed to upload image. Please try again.');
    }
  };

  // Handle image upload
  const handleUploadImage = async (imageUri: string, imageName: string) => {
    if (!onImageUpload) {
      Alert.alert('Error', 'Image upload not available');
      return;
    }

    setIsUploading(true);
    try {
      await onImageUpload(imageUri, imageName);

      logger.info('ImageManagementModal', 'Image upload completed successfully', { imageName });

      // The parent will update the images prop, which will update localImages via useEffect
      // No need to manually update localImages here - let the prop update handle it

      // Wait a moment for the parent to refresh and pass updated images
      // Then signal completion so parent can refresh search results
      setTimeout(() => {
        if (onOperationComplete) {
          logger.info('ImageManagementModal', 'Signaling operation completion to parent');
          onOperationComplete();
        }
      }, 200); // Small delay to ensure parent has updated images prop

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ImageManagementModal', 'Error uploading image', { error: errorMessage, fullError: error });
      Alert.alert('Error', `Failed to upload image: ${errorMessage}`);
    } finally {
      setIsUploading(false);
    }
  };



  // Handle making image primary
  const handleMakePrimary = async (imageId: string) => {
    if (!onImageMakePrimary) {
      logger.warn('ImageManagementModal', 'No onImageMakePrimary handler provided');
      return;
    }

    logger.info('ImageManagementModal', 'Making image primary', {
      imageId,
      currentImages: localImages.map(img => img.id),
      currentPrimary: localImages[0]?.id
    });

    setMakingPrimaryImageId(imageId);
    try {
      await onImageMakePrimary(imageId);

      // Wait for parent to refresh and pass updated images, then signal completion
      setTimeout(() => {
        if (onOperationComplete) {
          logger.info('ImageManagementModal', 'Signaling make primary completion to parent');
          onOperationComplete();
        }
      }, 200);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('ImageManagementModal', 'Error making image primary', { error: errorMessage, fullError: error });
      Alert.alert('Error', `Failed to make image primary: ${errorMessage}`);
    } finally {
      setMakingPrimaryImageId(null);
    }
  };

  // Handle image deletion
  const handleDeleteImage = async (imageId: string) => {
    if (!onImageDelete) {
      return;
    }

    setDeletingImageId(imageId);
    try {
      await onImageDelete(imageId);

      // Wait for parent to refresh and pass updated images, then signal completion
      setTimeout(() => {
        if (onOperationComplete) {
          logger.info('ImageManagementModal', 'Signaling delete completion to parent');
          onOperationComplete();
        }
      }, 200);

    } catch (error) {
      logger.error('ImageManagementModal', 'Error deleting image', { error, imageId });
      Alert.alert('Error', 'Failed to delete image. Please try again.');
    } finally {
      setDeletingImageId(null);
    }
  };



  return (
    <Modal
      visible={visible}
      animationType="fade"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={styles.container}>
        {/* Content Wrapper for iPad */}
        <View style={styles.contentWrapper}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <Ionicons name="close" size={24} color={lightTheme.colors.text} />
          </TouchableOpacity>
          <Text style={styles.title}>Manage Images</Text>
          <View style={styles.placeholder} />
        </View>

        {/* Content */}
        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          {/* Item Info */}
          <View style={styles.itemInfo}>
            <Text style={styles.itemName}>{itemName}</Text>
            <Text style={styles.itemId}>ID: {itemId}</Text>
          </View>

          {isUploading && (
            <View style={styles.uploadingContainer}>
              <ActivityIndicator size="small" color={lightTheme.colors.primary} />
              <Text style={styles.uploadingText}>Uploading image...</Text>
            </View>
          )}

          {/* Existing Images */}
          <View style={styles.existingImagesSection}>
            <Text style={styles.sectionTitle}>
              Current Images ({localImages.length})
            </Text>

            {localImages.length === 0 ? (
              <View style={styles.noImagesContainer}>
                <Ionicons name="image-outline" size={48} color={lightTheme.colors.secondary} />
                <Text style={styles.noImagesText}>No images yet</Text>
                <Text style={styles.noImagesSubtext}>Add your first image using the buttons above</Text>
              </View>
            ) : (
              <View style={styles.imagesGrid}>
                {localImages.map((image, index) => {
                  const isPrimary = index === 0;
                  const isLoading = deletingImageId === image.id || makingPrimaryImageId === image.id;

                  return (
                    <View key={image.id} style={styles.imageItem}>
                      <View style={styles.imageContainer}>
                        <CachedImage
                          source={{ uri: image.url }}
                          style={styles.imagePreview}
                          fallbackStyle={styles.imagePreviewFallback}
                          fallbackText={image.name ? image.name.substring(0, 2).toUpperCase() : '📷'}
                          showLoadingIndicator={true}
                          resizeMode="cover"
                        />

                        {/* Action icons overlay */}
                        {!isLoading && (
                          <View style={styles.imageActionsOverlay}>
                            {/* Make Primary icon (bottom left) - only show if not already primary */}
                            {!isPrimary && (
                              <TouchableOpacity
                                style={[styles.actionIcon, styles.primaryIcon]}
                                onPress={() => setConfirmPrimaryImageId(image.id)}
                                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                              >
                                <Ionicons name="star" size={20} color="white" />
                              </TouchableOpacity>
                            )}

                            {/* Spacer for primary images to push delete icon to the right */}
                            {isPrimary && <View style={{ flex: 1 }} />}

                            {/* Delete icon (bottom right) - always show */}
                            <TouchableOpacity
                              style={[styles.actionIcon, styles.deleteIcon]}
                              onPress={() => setConfirmDeleteImageId(image.id)}
                              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                            >
                              <Ionicons name="trash-outline" size={20} color="white" />
                            </TouchableOpacity>
                          </View>
                        )}

                        {/* Primary badge (bottom left) */}
                        {isPrimary && (
                          <View style={styles.primaryBadge}>
                            <Ionicons name="star" size={20} color="#FFD700" />
                          </View>
                        )}

                        {/* Loading overlay */}
                        {isLoading && (
                          <View style={styles.imageLoadingOverlay}>
                            <ActivityIndicator size="small" color="white" />
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </View>
        </ScrollView>

        {/* Fixed Footer with Camera and Gallery Buttons */}
        <View style={styles.fixedFooter}>
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleTakePhoto}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color={lightTheme.colors.background} />
              ) : (
                <>
                  <Ionicons name="camera" size={24} color={lightTheme.colors.background} />
                  <Text style={styles.actionButtonText}>Camera</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleSelectFromGallery}
              disabled={isUploading}
            >
              <Ionicons name="images" size={24} color={lightTheme.colors.background} />
              <Text style={styles.actionButtonText}>Gallery</Text>
            </TouchableOpacity>
          </View>
        </View>
        </View>
      </SafeAreaView>

      {/* Delete Confirmation Modal */}
      <Modal
        visible={confirmDeleteImageId !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setConfirmDeleteImageId(null)}
      >
        <TouchableWithoutFeedback onPress={() => setConfirmDeleteImageId(null)}>
          <View style={styles.confirmModalOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.confirmModalContent}>
                <Text style={styles.confirmModalTitle}>Delete Image</Text>
                <Text style={styles.confirmModalMessage}>
                  Are you sure you want to delete this image? This action cannot be undone.
                </Text>
                <View style={styles.confirmModalButtons}>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalCancelButton]}
                    onPress={() => setConfirmDeleteImageId(null)}
                  >
                    <Text style={styles.confirmModalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalDeleteButton]}
                    onPress={() => {
                      if (confirmDeleteImageId) {
                        handleDeleteImage(confirmDeleteImageId);
                        setConfirmDeleteImageId(null);
                      }
                    }}
                  >
                    <Text style={styles.confirmModalDeleteText}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Make Primary Confirmation Modal */}
      <Modal
        visible={confirmPrimaryImageId !== null}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setConfirmPrimaryImageId(null)}
      >
        <TouchableWithoutFeedback onPress={() => setConfirmPrimaryImageId(null)}>
          <View style={styles.confirmModalOverlay}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={styles.confirmModalContent}>
                <Text style={styles.confirmModalTitle}>Make Primary Image</Text>
                <Text style={styles.confirmModalMessage}>
                  Set this image as the primary image for this item?
                </Text>
                <View style={styles.confirmModalButtons}>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalCancelButton]}
                    onPress={() => setConfirmPrimaryImageId(null)}
                  >
                    <Text style={styles.confirmModalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.confirmModalButton, styles.confirmModalPrimaryButton]}
                    onPress={() => {
                      if (confirmPrimaryImageId) {
                        handleMakePrimary(confirmPrimaryImageId);
                        setConfirmPrimaryImageId(null);
                      }
                    }}
                  >
                    <Text style={styles.confirmModalPrimaryText}>Make Primary</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* Simple Image Picker - Crop Only */}
      {selectedImageForCrop && (
        <SimpleImagePicker
          visible={simplePickerVisible}
          onClose={() => {
            setSimplePickerVisible(false);
            setSelectedImageForCrop(null);
          }}
          onImageSelected={(uri: string) => handleImageSelected(uri, `${itemName || 'item'}_${Date.now()}.jpg`)}
          itemName={itemName}
          preSelectedImage={selectedImageForCrop}
        />
      )}
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: lightTheme.colors.background,
  },
  contentWrapper: {
    flex: 1,
    width: '100%',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: lightTheme.colors.border,
  },
  closeButton: {
    padding: 8,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    color: lightTheme.colors.text,
  },
  placeholder: {
    width: 40,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 100, // Extra padding to account for fixed footer
  },
  itemInfo: {
    backgroundColor: lightTheme.colors.card,
    padding: 16,
    borderRadius: 8,
    marginBottom: 24,
  },
  itemName: {
    fontSize: 16,
    fontWeight: '600',
    color: lightTheme.colors.text,
    marginBottom: 4,
  },
  itemId: {
    fontSize: 14,
    color: lightTheme.colors.secondary,
  },
  addImageSection: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: lightTheme.colors.text,
    marginBottom: 12,
  },
  addImageButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  addImageButton: {
    flex: 1,
    alignItems: 'center',
    padding: 16,
    backgroundColor: lightTheme.colors.card,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: lightTheme.colors.border,
    gap: 8,
  },
  addImageButtonText: {
    fontSize: 14,
    color: lightTheme.colors.primary,
    fontWeight: '500',
  },
  uploadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
    gap: 8,
  },
  uploadingText: {
    fontSize: 14,
    color: lightTheme.colors.secondary,
  },
  existingImagesSection: {
    flex: 1,
  },
  noImagesContainer: {
    alignItems: 'center',
    padding: 32,
    backgroundColor: lightTheme.colors.card,
    borderRadius: 8,
  },
  noImagesText: {
    fontSize: 16,
    fontWeight: '500',
    color: lightTheme.colors.secondary,
    marginTop: 12,
  },
  noImagesSubtext: {
    fontSize: 14,
    color: lightTheme.colors.secondary,
    textAlign: 'center',
    marginTop: 4,
  },
  imagesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  imageItem: {
    width: '48%', // 2 columns like item modal
    marginBottom: 16,
  },
  imageContainer: {
    position: 'relative',
  },
  imagePreview: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
  },
  imagePreviewFallback: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 8,
    backgroundColor: lightTheme.colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageLoadingOverlay: {
    position: 'absolute',
    top: 8,
    left: 8,
    right: 8,
    bottom: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageActionsOverlay: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    right: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  primaryIcon: {
    // Additional styles for primary icon if needed
  },
  deleteIcon: {
    // Additional styles for delete icon if needed
  },
  primaryBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  confirmModalContent: {
    backgroundColor: lightTheme.colors.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    paddingBottom: 34, // Extra padding for safe area
  },
  confirmModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: lightTheme.colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  confirmModalMessage: {
    fontSize: 16,
    color: lightTheme.colors.secondary,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  confirmModalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  confirmModalButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  confirmModalCancelButton: {
    backgroundColor: lightTheme.colors.card,
    borderWidth: 1,
    borderColor: lightTheme.colors.border,
  },
  confirmModalDeleteButton: {
    backgroundColor: '#FF3B30',
  },
  confirmModalPrimaryButton: {
    backgroundColor: lightTheme.colors.primary,
  },
  confirmModalCancelText: {
    fontSize: 16,
    fontWeight: '500',
    color: lightTheme.colors.text,
  },
  confirmModalDeleteText: {
    fontSize: 16,
    fontWeight: '500',
    color: 'white',
  },
  confirmModalPrimaryText: {
    fontSize: 16,
    fontWeight: '500',
    color: 'white',
  },
  buttonIconContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  enhanceIcon: {
    position: 'absolute',
    top: -2,
    right: -2,
  },
  enhanceHint: {
    fontSize: 12,
    color: lightTheme.colors.secondary,
    marginTop: 2,
    textAlign: 'center',
  },
  addPhotoButton: {
    alignItems: 'center',
    padding: 20,
    backgroundColor: lightTheme.colors.primary,
    borderRadius: 12,
    marginHorizontal: 16,
  },
  addPhotoButtonText: {
    fontSize: 16,
    color: 'white',
    fontWeight: '600',
    marginTop: 8,
  },
  fixedFooter: {
    backgroundColor: lightTheme.colors.background,
    borderTopWidth: 1,
    borderTopColor: lightTheme.colors.border,
    paddingHorizontal: 20,
    paddingVertical: 16,
    paddingBottom: 34, // Extra padding for safe area
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  actionButton: {
    flex: 1,
    height: 56,
    borderRadius: 28,
    backgroundColor: lightTheme.colors.primary,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    gap: 8,
  },
  actionButtonText: {
    color: lightTheme.colors.background,
    fontSize: 16,
    fontWeight: '600',
  },
});

export default ImageManagementModal;
