// Runtime path resolver for compiled TypeScript
const Module = require('module');
const path = require('path');

const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function (request, parent, isMain, options) {
  // Handle @/* path aliases
  if (request.startsWith('@/')) {
    const aliasPath = request.replace('@/', './');
    const fullPath = path.resolve(__dirname, 'dist', aliasPath);

    // Try with .js extension
    try {
      return originalResolveFilename.call(this, fullPath + '.js', parent, isMain, options);
    } catch (e) {
      // Try without extension (for directories with index.js)
      try {
        return originalResolveFilename.call(this, fullPath, parent, isMain, options);
      } catch (e2) {
        // Try with /index.js
        try {
          return originalResolveFilename.call(this, fullPath + '/index.js', parent, isMain, options);
        } catch (e3) {
          // Fall back to original resolution
        }
      }
    }
  }

  return originalResolveFilename.call(this, request, parent, isMain, options);
};

// Start the actual server
require('./dist/server.js');