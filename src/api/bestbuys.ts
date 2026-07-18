// Compatibility wrapper: the old Best Buys endpoint now exposes the backend-owned
// pre-alert Convictions queue. New lifecycle code lives under scoring because the
// worker—not dashboard traffic—owns admission and entry timing.
export {
  assessEntryTiming,
  convictionQueueStatus,
  currentBestBuys,
  currentConvictions,
  dropConvictionCandidate,
  hasIndependentOpportunityConfirmation,
  isConvictionCandidate,
  isSecondWaveRetrace,
  refreshConvictionQueue,
} from '../scoring/conviction-queue';
