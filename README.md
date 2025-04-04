# JoyLabs Catalogue App

A modular React Native application built with Expo SDK 52 and TypeScript, focused on catalogue management with barcode scanning capabilities.

## Features

- Modern React Native application using Expo SDK 52
- File-based routing with Expo Router
- TypeScript for type safety
- Modular architecture for scalability
- Reusable UI components
- Bottom tab navigation
- Item details page with edit functionality

### Modules

- **Catalogue Management**: Manage your product catalogue with features for scanning, searching, and organizing inventory
- **Profile**: User profile and preferences

## Recent Improvements

- Changed item details from a modal to a regular page for better stability
- Fixed navigation with consistently visible tab bar
- Improved dropdown menu interaction
- Enhanced tax and modifier UI
- Fixed keyboard behavior to overlay buttons instead of pushing them
- Added save functionality via the bottom tab bar
- Improved scrolling for form fields

## Project Structure

```
joylabs/
├── app/                  # Expo Router pages
│   ├── _layout.tsx       # Root layout
│   ├── index.tsx         # Home screen (Catalogue)
│   ├── profile.tsx       # Profile screen
│   └── item/
│       └── [id].tsx      # Item details screen
├── src/                  # Source code
│   ├── components/       # Reusable UI components
│   │   ├── BottomTabBar.tsx      # Bottom navigation
│   │   ├── CatalogueItemCard.tsx # Catalogue item card
│   │   ├── ConnectionStatusBar.tsx # Connection status UI
│   │   ├── SearchBar.tsx         # Search UI
│   │   └── SortHeader.tsx        # Sorting options UI
│   ├── hooks/            # Custom React hooks
│   ├── themes/           # Theme definitions
│   ├── types/            # TypeScript type definitions
│   └── utils/            # Utility functions
├── assets/               # Static assets
├── docs/                 # Documentation
│   ├── ARCHITECTURE.md   # Detailed architecture documentation
│   └── API.md            # API documentation
```

## Architecture Overview

JoyLabs uses a modern client-server architecture with three main components:

1. **React Native Frontend** (this repository): Built with Expo and TypeScript, providing a mobile interface for Square merchants
2. **AWS Lambda Backend**: Serverless functions that handle authentication and proxy requests to Square
3. **Square API**: External service providing merchant data, catalog, and inventory information

Key architectural features:

- **OAuth 2.0 Authentication**: Secure Square integration using PKCE flow
- **API Client**: Centralized API handling with caching and error management
- **Custom Hooks**: Domain-specific hooks for categories, items, and API state
- **Context Providers**: React Context for shared state management
- **File-based Routing**: Using Expo Router for declarative navigation

For detailed architecture documentation, see [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [API.md](docs/API.md) in the docs directory.

## Installation

1. Clone the repository
2. Install dependencies:

```bash
npm install
```

## Running the App

```bash
# Start the development server
npm start

# Run on iOS
npm run ios

# Run on Android
npm run android

# Run on Web
npm run web
```

## Catalogue Features

The Catalogue Management module includes:

- Connection status indicator
- Item search functionality
- Scan history with sorting options
- Detailed item information display with form editing
- Bottom tab navigation
- Support for tax and CRV (Container Recycling Value) indicators

## Item Details Features

The Item Details screen includes:

- Editable fields for GTIN, SKU, name, price, and description
- Category selection via dropdown
- Tax location toggles
- CRV modifier options
- Image upload capability (placeholder)
- Cancel and Print buttons
- Save functionality via the green check button

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.