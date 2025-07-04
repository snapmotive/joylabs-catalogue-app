import React from 'react';
import 'react-native-get-random-values';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { Stack, SplashScreen, ErrorBoundary, useRouter } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  Platform,
  View,
  TouchableOpacity,
  Text,
  Dimensions,
  ActivityIndicator,
  Linking,
  useColorScheme,
  LogBox,
  AppState,
} from 'react-native';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import * as ExpoLinking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { ApiProvider } from '../src/providers/ApiProvider';
import logger from '../src/utils/logger';
import { DatabaseProvider } from '../src/components/DatabaseProvider';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import type { NotificationBehavior } from 'expo-notifications';
import { CatalogSyncService } from '../src/database/catalogSync';
import { PaperProvider, MD3DarkTheme, MD3LightTheme } from 'react-native-paper';
import { useAppStore } from '../src/store';
import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import * as SystemUI from 'expo-system-ui';
import { lightTheme } from '../src/themes';
import GlobalSuccessModal from '../src/components/GlobalSuccessModal';
import { Amplify } from 'aws-amplify';
import { ConsoleLogger } from 'aws-amplify/utils';
import { Authenticator } from '@aws-amplify/ui-react-native';
import { CatalogSubscriptionManager } from '../src/components/CatalogSubscriptionManager';
import { useAuthInit } from '../src/hooks/useAuthInit';

// Global type declaration for Amplify configuration guard
declare global {
  var _amplifyConfigured: boolean | undefined;
}

const config = {
  "aws_project_region": "us-west-1",
  "aws_cognito_identity_pool_id": "us-west-1:86879c1c-571a-4a6f-9da3-19a2955b7422",
  "aws_cognito_region": "us-west-1",
  "aws_user_pools_id": "us-west-1_3ErX60pRX",
  "aws_user_pools_web_client_id": "35eqlqiilknf6v5lqrshbhj3bc",
  "oauth": {},
  "aws_cognito_username_attributes": [
    "EMAIL"
  ],
  "aws_cognito_social_providers": [],
  "aws_cognito_signup_attributes": [
    "EMAIL"
  ],
  "aws_cognito_mfa_configuration": "OFF",
  "aws_cognito_mfa_types": [
    "SMS"
  ],
  "aws_cognito_password_protection_settings": {
    "passwordPolicyMinLength": 8,
    "passwordPolicyCharacters": []
  },
  "aws_cognito_verification_mechanisms": [
    "EMAIL"
  ],
  "aws_appsync_graphqlEndpoint": "https://wx4zbczmdveldktohcnfa6vvba.appsync-api.us-west-1.amazonaws.com/graphql",
  "aws_appsync_region": "us-west-1",
  "aws_appsync_authenticationType": "AMAZON_COGNITO_USER_POOLS"
};

// Configure Amplify only once to prevent Hub dispatch spam
if (!global._amplifyConfigured) {
  Amplify.configure(config);
  ConsoleLogger.LOG_LEVEL = 'DEBUG';
  global._amplifyConfigured = true;
}

const BACKGROUND_NOTIFICATION_TASK = 'CATALOG_SYNC_TASK';

TaskManager.defineTask(BACKGROUND_NOTIFICATION_TASK, async ({ data, error, executionInfo }) => {
  const taskTag = '[TaskManager]';
  logger.info(taskTag, 'Background notification task started', { data, executionInfo });
  if (error) {
    logger.error(taskTag, 'Error in background task:', error);
    return;
  }
  const notification = (data as any)?.notification as Notifications.Notification | undefined;
  if (notification) {
    const notificationData = notification.request.content.data;
    
    // Handle both old and new notification types for backward compatibility
    if (notificationData?.type === 'catalog_updated' || notificationData?.type === 'catalog_update') {
      logger.info(taskTag, 'Catalog update notification received. Triggering incremental sync.');
      try {
        const syncService = CatalogSyncService.getInstance();
        await syncService.runIncrementalSync();
        logger.info(taskTag, 'Incremental sync finished successfully (triggered by task).');
      } catch (syncError: any) {
        logger.error(taskTag, 'Error occurred during runIncrementalSync triggered by task:', { error: syncError.message, details: syncError });
      }
    } else {
      logger.warn(taskTag, 'Received notification of unknown type or missing data', { notificationData });
    }
  } else {
    logger.warn(taskTag, 'Task executed without notification data?', { data });
  }
  logger.info(taskTag, 'Background notification task finished');
});

