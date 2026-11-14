#!/usr/bin/env node
const path = require('path');

// Load settings from the package's .env file (if there is one) BEFORE the
// server modules are required — they read process.env when first loaded.
// Variables already set in the real environment win over the file.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

require('../src/server').start();
