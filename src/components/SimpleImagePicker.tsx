import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { lightTheme } from '../themes';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useAnimatedGestureHandler,
  clamp,
} from 'react-native-reanimated';
import {
  PanGestureHandler,
  PinchGestureHandler,
} from 'react-native-gesture-handler';
import * as ImageManipulator from 'expo-image-manipulator';

interface SimpleImagePickerProps {
  visible: boolean;
  onClose: () => void;
  onImageSelected: (uri: string) => void;
  itemName?: string;
  preSelectedImage?: string | null;
}

// FIXED CROP SIZE - NO MORE ORIENTATION BUGS
const CROP_SIZE = 600; // Fixed size that works well on all devices
const HEADER_HEIGHT = 60;
const SIDE_PADDING = 12;

const SimpleImagePicker: React.FC<SimpleImagePickerProps> = ({
  visible,
  onClose,
  onImageSelected,
  itemName,
  preSelectedImage
}) => {
  const [selectedImageUri, setSelectedImageUri] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [imageLayout, setImageLayout] = useState({ width: CROP_SIZE, height: CROP_SIZE });

  // Shared values for animation - based on working example
  const scale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const lastScale = useSharedValue(1);
  const lastTranslateX = useSharedValue(0);
  const lastTranslateY = useSharedValue(0);

  // Shared values for image dimensions and crop size to avoid crashes
  const imageWidth = useSharedValue(CROP_SIZE);
  const imageHeight = useSharedValue(CROP_SIZE);
  const cropSizeShared = useSharedValue(CROP_SIZE);

  // Handle image layout and calculate proper initial scale
  const handleImageLayout = (event: any) => {
    const { width, height } = event.nativeEvent.layout;
    setImageLayout({ width, height });

    // Update shared values for gesture calculations
    imageWidth.value = width;
    imageHeight.value = height;

    // Calculate initial scale to fill crop window (no black bars)
    const aspectRatio = width / height;
    const cropAspectRatio = 1; // Square crop window

    let initialScale = 1;
    if (aspectRatio > cropAspectRatio) {
      // Landscape image: scale to fill height
      initialScale = CROP_SIZE / height;
    } else {
      // Portrait image: scale to fill width
      initialScale = CROP_SIZE / width;
    }

    // Set initial scale to fill crop window
    scale.value = initialScale;
    lastScale.value = initialScale;
  };

  // Reset transform - from working example
  const resetTransform = () => {
    scale.value = 1;
    translateX.value = 0;
    translateY.value = 0;
    lastScale.value = 1;
    lastTranslateX.value = 0;
    lastTranslateY.value = 0;
  };

  // NO MORE ORIENTATION HANDLING - FIXED SIZE

  // Set pre-selected image when provided
  useEffect(() => {
    if (preSelectedImage) {
      setSelectedImageUri(preSelectedImage);
      resetTransform();
    }
  }, [preSelectedImage]);

  // Handle camera
  const handleTakePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'We need camera permission to take photos.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const uri = result.assets[0].uri;
        setSelectedImageUri(uri);
        resetTransform();
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to take photo. Please try again.');
    }
  };

  // Handle gallery selection
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
        const uri = result.assets[0].uri;
        setSelectedImageUri(uri);
        resetTransform();
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to select image. Please try again.');
    }
  };

  // SIMPLIFIED crop calculation - direct approach
  const cropImage = async () => {
    if (!selectedImageUri) return;

    setIsUploading(true);
    try {
      // Get current transform values
      const currentScale = scale.value;
      const currentTranslateX = translateX.value;
      const currentTranslateY = translateY.value;

      // Get original image dimensions from Image.getSize
      const getOriginalDimensions = (): Promise<{width: number, height: number}> => {
        return new Promise((resolve, reject) => {
          Image.getSize(selectedImageUri, (width, height) => {
            resolve({ width, height });
          }, reject);
        });
      };

      const originalDimensions = await getOriginalDimensions();
      const originalWidth = originalDimensions.width;
      const originalHeight = originalDimensions.height;

      // Calculate how the image is displayed (fitted to crop window)
      const aspectRatio = originalWidth / originalHeight;
      let baseDisplayWidth, baseDisplayHeight;

      if (aspectRatio > 1) {
        // Landscape: fit height to crop window, scale to fill
        baseDisplayHeight = CROP_SIZE;
        baseDisplayWidth = CROP_SIZE * aspectRatio;
      } else {
        // Portrait: fit width to crop window, scale to fill
        baseDisplayWidth = CROP_SIZE;
        baseDisplayHeight = CROP_SIZE / aspectRatio;
      }

      // The actual scale relative to the original image
      const totalScale = currentScale;

      // Calculate crop center and size for square crop window

      // Calculate crop center in original image coordinates
      // translateX/Y are in display coordinates, convert to original coordinates
      const translateXInOriginal = -currentTranslateX * (originalWidth / baseDisplayWidth) / currentScale;
      const translateYInOriginal = -currentTranslateY * (originalHeight / baseDisplayHeight) / currentScale;

      const cropCenterX = (originalWidth / 2) + translateXInOriginal;
      const cropCenterY = (originalHeight / 2) + translateYInOriginal;

      // Calculate crop area directly for square crop window

      // CRITICAL FIX: Crop exactly what the user sees in the crop window
      // The crop window is always square (CROP_SIZE x CROP_SIZE)
      // So we need to crop a square area from the original image that corresponds to this window

      // Calculate the size of the square crop area in original image coordinates
      const cropWindowSize = CROP_SIZE; // The crop window is always square
      const originalCropSize = cropWindowSize / currentScale; // Size in original image coordinates

      // Center the square crop area
      const squareCropX = cropCenterX - (originalCropSize / 2);
      const squareCropY = cropCenterY - (originalCropSize / 2);

      // Ensure the square crop area is within bounds
      const boundedCropX = Math.max(0, Math.min(squareCropX, originalWidth - originalCropSize));
      const boundedCropY = Math.max(0, Math.min(squareCropY, originalHeight - originalCropSize));
      const boundedCropSize = Math.min(originalCropSize, originalWidth - boundedCropX, originalHeight - boundedCropY);

      const croppedImage = await ImageManipulator.manipulateAsync(
        selectedImageUri,
        [
          {
            crop: {
              originX: boundedCropX,
              originY: boundedCropY,
              width: boundedCropSize,
              height: boundedCropSize,
            },
          },
          { resize: { width: 800, height: 800 } },
        ],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      onImageSelected(croppedImage.uri);
      handleClose();
    } catch (error) {
      Alert.alert('Error', 'Failed to process image. Please try again.');
    } finally {
      setIsUploading(false);
    }
  };

  const handleClose = () => {
    setSelectedImageUri(null);
    resetTransform();
    onClose();
  };

  // Pan gesture handler - fixed to avoid crashes
  const panGestureHandler = useAnimatedGestureHandler({
    onStart: () => {
      lastTranslateX.value = translateX.value;
      lastTranslateY.value = translateY.value;
    },
    onActive: (event) => {
      // Apply 1:1 movement by dividing by current scale
      const deltaX = event.translationX / scale.value;
      const deltaY = event.translationY / scale.value;

      // Calculate boundaries inline to avoid crashes
      const currentScale = scale.value;
      const scaledWidth = imageWidth.value * currentScale;
      const scaledHeight = imageHeight.value * currentScale;

      const maxX = Math.max(0, (scaledWidth - cropSizeShared.value) / 2);
      const maxY = Math.max(0, (scaledHeight - cropSizeShared.value) / 2);

      // Clamp translation to boundaries
      translateX.value = clamp(
        lastTranslateX.value + deltaX,
        -maxX,
        maxX
      );
      translateY.value = clamp(
        lastTranslateY.value + deltaY,
        -maxY,
        maxY
      );
    },
    onEnd: () => {
      lastTranslateX.value = translateX.value;
      lastTranslateY.value = translateY.value;
    },
  });

  // Pinch gesture handler - fixed to avoid crashes
  const pinchGestureHandler = useAnimatedGestureHandler({
    onStart: () => {
      lastScale.value = scale.value;
    },
    onActive: (event: any) => {
      // Allow zoom from 1x to 5x
      const newScale = clamp(lastScale.value * event.scale, 1, 5);
      scale.value = newScale;

      // Recalculate boundaries inline
      const scaledWidth = imageWidth.value * newScale;
      const scaledHeight = imageHeight.value * newScale;

      const maxX = Math.max(0, (scaledWidth - cropSizeShared.value) / 2);
      const maxY = Math.max(0, (scaledHeight - cropSizeShared.value) / 2);

      translateX.value = clamp(translateX.value, -maxX, maxX);
      translateY.value = clamp(translateY.value, -maxY, maxY);
    },
    onEnd: () => {
      lastScale.value = scale.value;
    },
  });

  // FIXED styles - no more dynamic sizing
  const cropStyles = {
    cropArea: {
      width: CROP_SIZE,
      height: CROP_SIZE,
      position: 'relative' as const,
      backgroundColor: '#000',
      borderRadius: 8,
      overflow: 'hidden' as const,
    },
    imageContainer: {
      width: CROP_SIZE,
      height: CROP_SIZE,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
    gestureContainer: {
      flex: 1,
      justifyContent: 'center' as const,
      alignItems: 'center' as const,
    },
  };

  const animatedImageStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: translateX.value },
        { translateY: translateY.value },
        { scale: scale.value },
      ],
    };
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} style={styles.headerButton}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>
            {selectedImageUri ? 'Crop Photo' : 'Add Photo'}
          </Text>
          {selectedImageUri && (
            <TouchableOpacity
              onPress={cropImage}
              style={styles.headerButton}
              disabled={isUploading}
            >
              {isUploading ? (
                <ActivityIndicator size="small" color={lightTheme.colors.primary} />
              ) : (
                <Text style={styles.uploadText}>Upload</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Content */}
        <View style={styles.content}>
          {selectedImageUri ? (
            // Crop interface - from working example
            <View style={styles.cropContainer}>
              <View style={cropStyles.cropArea}>
                <PinchGestureHandler
                  onGestureEvent={pinchGestureHandler}
                  onHandlerStateChange={pinchGestureHandler}
                >
                  <Animated.View style={cropStyles.gestureContainer}>
                    <PanGestureHandler
                      onGestureEvent={panGestureHandler}
                      onHandlerStateChange={panGestureHandler}
                      minPointers={1}
                      maxPointers={1}
                    >
                      <Animated.View style={[cropStyles.imageContainer, animatedImageStyle]}>
                        <Image
                          source={{ uri: selectedImageUri }}
                          style={{
                            width: imageLayout.width,
                            height: imageLayout.height,
                          }}
                          onLayout={handleImageLayout}
                          resizeMode="contain"
                        />
                      </Animated.View>
                    </PanGestureHandler>
                  </Animated.View>
                </PinchGestureHandler>

                {/* Crop grid overlay */}
                <View style={styles.cropGrid} pointerEvents="none">
                  {/* Vertical lines */}
                  <View style={[styles.gridLine, styles.verticalLine, { left: '33.33%' }]} />
                  <View style={[styles.gridLine, styles.verticalLine, { left: '66.66%' }]} />
                  {/* Horizontal lines */}
                  <View style={[styles.gridLine, styles.horizontalLine, { top: '33.33%' }]} />
                  <View style={[styles.gridLine, styles.horizontalLine, { top: '66.66%' }]} />
                </View>

                {/* Corner indicators only */}
                <View style={styles.cornerContainer} pointerEvents="none">
                  <View style={[styles.cornerIndicator, styles.topLeft]} />
                  <View style={[styles.cornerIndicator, styles.topRight]} />
                  <View style={[styles.cornerIndicator, styles.bottomLeft]} />
                  <View style={[styles.cornerIndicator, styles.bottomRight]} />
                </View>
              </View>

              {/* Instructions */}
              <View style={styles.instructionsContainer}>
                <Text style={styles.cropInstructions}>
                  Pinch to zoom • Drag to reposition
                </Text>
              </View>
            </View>
          ) : (
            // Selection buttons
            <View style={styles.selectionContainer}>
              <TouchableOpacity style={styles.optionButton} onPress={handleTakePhoto}>
                <Ionicons name="camera" size={48} color={lightTheme.colors.primary} />
                <Text style={styles.optionText}>Take Photo</Text>
              </TouchableOpacity>
              
              <TouchableOpacity style={styles.optionButton} onPress={handleSelectFromGallery}>
                <Ionicons name="images" size={48} color={lightTheme.colors.primary} />
                <Text style={styles.optionText}>Choose from Gallery</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5', // Gray background
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: lightTheme.colors.border,
    backgroundColor: lightTheme.colors.background,
    height: HEADER_HEIGHT,
  },
  headerButton: {
    padding: 8,
    minWidth: 80,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: lightTheme.colors.text,
  },
  cancelText: {
    fontSize: 16,
    color: lightTheme.colors.secondary,
  },
  uploadText: {
    fontSize: 16,
    fontWeight: '600',
    color: lightTheme.colors.primary,
    textAlign: 'right',
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  selectionContainer: {
    alignItems: 'center',
    gap: 40,
  },
  optionButton: {
    alignItems: 'center',
    padding: 32,
    borderRadius: 16,
    backgroundColor: lightTheme.colors.card,
    minWidth: 200,
  },
  optionText: {
    fontSize: 18,
    fontWeight: '600',
    color: lightTheme.colors.text,
    marginTop: 12,
  },
  // Minimal padding crop interface
  cropContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SIDE_PADDING,
    paddingVertical: 8,
  },
  cropGrid: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 5, // Above image but below corners
  },
  gridLine: {
    position: 'absolute',
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
  },
  verticalLine: {
    width: 1,
    height: '100%',
  },
  horizontalLine: {
    height: 1,
    width: '100%',
  },
  cornerContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10, // Above image
  },
  cornerIndicator: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: '#fff',
    borderWidth: 3,
  },
  topLeft: {
    top: -2,
    left: -2,
    borderRightWidth: 0,
    borderBottomWidth: 0,
    borderTopLeftRadius: 8,
  },
  topRight: {
    top: -2,
    right: -2,
    borderLeftWidth: 0,
    borderBottomWidth: 0,
    borderTopRightRadius: 8,
  },
  bottomLeft: {
    bottom: -2,
    left: -2,
    borderRightWidth: 0,
    borderTopWidth: 0,
    borderBottomLeftRadius: 8,
  },
  bottomRight: {
    bottom: -2,
    right: -2,
    borderLeftWidth: 0,
    borderTopWidth: 0,
    borderBottomRightRadius: 8,
  },
  instructionsContainer: {
    marginTop: 20,
    alignItems: 'center',
  },
  cropInstructions: {
    color: lightTheme.colors.text,
    fontSize: 14,
    fontWeight: '500',
    textAlign: 'center',
    opacity: 0.7,
  },
});

export default SimpleImagePicker;
