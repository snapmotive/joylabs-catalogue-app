declare module 'react-native-progress/Bar' {
  import { Component } from 'react';
  import { ViewStyle } from 'react-native';

  interface ProgressBarProps {
    progress?: number;
    width?: number | null;
    height?: number;
    borderRadius?: number;
    borderWidth?: number;
    color?: string;
    style?: ViewStyle;
  }

  export default class Bar extends Component<ProgressBarProps> {}
} 