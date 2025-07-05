import React from 'react';
import { View, StyleSheet, Button, Alert } from 'react-native';
import CatalogSyncStatus from '../../../src/components/CatalogSyncStatus';
// import SyncLogsView from '../../../src/components/SyncLogsView'; // Removed
import { lightTheme } from '../../../src/themes';
import { fixImageLinking } from '../../../src/utils/testImageSync';

const ProfileSyncScreen: React.FC = () => {
  const handleFixImages = async () => {
    try {
      await fixImageLinking();
      Alert.alert('Success', 'Image linking fixed! Check your items now.');
    } catch (error) {
      Alert.alert('Error', 'Failed to fix image linking');
    }
  };

  return (
    <View style={styles.container}>
      <CatalogSyncStatus />
      <View style={styles.debugSection}>
        <Button
          title="FIX IMAGE LINKING"
          onPress={handleFixImages}
          color="#ff6b6b"
        />
      </View>
      {/* <SyncLogsView /> */}{/* Removed */}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: lightTheme.spacing.md,
    backgroundColor: lightTheme.colors.background,
  },
  debugSection: {
    marginTop: 20,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#ff6b6b',
  },
});

export default ProfileSyncScreen; 