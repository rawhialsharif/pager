// Restaurants ("branches") and their settings, read from a JSON file.
//
// Also a checker you can run before restarting the server:
//   node src/branches.js /etc/pager/branches.json
// It prints the restaurants, or what's wrong and exits with code 1.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEMO_PIN = '1234';

export function loadBranches(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`${file} doesn't exist`);
    throw new Error(`${file} isn't valid JSON: ${err.message}. Check for a missing comma or quote, or an extra comma before a closing }.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${file} must contain one { ... } with a section per restaurant`);
  }
  const branches = new Map();
  for (const [slug, b] of Object.entries(raw)) {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) {
      throw new Error(`Restaurant id "${slug}" can only use lowercase letters, digits and dashes (it becomes the web address /r/${slug})`);
    }
    if (!b || typeof b !== 'object') throw new Error(`Restaurant "${slug}" must be a { ... } section`);
    if (typeof b.name !== 'string' || !b.name.trim()) throw new Error(`Restaurant "${slug}" needs a "name"`);
    if (typeof b.staffPin !== 'string' || b.staffPin.length < 4) {
      throw new Error(`Restaurant "${slug}" needs a "staffPin" in quotes, at least 4 characters (for example "482917")`);
    }
    const prep = Number(b.defaultPrepMinutes ?? 12);
    if (!(prep >= 1 && prep <= 180)) throw new Error(`Restaurant "${slug}": "defaultPrepMinutes" must be a number from 1 to 180`);
    branches.set(slug, {
      slug,
      name: b.name.trim(),
      staffPin: b.staffPin,
      defaultPrepMinutes: prep,
      pickupNote: typeof b.pickupNote === 'string' && b.pickupNote.trim() ? b.pickupNote.trim() : 'Pick it up at the counter.',
    });
  }
  if (!branches.size) throw new Error(`${file} has no restaurants. Add at least one.`);
  return branches;
}

// ---------- Checker (when run directly) ----------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node src/branches.js <path to branches.json>');
    process.exit(2);
  }
  try {
    const branches = loadBranches(file);
    for (const b of branches.values()) {
      const warning = b.staffPin === DEMO_PIN ? '   (still the demo PIN 1234: change it)' : b.staffPin.length < 6 ? '   (short PIN: 6+ digits is safer)' : '';
      console.log(`${b.slug}\t${b.name}${warning}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
