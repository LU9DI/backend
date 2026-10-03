import 'dotenv/config';
import { runAcquisitionBrowserBotTick } from '../lib/acquisitionBrowserBot.js';

async function main() {
  await runAcquisitionBrowserBotTick(true);
}

main()
  .then(() => {
    setTimeout(() => process.exit(0), 50);
  })
  .catch((error) => {
    console.error('[acquisition-browser] isolated worker fatal:', error?.message || error);
    process.exit(1);
  });
