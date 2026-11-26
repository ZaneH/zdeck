import { PluginError, serve } from '@zdeck/plugin-sdk';
import { createHomeAssistant } from './home-assistant.js';

try {
  await serve(createHomeAssistant({ PluginError }));
} catch {
  console.error('Home Assistant plugin transport failed. Check the local host connection.');
  process.exitCode = 1;
}