const linking = {
  prefixes: ['joylabs://', 'https://app.joylabs.io'],
  config: {
    screens: {
      '(tabs)': {
        initialRouteName: '(scan)',
        screens: {
          '(scan)': '',
          reorders: 'reorders',
          labels: 'labels',
          '(profile)': 'profile',
        }
      },

      'item/:id': 'item/:id',
      'auth/success': 'auth/success',
      debug: 'debug',
      labelDesigner: 'label-designer',
      labelSettings: 'label-settings',
      catalogue: 'catalogue',
      modules: 'modules',
    },
  },
};

SplashScreen.preventAutoHideAsync();

LogBox.ignoreLogs([
  'Warning: Encountered two children with the same key',
  'Key \" allthedata\" already exists in ' // specific key causing issues
]);

export default function RootLayout() {
  const [debugTapCount, setDebugTapCount] = useState(0);
  const [debugModeActive, setDebugModeActive] = useState(false);
  const [debugTapTimeout, setDebugTapTimeout] = useState<NodeJS.Timeout | null>(null);
  const [responseListenerSubscription, setResponseListenerSubscription] = useState<Notifications.Subscription | null>(null);
  const [appState, setAppState] = useState(AppState.currentState);

  const colorScheme = useColorScheme();

  // Initialize authentication state on app startup
  const { isLoading: authLoading, isAuthenticated, error: authError } = useAuthInit();
  
  // Real-time catalog updates handled by CatalogSubscriptionManager component
  
  const paperTheme = useMemo(() => {
    logger.info('RootLayout', 'Recalculating paperTheme', { colorScheme });
    return colorScheme === 'dark' ? MD3DarkTheme : MD3LightTheme;
  }, [colorScheme]);

  const [loaded, fontError] = useFonts({ ...FontAwesome.font });
  const [isAppReady, setIsAppReady] = useState(false);
  
  useEffect(() => {
    logger.info('RootLayout', 'Color scheme changed', { colorScheme });
  }, [colorScheme]);
    
  useEffect(() => {
    const startTime = Date.now();
    const { width, height } = Dimensions.get('window');
    logger.info('App', 'Application started', {
      version: '1.0.0',
      platform: Platform.OS,
      platformVersion: Platform.Version,
      deviceWidth: width,
      deviceHeight: height,
      deviceInfo: `${Platform.OS} ${Platform.Version}`,
      isDev: false,
      startupTime: startTime
    });
  }, []);
  
  useEffect(() => {
    if (loaded || fontError) {
      SplashScreen.hideAsync();
      setIsAppReady(true);
      logger.info('RootLayout', 'Fonts loaded, app marked as ready.');
    }
  }, [loaded, fontError]);

  const handleDebugTap = () => {
    const newCount = debugTapCount + 1;
    setDebugTapCount(newCount);
    if (newCount >= 7 && !debugModeActive) {
      setDebugModeActive(true);
      logger.info('App', 'Debug mode activated by user');
    }
    setTimeout(() => setDebugTapCount(0), 3000);
  };

  useEffect(() => {
    const subscription = Linking.addEventListener('url', (event) => {
    });
    const getInitialURL = async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) {
          if (initialUrl.includes('auth/success')) {
          }
        }
      } catch (err) {
        console.error('ROOT LAYOUT - Error getting initial URL:', err);
      }
    };
    getInitialURL();
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (fontError) {
      console.error('ROOT LAYOUT - Error loading fonts:', fontError);
      logger.error('App', 'Font loading failed', { error: fontError });
    }
  }, [fontError]);

  // Set up app state change listener with catch-up sync (moved from App.tsx)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextAppState => {
      logger.debug('App', `App state changed from ${appState} to ${nextAppState}`);

      // Only trigger catch-up sync when app comes to foreground if we have reason to believe we missed webhooks
      if (appState === 'background' && nextAppState === 'active') {
        logger.info('App', 'App came to foreground from background - checking if catch-up sync is needed');

        try {
          const syncService = CatalogSyncService.getInstance();
          syncService.checkAndRunCatchUpSync().catch(error => {
            logger.error('App', 'Catch-up sync check failed during foreground transition', { error });
          });

          logger.info('App', 'Intelligent catch-up sync check initiated during foreground transition');
        } catch (syncError) {
          logger.error('App', 'Failed to initiate catch-up sync check during foreground transition', { syncError });
        }
      }

      setAppState(nextAppState);
    });

    return () => {
      subscription.remove();
    };
  }, [appState]);

  // Set up global error handler (moved from App.tsx)
  useEffect(() => {
    const errorHandler = (error: Error, isFatal?: boolean) => {
      logger.error('App', `Global error: ${isFatal ? 'FATAL' : 'NON-FATAL'}`, {
        error: error.toString(),
        stack: error.stack
      });
    };

    const originalConsoleError = console.error;
    console.error = (message, ...args) => {
      if (message instanceof Error) {
        errorHandler(message, false);
      } else if (typeof message === 'string' && args[0] instanceof Error) {
        errorHandler(args[0], false);
      }
      originalConsoleError(message, ...args);
    };

    const rejectionHandler = (event: PromiseRejectionEvent) => {
      logger.error('App', 'Unhandled promise rejection', {
        reason: event.reason?.toString(),
        stack: event.reason?.stack
      });
    };

    if (global.addEventListener) {
      global.addEventListener('unhandledrejection', rejectionHandler);
    }

    return () => {
      console.error = originalConsoleError;
      if (global.removeEventListener) {
        global.removeEventListener('unhandledrejection', rejectionHandler);
      }
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    let responseListenerSubscription: Notifications.Subscription | null = null;
    logger.info('[Notifications]', 'Setting up notification handlers...');
    Notifications.setNotificationHandler({
      handleNotification: async (notification): Promise<NotificationBehavior> => {
        logger.info('[Notifications]', '🔔 PUSH NOTIFICATION RECEIVED!', {
          title: notification.request.content.title,
          body: notification.request.content.body,
          data: notification.request.content.data,
          timestamp: new Date().toISOString(),
          fullNotification: JSON.stringify(notification, null, 2)
        });

        // Check if this is a catalog update notification
        const notificationData = notification.request.content.data;
        const isCatalogUpdate = notificationData?.type === 'catalog_updated' ||
                               notificationData?.eventType?.startsWith('catalog.');

        logger.info('[Notifications]', 'Notification data analysis', {
          hasData: !!notificationData,
          dataType: notificationData?.type,
          eventType: notificationData?.eventType,
          isCatalogUpdate,
          allDataKeys: notificationData ? Object.keys(notificationData) : []
        });

        if (isCatalogUpdate) {
          logger.info('[Notifications]', '✅ Catalog update push notification detected - triggering webhook sync');

          // Add a visible notification that sync is being triggered
          import('../src/services/notificationService').then(({ default: NotificationService }) => {
            NotificationService.addNotification({
              type: 'webhook_catalog_update',
              title: '📱 Push Notification Received!',
              message: `Received push notification from Square - triggering sync for catalog update`,
              priority: 'high',
              source: 'push'
            });
          });

          // Trigger webhook sync in background
          try {
            const syncService = CatalogSyncService.getInstance();
            syncService.runIncrementalSync().catch(error => {
              logger.error('[Notifications]', 'Failed to trigger sync from push notification', { error });
            });
          } catch (error) {
            logger.error('[Notifications]', 'Error setting up sync from push notification', { error });
          }

          // Show the notification for catalog updates
          return {
            shouldShowAlert: true,
            shouldPlaySound: true,
            shouldSetBadge: true,
          } as NotificationBehavior;
        } else {
          logger.warn('[Notifications]', '⚠️ Non-catalog notification received - not triggering sync', {
            dataType: notificationData?.type,
            eventType: notificationData?.eventType
          });
        }

        // For non-catalog notifications, show them normally
        return {
          shouldShowAlert: true,
          shouldPlaySound: false,
          shouldSetBadge: true,
        } as NotificationBehavior;
      },
      handleSuccess: (notificationId) => {
        if (!isMounted) return;
        logger.info('[Notifications]', 'Notification handled successfully (foreground/running)', { notificationId });
      },
      handleError: (notificationId, err) => {
        if (!isMounted) return;
        logger.error('[Notifications]', 'Error handling notification (foreground/running)', { notificationId, error: err });
      },
    });
    responseListenerSubscription = Notifications.addNotificationResponseReceivedListener(response => {
      if (!isMounted) return;
      logger.info('[Notifications]', 'Notification response received (user tapped notification)', {
        title: response.notification.request.content.title,
        data: response.notification.request.content.data
      });

      // Handle URL navigation if provided
      const url = response.notification.request.content.data?.url as string | undefined;
      if (url) {
        logger.info('[Notifications]', `Attempting to navigate to URL from notification: ${url}`);
        router.push(url);
      }

      // Handle catalog update notifications when user taps them
      const notificationData = response.notification.request.content.data;
      const isCatalogUpdate = notificationData?.type === 'catalog_updated' ||
                             notificationData?.eventType?.startsWith('catalog.');

      if (isCatalogUpdate) {
        logger.info('[Notifications]', 'User tapped catalog update notification - triggering sync');
        try {
          const syncService = CatalogSyncService.getInstance();
          syncService.runIncrementalSync().catch(error => {
            logger.error('[Notifications]', 'Failed to trigger sync from tapped notification', { error });
          });
        } catch (error) {
          logger.error('[Notifications]', 'Error setting up sync from tapped notification', { error });
        }
      }
    });
    logger.info('[Notifications]', 'Notification handlers set.');
    return () => {
      isMounted = false;
      if (responseListenerSubscription) {
        logger.info('[Notifications]', 'Removing notification response listener.');
        Notifications.removeNotificationSubscription(responseListenerSubscription);
      }
    };
  }, []);

  useEffect(() => {
    if (loaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [loaded, fontError]);

  useEffect(() => {
    // Set the background color for the navigation bar or other system UI elements
    SystemUI.setBackgroundColorAsync(lightTheme.colors.background).catch((err: any) => {
      console.warn('Failed to set system UI background color:', err);
    });
  }, []);

  const router = useRouter();

  // Create a triple tap gesture to activate debug mode (moved from App.tsx)
  const tripleTap = Gesture.Tap()
    .numberOfTaps(3)
    .onStart(() => {
      logger.info('App', 'Triple tap activated - opening debug screen');
      router.push('/debug');
    });

  // Notification response handling is now consolidated in the main notification setup above

  if (!isAppReady || authLoading) {
    return <ActivityIndicator size="large" style={{ flex: 1, justifyContent: 'center' }} />;
  }

  return (
      <GestureHandlerRootView style={{ flex: 1 }}>
    <GestureDetector gesture={tripleTap}>
      <View collapsable={false} style={{ flex: 1 }}>
      <ActionSheetProvider>
        <Authenticator.Provider>
          <ApiProvider>
                  <DatabaseProvider>
              <PaperProvider theme={paperTheme}>
                <MenuProvider>
                  <StatusBar style="auto" />
                  <Stack>
                    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                    <Stack.Screen
                      name="item/[id]"
                      options={({ route }) => ({
                        presentation: 'modal',
                        headerShown: true,
                        headerTitle: (route.params as any)?.id === 'new' ? 'New Item' : 'Edit Item',
                          gestureEnabled: true,
                      })}
                    />
                    <Stack.Screen name="debug" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Debug & Developer Info'
                    }} />
                    <Stack.Screen name="labelDesigner" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Label Designer'
                    }} />
                    <Stack.Screen name="labelSettings" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Label Settings'
                    }} />
                    <Stack.Screen name="catalogue" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Product Catalog'
                    }} />
                    <Stack.Screen name="modules" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Modules'
                    }} />
                    <Stack.Screen name="login" options={{
                      presentation: 'modal',
                      headerShown: true,
                      headerTitle: 'Sign In'
                    }} />

                      </Stack>
                  <GlobalSuccessModal />
                </MenuProvider>
              </PaperProvider>
            </DatabaseProvider>
          </ApiProvider>

          {/* Background AppSync listener for catch-up signals when returning from offline */}
          <CatalogSubscriptionManager />
        </Authenticator.Provider>
      </ActionSheetProvider>
      </View>
    </GestureDetector>
      </GestureHandlerRootView>
  );
}

export { ErrorBoundary };

export const unstable_settings = {
  initialRouteName: '(tabs)',
}; 