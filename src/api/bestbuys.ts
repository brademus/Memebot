// Compatibility wrapper for the public `/api/bestbuys` route. The endpoint now
// returns a read-only projection; only the worker may mutate the conviction queue.
export { currentBestBuys, currentConvictions } from './convictions';
export {
  assessEntryTiming,
  convictionQueueStatus,
  dropConvictionCandidate,
  hasIndependentOpportunityConfirmation,
  isConvictionCandidate,
  isSecondWaveRetrace,
  refreshConvictionQueue,
} from '../scoring/conviction-queue';
