import { startBestBuysEngine } from './api/bestbuys-runner';

startBestBuysEngine();

// index.ts owns the worker lifecycle and starts immediately when imported.
import './index';
