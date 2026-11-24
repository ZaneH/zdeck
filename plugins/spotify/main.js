import { serve } from '@zdeck/plugin-sdk';
import { createSpotify } from './spotify.js';

try {
  await serve(createSpotify());
} catch {
  console.error('Spotify plugin transport failed. Check the local host connection.');
  process.exitCode = 1;
}
