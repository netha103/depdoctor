#!/usr/bin/env node

'use strict';

// Check Node.js version
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('depdoctor requires Node.js 18 or higher');
  process.exit(1);
}

require('../dist/cli/index.js');
