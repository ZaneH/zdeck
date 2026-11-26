// Offline packaging only: no dependency install, plugin launch, or user settings changes.
import { packageHomeAssistant } from './package-spotify.mjs';
try {
  if (process.argv.length !== 2) throw new Error('This command takes no output argument.');
  console.log(`Packaged Home Assistant folder: ${await packageHomeAssistant()}`);
  console.log('Copy the complete home-assistant folder into your zDeck plugin folder, then Refresh in desktop Settings. Nothing was installed or enabled.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Home Assistant packaging failed.');
  process.exitCode = 1;
}
