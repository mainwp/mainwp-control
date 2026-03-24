#!/usr/bin/env node

import { drainAndExit } from './_exit.js';
import { execute } from '@oclif/core';

await execute({ development: true, dir: import.meta.url });
await drainAndExit();
