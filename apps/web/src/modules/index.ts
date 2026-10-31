import { MODULE_CONTRACT, type D4Module } from '@d4/web-platform';
// Import order is stylesheet order: each module.tsx imports its stylesheet, and these come in
// the order the screens' styles had in the old single stylesheet.
import { exploreModule } from './explore/module';
import { queriesModule } from './queries/module';
import { planModule } from './plan/module';
import { dataModule } from './data/module';
import { reportingModule } from './reporting/module';

// P6 spike: admin is a lifecycle module (apps/web-admin) loaded through /config.json (../lifecycle.ts).
const ALL: D4Module[] = [exploreModule, queriesModule, planModule, dataModule, reportingModule];

/** The modules the shell mounts; one built for another contract version is left out with an error. */
export const MODULES = ALL.filter((m) => {
  if (m.contract === MODULE_CONTRACT) return true;
  console.error(`D4 module '${m.id}' uses contract ${String(m.contract)}; this app understands ${MODULE_CONTRACT}. It is not loaded.`);
  return false;
});
